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
