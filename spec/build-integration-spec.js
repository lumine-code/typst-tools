const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { Emitter } = require("lumine");

describe("Typst compilation through Tasks", () => {
  let main, service, directory, source, imported, editor, children, spawn, leases, diagnosticsHub;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    children = [];
    leases = [];
    const nativeSpawn = childProcess.spawn;
    spawn = spyOn(childProcess, "spawn").and.callFake((command, ...args) => {
      if (command !== "owned-typst") return nativeSpawn.call(childProcess, command, ...args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jasmine.createSpy("stop compiler").and.callFake(() => {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      });
      children.push(child);
      return child;
    });
    spyOn(childProcess, "execFileSync").and.throwError("Uncontrolled executable lookup");
    const linter = (await lumine.packages.activatePackage("linter")).mainModule;
    leases.push(
      linter.consumeLinterUI({
        name: "Typst Tasks integration",
        attach(value) {
          diagnosticsHub = value;
        },
      }),
    );
    const build = await lumine.packages.activatePackage("tasks");
    service = build.mainModule.provideTasks();
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    expect(main.build).toBe(service);
    spyOn(main, "resolveTypstPath").and.returnValue({ exePath: "owned-typst", extraArgs: [] });
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "typst-build-")));
    source = path.join(directory, "main.typ");
    imported = path.join(directory, "imported.typ");
    for (const file of [source, imported]) fs.writeFileSync(file, "First\nSecond\nLocated error\n");
    editor = await lumine.workspace.open(source);
  });

  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("typst-tools");
    await lumine.packages.deactivatePackage("tasks");
    editor?.destroy();
    for (const child of children) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    for (const key of ["fontPaths", "outputFormat", "additionalArgs"])
      lumine.config.unset(`typst-tools.${key}`);
    if (!directory) return;
    const resolved = fs.realpathSync.native(directory);
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe Typst build fixture cleanup");
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  async function started(filePath = source) {
    const job = main.runCompilation(filePath);
    expect(job).toBeTruthy();
    await conditionPromise(() => job.state === "running", "Typst compiler process");
    return job;
  }

  async function finish(job, stderr = "", code = 0) {
    const child = children[service.getJobs({ providerId: "typst-tools" }).indexOf(job)];
    if (stderr) child.stderr.write(stderr);
    child.emit("close", code, null);
    await job.completion;
    return job;
  }

  function sourceObservationHints() {
    const changes = [];
    const invalidations = [];
    const nativeWatch = lumine.fileWatchClient.watchFile.bind(lumine.fileWatchClient);
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath) => {
      const handle = nativeWatch(filePath);
      if (filePath !== source) return handle;
      return {
        ready: handle.ready,
        closed: handle.closed,
        dispose: () => handle.dispose(),
        onDidChange(callback) {
          changes.push(callback);
          return handle.onDidChange(callback);
        },
        onDidInvalidate(callback) {
          invalidations.push(callback);
          return handle.onDidInvalidate(callback);
        },
        onDidError: (callback) => handle.onDidError(callback),
      };
    });
    return () => {
      for (const callback of changes) callback([{ action: "updated", path: source }]);
      for (const callback of invalidations)
        callback({ path: source, reason: "recovery", generation: 2 });
    };
  }

  async function observeSource(observationMode) {
    editor.destroy();
    expect(main.setCompileOnSaveForFile(source, true)).toBeTrue();
    if (observationMode) {
      expect(
        service.setObserved({ providerId: "typst-tools", filePath: source, observationMode }, true),
      ).toBeTrue();
    }
    const manager = (await lumine.packages.activatePackage("tasks")).mainModule.manager;
    const entry = [...manager.observed.values()].find(
      (candidate) => candidate.providerId === "typst-tools" && candidate.filePath === source,
    );
    expect(await entry.observation.ready).toBeTrue();
    return entry.observation;
  }

  it("builds a standalone source with compiler settings and declared output", async () => {
    lumine.config.set("typst-tools.fontPaths", [path.join(directory, "Fonts")]);
    lumine.config.set("typst-tools.outputFormat", "svg");
    lumine.config.set("typst-tools.additionalArgs", ["--root", directory]);
    main.resolveTypstPath.and.returnValue({ exePath: "owned-typst", extraArgs: ["--owned"] });
    const job = await started();
    const compilerCall = spawn.calls
      .all()
      .filter((call) => call.args[0] === "owned-typst")
      .at(-1);
    expect(compilerCall.args.slice(0, 2)).toEqual([
      "owned-typst",
      [
        "--owned",
        "compile",
        "--font-path",
        path.join(directory, "Fonts"),
        "--format",
        "svg",
        "--root",
        directory,
        "main.typ",
      ],
    ]);
    expect(compilerCall.args[2].cwd).toBe(directory);
    expect(job.artifacts).toEqual([
      { path: source.replace(/\.typ$/, ".svg"), kind: "svg", sourcePath: source },
    ]);
    expect(main.isBuilding(source)).toBeTrue();
    await finish(job);
    expect(job.state).toBe("passed");
    expect(main.isBuilding(source)).toBeFalse();
  });

  for (const [code, state] of [
    [0, "passed"],
    [1, "failed"],
  ]) {
    it(`keeps ${state} command compilation in the background`, async () => {
      const build = (await lumine.packages.activatePackage("tasks")).mainModule;
      const ensurePanel = spyOn(build, "ensurePanel").and.callThrough();
      expect(build.panel).toBeNull();
      expect(build.isTasksPanelVisible()).toBeFalse();
      expect(lumine.commands.canDispatch(editor.getElement(), "typst-tools:compile")).toBeTrue();

      await lumine.commands.dispatch(editor.getElement(), "typst-tools:compile");
      const job = service.getJob({ providerId: "typst-tools", filePath: source });
      expect(job).toBeTruthy();
      await conditionPromise(() => job.state === "running", "background Typst compilation");
      expect(ensurePanel).not.toHaveBeenCalled();
      children[0].stdout.write("command compilation output\n");
      await finish(job, code ? "error: unknown variable\n  ┌─ main.typ:3:5\n  │ ^^^\n" : "", code);

      expect(job.state).toBe(state);
      expect(job.stdout).toBe("command compilation output\n");
      expect(service.getJobs({ providerId: "typst-tools" })).toContain(job);
      expect(ensurePanel).not.toHaveBeenCalled();
      expect(build.panel).toBeNull();
      expect(build.isTasksPanelVisible()).toBeFalse();
      expect(build.statusNewIndicator.hidden).toBeFalse();
      expect(build.statusElement.dataset.new).toBe("1");
      expect(build.statusElement.dataset.state).toBe(state);
    });
  }

  it("saves a modified document when compilation is requested directly through Tasks", async () => {
    editor.setText("Current Typst source\n");
    const job = service.run({ providerId: "typst-tools", filePath: source, reason: "manual" });
    await conditionPromise(() => job.state === "running", "saved Typst compiler request");
    expect(fs.readFileSync(source, "utf8")).toBe("Current Typst source\n");
    expect(editor.getFileState()).toBe("unmodified");
    await finish(job);
    expect(job.state).toBe("passed");
  });

  it("opens the successful execution's actual PDF independently of the active document and format", async () => {
    const output = path.join(directory, "rendered output", "wynik ą.pdf");
    fs.mkdirSync(path.dirname(output));
    fs.writeFileSync(output, "%PDF-1.7\nCompiled document\n");
    const nativePrepare = main.prepareBuild.bind(main);
    spyOn(main, "prepareBuild").and.callFake((filePath) => ({
      ...nativePrepare(filePath),
      artifacts: [{ path: output, kind: "pdf", sourcePath: filePath }],
    }));
    const job = await started();
    await finish(job);
    expect(service.getActions(job)).toEqual([
      {
        id: "open-pdf",
        label: "Open PDF",
        description: "Open this execution's compiled PDF.",
      },
    ]);
    await lumine.workspace.open(imported);
    lumine.config.set("typst-tools.outputFormat", "svg");
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});
    const associate = spyOn(service, "associateArtifact").and.callThrough();
    expect(await service.runAction(job, "open-pdf")).toBeTrue();
    expect(open).toHaveBeenCalledTimes(1);
    const [openedPath, options] = open.calls.mostRecent().args;
    expect(openedPath).toBe(output);
    expect(options.searchAllPanes).toBeTrue();
    expect(options.signal.aborted).toBeFalse();
    expect(typeof options.signal.addEventListener).toBe("function");
    expect(associate).toHaveBeenCalledOnceWith(
      { providerId: "typst-tools", filePath: source },
      output,
    );
  });

  it("offers Open PDF after a no-op build and keeps action metadata queries free of filesystem I/O", async () => {
    fs.writeFileSync(source.replace(/\.typ$/, ".pdf"), "%PDF-1.7\nExisting output\n");
    const job = await started();
    await finish(job);
    const stat = spyOn(fs.promises, "stat").and.throwError("Metadata queries must not read files");
    const exists = spyOn(fs, "existsSync").and.throwError("Metadata queries must not read files");
    expect(service.getActions(job).map((action) => action.id)).toEqual(["open-pdf"]);
    expect(service.getActions(job)[0].run).toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    stat.and.callThrough();
    exists.and.callThrough();
  });

  for (const unavailable of ["missing", "empty", "directory"])
    it(`omits Open PDF when the declared output is ${unavailable}`, async () => {
      const output = source.replace(/\.typ$/, ".pdf");
      if (unavailable === "empty") fs.writeFileSync(output, "");
      if (unavailable === "directory") fs.mkdirSync(output);
      const job = await started();
      await finish(job);
      expect(job.state).toBe("passed");
      expect(service.getActions(job)).toEqual([]);
    });

  it("does not offer an old PDF for failed, cancelled or non-PDF executions", async () => {
    fs.writeFileSync(source.replace(/\.typ$/, ".pdf"), "%PDF-1.7\nOld output\n");
    const failed = await started();
    await finish(failed, "", 1);
    expect(service.getActions(failed)).toEqual([]);
    const cancelled = await started();
    cancelled.stop();
    await cancelled.completion;
    expect(cancelled.state).toBe("cancelled");
    expect(service.getActions(cancelled)).toEqual([]);
    lumine.config.set("typst-tools.outputFormat", "svg");
    fs.writeFileSync(source.replace(/\.typ$/, ".svg"), "<svg/>\n");
    const svg = await started();
    await finish(svg);
    expect(svg.state).toBe("passed");
    expect(service.getActions(svg)).toEqual([]);
  });

  it("reports a PDF removed after compilation through the shared action error channel", async () => {
    const output = source.replace(/\.typ$/, ".pdf");
    fs.writeFileSync(output, "%PDF-1.7\nCompiled output\n");
    const job = await started();
    await finish(job);
    fs.unlinkSync(output);
    const error = spyOn(lumine.notifications, "addError");
    const open = spyOn(lumine.workspace, "open");
    expect(await service.runAction(job, "open-pdf")).toBeFalse();
    expect(open).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnceWith("Unable to run task action: Open PDF", {
      detail: `Compiled PDF is unavailable: ${output}`,
    });
  });

  it("keeps output-opening errors on the shared action error channel without duplicate notifications", async () => {
    fs.writeFileSync(source.replace(/\.typ$/, ".pdf"), "%PDF-1.7\nCompiled output\n");
    const job = await started();
    await finish(job);
    spyOn(lumine.workspace, "open").and.rejectWith(new Error("Cannot open this PDF"));
    const error = spyOn(lumine.notifications, "addError");
    expect(await service.runAction(job, "open-pdf")).toBeFalse();
    expect(error).toHaveBeenCalledOnceWith("Unable to run task action: Open PDF", {
      detail: "Cannot open this PDF",
    });
  });

  for (const retirement of ["removed log", "provider", "backend"])
    it(`does not open a PDF when its ${retirement} retires during the action's file check`, async () => {
      const output = source.replace(/\.typ$/, ".pdf");
      fs.writeFileSync(output, "%PDF-1.7\nCompiled output\n");
      const job = await started();
      await finish(job);
      const nativeStat = fs.promises.stat;
      let release;
      spyOn(fs.promises, "stat").and.callFake((filePath, ...args) =>
        filePath === output
          ? new Promise((resolve) => {
              release = resolve;
            })
          : nativeStat.call(fs.promises, filePath, ...args),
      );
      const open = spyOn(lumine.workspace, "open");
      const error = spyOn(lumine.notifications, "addError");
      const operation = service.runAction(job, "open-pdf");
      await conditionPromise(() => Boolean(release), "the PDF action's file check");
      if (retirement === "removed log") service.removeLog(job.id);
      else
        await lumine.packages.deactivatePackage(
          retirement === "provider" ? "typst-tools" : "tasks",
        );
      release({ isFile: () => true, size: 32 });
      expect(await operation).toBeFalse();
      await Promise.resolve();
      expect(open).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

  it("cancels a pending PDF open when its execution log is removed", async () => {
    fs.writeFileSync(source.replace(/\.typ$/, ".pdf"), "%PDF-1.7\nCompiled output\n");
    const job = await started();
    await finish(job);
    let release, signal;
    spyOn(lumine.workspace, "open").and.callFake((_filePath, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const operation = service.runAction(job, "open-pdf");
    await conditionPromise(() => Boolean(release), "the pending PDF open");
    expect(signal.aborted).toBeFalse();
    service.removeLog(job.id);
    expect(signal.aborted).toBeTrue();
    release({});
    expect(await operation).toBeFalse();
  });

  for (const splitCharacter of ["┌", "é"])
    it(`preserves structured diagnostics when UTF-8 ${splitCharacter} spans chunks`, async () => {
      const job = await started();
      const bytes = Buffer.from("error: café missing\n  ┌─ imported.typ:3:5\n  │ ^^^\n");
      const split = bytes.indexOf(Buffer.from(splitCharacter)) + 1;
      children[0].stderr.write(bytes.subarray(0, split));
      children[0].stderr.write(bytes.subarray(split));
      await finish(job, "", 1);
      expect(job.diagnostics).toEqual([
        {
          severity: "error",
          excerpt: "café missing",
          location: {
            file: imported,
            position: [
              [2, 4],
              [2, 7],
            ],
          },
        },
      ]);
      expect(main.getMessages(source).map((message) => message.excerpt)).toEqual(["café missing"]);
      await conditionPromise(
        () => diagnosticsHub.getMessages().some((message) => message.excerpt === "café missing"),
        "Typst diagnostics from Tasks in the linter",
      );
    });

  it("keeps warnings on success and replaces them with a clean result", async () => {
    const first = await started();
    await finish(first, "warning: unknown font\n");
    expect(first.state).toBe("passed");
    expect(first.diagnostics[0].location.file).toBe(source);
    expect(first.diagnostics[0].location.position).toEqual([
      [0, 0],
      [0, Number.MAX_SAFE_INTEGER],
    ]);
    const clean = await started();
    await finish(clean);
    expect(main.getMessages(source)).toEqual([]);
  });

  it("turns a failed compilation without a diagnostic into a source diagnostic", async () => {
    const job = await started();
    await finish(job, "", 7);
    expect(job.state).toBe("failed");
    expect(job.diagnostics[0].excerpt).toBe("Compilation failed (exit code 7)");
    expect(job.diagnostics[0].location.file).toBe(source);
  });

  it("builds independent documents concurrently and scopes cancellation to Typst", async () => {
    const first = await started();
    const second = await started(imported);
    expect(main.getJobs(true).length).toBe(2);
    expect(main.interruptFile(source)).toBeTrue();
    await first.completion;
    expect(first.state).toBe("cancelled");
    expect(second.state).toBe("running");
    await finish(second);
  });

  it("keeps a shared service registration until its last consumer edge leaves", async () => {
    const first = main.consumeTasks(service);
    const second = main.consumeTasks(service);
    leases.push(first, second);
    first.dispose();
    const job = await started();
    second.dispose();
    expect(main.build).toBe(service);
    await finish(job);
  });

  it("retires jobs and observations when the provider package deactivates", async () => {
    expect(main.setCompileOnSaveForFile(source, true)).toBeTrue();
    const job = await started();
    await lumine.packages.deactivatePackage("typst-tools");
    await job.completion;
    expect(job.state).toBe("cancelled");
    expect(service.getObserved({ providerId: "typst-tools" })).toEqual([]);
    expect(service.run({ providerId: "typst-tools", filePath: source })).toBeNull();
  });

  it("derives observation from Tasks and retires it with the service", async () => {
    expect(main.setCompileOnSaveForFile(source, true)).toBeTrue();
    expect(main.getCompileOnSaveFiles()).toEqual([source]);
    const job = await started();
    expect(main.isBuilding(source)).toBeTrue();
    await lumine.packages.deactivatePackage("tasks");
    await job.completion;
    expect(main.build).toBeNull();
    expect(main.getCompileOnSaveFiles()).toEqual([]);
    expect(lumine.commands.canDispatch(editor.getElement(), "typst-tools:compile")).toBeFalse();
    expect(lumine.commands.canDispatch(editor.getElement(), "typst-tools:watch")).toBeFalse();
  });

  it("builds one external source edit without repeating for output writes or duplicate observation hints", async () => {
    const hint = sourceObservationHints();
    await observeSource();
    fs.writeFileSync(source, "Externally edited Typst source\n");
    await conditionPromise(() => children.length === 1, "the observed Typst compilation", 3000);
    const job = service.getJob({ providerId: "typst-tools", filePath: source });
    expect(job.reason).toBe("save");
    expect(job.state).toBe("running");
    for (const extension of ["pdf", "png", "svg"])
      fs.writeFileSync(source.replace(/\.typ$/, `.${extension}`), `Generated ${extension}\n`);
    hint();
    await timeoutPromise(400);
    expect(children.length).toBe(1);
    await finish(job);
    expect(job.state).toBe("passed");
    for (const extension of ["pdf", "png", "svg"])
      fs.appendFileSync(source.replace(/\.typ$/, `.${extension}`), "Later output update\n");
    hint();
    await timeoutPromise(500);
    expect(children.length).toBe(1);
    expect(service.getJobs({ providerId: "typst-tools" })).toEqual([job]);
  });

  it("keeps content-mode observation idle for generated outputs and identical source rewrites", async () => {
    const hint = sourceObservationHints();
    const observation = await observeSource("content");
    for (const extension of ["pdf", "png", "svg"])
      fs.writeFileSync(source.replace(/\.typ$/, `.${extension}`), `Generated ${extension}\n`);
    fs.writeFileSync(source, fs.readFileSync(source));
    hint();
    expect(await observation.hasChanges()).toBeFalse();
    expect(children.length).toBe(0);
    expect(service.getJobs({ providerId: "typst-tools" })).toEqual([]);
    expect(main.isCompileOnSaveEnabledForFile(source)).toBeTrue();
  });

  it("compiles after saving identical source contents in the default observation mode", async () => {
    const previousWrite = new Date(Date.now() - 10_000);
    fs.utimesSync(source, previousWrite, previousWrite);
    const contents = fs.readFileSync(source);
    const hint = sourceObservationHints();
    await observeSource();
    fs.writeFileSync(source, contents);
    hint();
    await conditionPromise(() => children.length === 1, "the identical Typst source save", 3000);
    const job = service.getJob({ providerId: "typst-tools", filePath: source });
    expect(job.reason).toBe("save");
    await finish(job);
    expect(job.state).toBe("passed");
  });

  it("leaves automatic None-grammar policy to Tasks while observation remains enabled", async () => {
    const changes = new Emitter();
    leases.push(changes);
    spyOn(lumine.fileWatchClient, "watchFile").and.returnValue({
      ready: Promise.resolve(),
      closed: Promise.resolve(),
      onDidChange: (callback) => changes.on("change", callback),
      onDidInvalidate: (callback) => changes.on("change", callback),
      onDidError: (callback) => changes.on("error", callback),
      dispose() {},
    });
    expect(main.setCompileOnSaveForFile(source, true)).toBeTrue();
    editor.setGrammar(lumine.grammars.nullGrammar);
    changes.emit("change");
    await timeoutPromise(200);
    expect(spawn).not.toHaveBeenCalled();
    expect(main.isCompileOnSaveEnabledForFile(source)).toBeTrue();
  });
});
