const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

describe("Typst's PDF build provider", () => {
  let main, buildMain, backend, provider, directory, source, output, children, leases;

  beforeEach(async () => {
    jasmine.useRealClock();
    children = [];
    leases = [];
    const nativeSpawn = childProcess.spawn;
    spyOn(childProcess, "spawn").and.callFake((command, ...args) => {
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
    const build = await lumine.packages.activatePackage("tasks");
    buildMain = build.mainModule;
    backend = buildMain.provideTasks();
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    provider = main.providePdfBuildProvider();
    spyOn(main, "resolveTypstPath").and.returnValue({ exePath: "owned-typst", extraArgs: [] });
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "typst-pdf-provider-")),
    );
    source = path.join(directory, "main.typ");
    output = path.join(directory, "main.pdf");
    fs.writeFileSync(source, "Owned Typst source\n");
  });

  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("typst-tools");
    await lumine.packages.deactivatePackage("tasks");
    for (const child of children) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    lumine.config.unset("typst-tools.outputFormat");
    const resolved = fs.realpathSync.native(directory);
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe Typst PDF provider fixture cleanup");
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  function holdStat(filePath = source) {
    const nativeStat = fs.promises.stat;
    let release;
    spyOn(fs.promises, "stat").and.callFake((candidate, ...args) =>
      candidate === filePath
        ? new Promise((resolve) => {
            release = resolve;
          })
        : nativeStat.call(fs.promises, candidate, ...args),
    );
    return () => release({ isFile: () => true });
  }

  it("exchanges a stable provider through the PDF service contract", () => {
    let consumed;
    leases.push(
      lumine.packages.serviceHub.consume("pdf-view.build-provider", "^1.0.0", (value) => {
        if (value.id === "typst-tools") consumed = value;
      }),
    );
    expect(consumed).toBe(provider);
    expect(main.providePdfBuildProvider()).toBe(provider);
    expect(provider.id).toBe("typst-tools");
  });

  it("resolves an existing same-basename Typst source without claiming backend ownership", async () => {
    expect(await provider.resolveSource(output, { signal: new AbortController().signal })).toBe(
      source,
    );
    expect(backend.getArtifactTarget(output)).toBeNull();
    expect(await provider.resolveSource(path.join(directory, "missing.pdf"))).toBeNull();
    expect(await provider.resolveSource(source)).toBeNull();
  });

  it("validates restored hints against the expected output and configured format", async () => {
    const otherSource = path.join(directory, "other.typ");
    fs.writeFileSync(otherSource, "Other document\n");
    expect(await provider.resolveSource(output, { sourcePath: source })).toBe(source);
    expect(
      await provider.resolveSource(path.join(directory, "custom.pdf"), { sourcePath: otherSource }),
    ).toBeNull();
    expect(await provider.resolveSource(output, { sourcePath: otherSource })).toBe(source);
    lumine.config.set("typst-tools.outputFormat", "svg");
    expect(await provider.resolveSource(output, { sourcePath: source })).toBeNull();
  });

  it("honors authoritative custom-output metadata and rejects a foreign provider claim", async () => {
    const custom = path.join(directory, "rendered", "custom.pdf");
    backend.associateArtifact({ providerId: "typst-tools", filePath: source }, custom);
    expect(await provider.resolveSource(custom)).toBe(source);
    const foreign = backend.registerProvider({
      id: "foreign",
      name: "Foreign",
      supports: () => true,
      prepare: () => ({ cmd: "unused" }),
    });
    leases.push(foreign);
    backend.associateArtifact({ providerId: "foreign", filePath: source }, output);
    expect(await provider.resolveSource(output, { sourcePath: source })).toBeNull();
  });

  it("keeps availability and busy checks free of filesystem and compiler discovery", () => {
    const lookup = spyOn(fs, "existsSync").and.throwError("No synchronous discovery");
    const stat = spyOn(fs.promises, "stat").and.throwError("No asynchronous discovery");
    expect(provider.canBuild(source)).toBeTrue();
    expect(provider.canBuild(output)).toBeFalse();
    expect(provider.isBuilding(output)).toBeFalse();
    expect(main.resolveTypstPath).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    lookup.and.callThrough();
    stat.and.callThrough();
  });

  it("builds through the real shared backend and reports output-specific concurrent work", async () => {
    const second = path.join(directory, "second.typ");
    fs.writeFileSync(second, "Second document\n");
    const builds = jasmine.createSpy("build changes");
    leases.push(provider.onDidChangeBuilds(builds));
    const firstJob = provider.build(source);
    const secondJob = provider.build(second);
    await conditionPromise(() => firstJob.state === "running" && secondJob.state === "running");
    expect(provider.canBuild(source)).toBeFalse();
    expect(provider.build(source)).toBeNull();
    expect(provider.isBuilding(output)).toBeTrue();
    expect(provider.isBuilding(second.replace(/\.typ$/, ".pdf"))).toBeTrue();
    expect(provider.isBuilding(path.join(directory, "unrelated.pdf"))).toBeFalse();
    firstJob.process.emit("close", 0, null);
    await firstJob.completion;
    expect(provider.isBuilding(output)).toBeFalse();
    expect(provider.canBuild(source)).toBeTrue();
    expect(provider.isBuilding(second.replace(/\.typ$/, ".pdf"))).toBeTrue();
    expect(builds).toHaveBeenCalled();
    secondJob.process.emit("close", 0, null);
    await secondJob.completion;
  });

  it("toggles observation for a closed source through the real backend without building or opening a panel", async () => {
    expect(
      lumine.workspace.getTextEditors().some((editor) => editor.getPath() === source),
    ).toBeFalse();
    const hints = spyOn(lumine.notifications, "addHint");
    const infos = spyOn(lumine.notifications, "addInfo");
    const successes = spyOn(lumine.notifications, "addSuccess");
    const builds = jasmine.createSpy("observation state changed");
    leases.push(provider.onDidChangeBuilds(builds));
    expect(provider.canToggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeTrue();
    expect(backend.getObserved({ providerId: "typst-tools" })).toEqual([
      { providerId: "typst-tools", filePath: source },
    ]);
    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(backend.getObserved({ providerId: "typst-tools" })).toEqual([]);
    await timeoutPromise(200);
    expect(backend.getJobs({ providerId: "typst-tools" })).toEqual([]);
    expect(buildMain.panel).toBeNull();
    expect(builds).toHaveBeenCalledTimes(2);
    expect(hints).not.toHaveBeenCalled();
    expect(infos).not.toHaveBeenCalled();
    expect(successes).not.toHaveBeenCalled();
  });

  it("keeps observation predicates pure and restricts them to absolute Typst paths", () => {
    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    const lookup = spyOn(fs, "existsSync").and.throwError("No filesystem discovery");
    const stat = spyOn(fs.promises, "stat").and.throwError("No filesystem discovery");
    const job = spyOn(backend, "getJob").and.throwError(
      "Observation does not depend on a running job",
    );
    expect(provider.canToggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeTrue();
    for (const candidate of [path.basename(source), output, null, source + "\0"]) {
      expect(provider.canToggleCompileOnSave(candidate)).toBeFalse();
      expect(provider.isCompileOnSaveEnabled(candidate)).toBeFalse();
      expect(provider.toggleCompileOnSave(candidate)).toBeFalse();
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
    lookup.and.callThrough();
    stat.and.callThrough();
    job.and.callThrough();
  });

  it("lets compile-on-save change during compilation without stopping or duplicating that execution", async () => {
    const job = provider.build(source);
    await conditionPromise(() => job.state === "running");
    expect(provider.canBuild(source)).toBeFalse();
    expect(provider.canToggleCompileOnSave(source)).toBeTrue();
    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeTrue();
    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(backend.getJobs({ providerId: "typst-tools" })).toEqual([job]);
    children[0].emit("close", 0, null);
    await job.completion;
  });

  it("emits source changes for foreign metadata and backend withdrawal or arrival", async () => {
    const sources = jasmine.createSpy("source changes");
    const builds = jasmine.createSpy("build changes");
    leases.push(provider.onDidChangeSources(sources), provider.onDidChangeBuilds(builds));
    const foreign = backend.registerProvider({
      id: "foreign",
      name: "Foreign",
      supports: () => true,
      prepare: () => ({ cmd: "unused" }),
    });
    leases.push(foreign);
    backend.associateArtifact({ providerId: "foreign", filePath: source }, output);
    expect(sources).toHaveBeenCalledWith({ pdfPath: output });
    await lumine.packages.deactivatePackage("tasks");
    expect(sources).toHaveBeenCalledWith({});
    expect(builds).toHaveBeenCalled();
    expect(provider.canBuild(source)).toBeFalse();
    expect(provider.canToggleCompileOnSave(source)).toBeFalse();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(provider.toggleCompileOnSave(source)).toBeFalse();
    sources.calls.reset();
    await lumine.packages.activatePackage("tasks");
    expect(sources).toHaveBeenCalledWith({});
    expect(provider.canBuild(source)).toBeTrue();
    expect(provider.canToggleCompileOnSave(source)).toBeTrue();
  });

  it("keeps duplicate backend leases from multiplying events or retiring a live provider", async () => {
    const first = main.consumeTasks(backend);
    const second = main.consumeTasks(backend);
    leases.push(first, second);
    const builds = jasmine.createSpy("build changes");
    leases.push(provider.onDidChangeBuilds(builds));
    const job = provider.build(source);
    await conditionPromise(() => job.state === "running");
    builds.calls.reset();
    first.dispose();
    second.dispose();
    children[0].stdout.write("one transport update\n");
    expect(builds).toHaveBeenCalledTimes(1);
    expect(provider.isBuilding(output)).toBeTrue();
    children[0].emit("close", 0, null);
    await job.completion;
  });

  it("aborts source lookup when its filesystem result arrives after cancellation", async () => {
    const release = holdStat();
    const controller = new AbortController();
    const pending = provider.resolveSource(output, { signal: controller.signal });
    controller.abort();
    release();
    await expectAsync(pending).toBeRejectedWithError();
  });

  it("rejects a source result when metadata changes during its filesystem check", async () => {
    const custom = path.join(directory, "custom.pdf");
    backend.associateArtifact({ providerId: "typst-tools", filePath: source }, custom);
    const release = holdStat();
    const pending = provider.resolveSource(custom);
    const foreign = backend.registerProvider({
      id: "foreign",
      name: "Foreign",
      supports: () => true,
      prepare: () => ({ cmd: "unused" }),
    });
    leases.push(foreign);
    backend.associateArtifact({ providerId: "foreign", filePath: source }, custom);
    release();
    expect(await pending).toBeNull();
  });

  it("drops pending source results when its backend generation disappears", async () => {
    const release = holdStat();
    const pending = provider.resolveSource(output);
    await lumine.packages.deactivatePackage("tasks");
    release();
    expect(await pending).toBeNull();
  });

  it("keeps retained payloads inert after retirement and reacquires a fresh package generation", async () => {
    const release = holdStat();
    const pending = provider.resolveSource(output);
    const sources = jasmine.createSpy("retired source event");
    leases.push(provider.onDidChangeSources(sources));
    await lumine.packages.deactivatePackage("typst-tools");
    // Backend withdrawal can be reported before the package's retirement hook.
    sources.calls.reset();
    release();
    expect(await pending).toBeNull();
    expect(provider.canBuild(source)).toBeFalse();
    expect(provider.build(source)).toBeNull();
    expect(provider.isBuilding(output)).toBeFalse();
    expect(provider.canToggleCompileOnSave(source)).toBeFalse();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(provider.toggleCompileOnSave(source)).toBeFalse();
    expect(await provider.resolveSource(output)).toBeNull();
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    const current = main.providePdfBuildProvider();
    expect(current).not.toBe(provider);
    backend.associateArtifact({ providerId: "typst-tools", filePath: source }, output);
    expect(sources).not.toHaveBeenCalled();
    expect(current.canBuild(source)).toBeTrue();
    expect(current.canToggleCompileOnSave(source)).toBeTrue();
    expect(provider.toggleCompileOnSave(source)).toBeFalse();
    expect(backend.getObserved({ providerId: "typst-tools" })).toEqual([]);
  });
});
