const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

describe("Typst build operation ownership", () => {
  let main, directory, file, editor, children, spawn, pending;
  beforeEach(async () => {
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    children = [];
    pending = [];
    spawn = spyOn(childProcess, "spawn").and.callFake(() => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 1;
      child.kill = jasmine.createSpy("owned child kill");
      children.push(child);
      return child;
    });
    spyOn(childProcess, "execFileSync").and.throwError("Uncontrolled executable lookup");
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "typst-build-owner-")));
    file = path.join(directory, "source.typ");
    fs.writeFileSync(file, "owned original\n");
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    spyOn(main, "killProcess").and.callFake((child) => child.kill());
    spyOn(main, "resolveTypstPath").and.returnValue({
      exePath: path.join(directory, "nonexistent-owned-typst.exe"),
      extraArgs: [],
    });
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor = await lumine.workspace.open(file);
  });
  afterEach(async () => {
    for (const release of pending) release();
    await Promise.resolve();
    await lumine.packages.deactivatePackage("typst-tools");
    editor?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw Error("Fixture escaped its owned temporary root");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function heldSave(change) {
    editor.setText("owned accepted save\n");
    const save = editor.save.bind(editor);
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const arrived = new Promise((resolve) => (entered = resolve));
    pending.push(release);
    spyOn(editor, "save").and.callFake(async () => {
      const result = await save();
      entered();
      await gate;
      return result;
    });
    const compiling = main.compile();
    try {
      await arrived;
      await change();
    } finally {
      release();
      await compiling;
    }
    expect(fs.readFileSync(file, "utf8")).toBe("owned accepted save\n");
  }
  it("finishes an accepted Core save without starting a build after Package retirement", async () => {
    await heldSave(() => lumine.packages.deactivatePackage("typst-tools"));
    expect(spawn).not.toHaveBeenCalled();
  });
  it("does not build after its saved target editor is destroyed", async () => {
    await heldSave(() => editor.destroy());
    expect(spawn).not.toHaveBeenCalled();
  });
  for (const event of ["exit", "error"]) {
    it(`keeps the replacement same-file build when the old child delivers ${event}`, () => {
      main.runCompilation(file);
      expect(children.length).toBe(1);
      const old = children[0];
      main.interruptFile(file);
      main.runCompilation(file);
      const current = main.buildProcesses.get(file);
      expect(current.process).toBe(children[1]);
      if (event === "exit") old.emit("exit", 0, null);
      else old.emit("error", new Error("owned late failure"));
      expect(main.buildProcesses.get(file)).toBe(current);
      expect(main.buildStates.get(file).status).toBe("building");
    });
  }
  it("keeps normal current process completion and the public build service", () => {
    const finished = jasmine.createSpy("owned finish");
    const lease = main.provideTypstTools().onDidFinishBuild(finished);
    try {
      main.runCompilation(file);
      expect(children.length).toBe(1);
      children[0].emit("exit", 0, null);
      expect(main.buildProcesses.has(file)).toBe(false);
      expect(main.buildStates.get(file).status).toBe("success");
      expect(finished).toHaveBeenCalled();
    } finally {
      lease.dispose();
    }
  });
  it("retires a retained actual build facade before it can submit another process", async () => {
    const service = main.provideTypstTools();
    await lumine.packages.deactivatePackage("typst-tools");
    expect(service.compile(file)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("returns diagnostics only for their compiling root while retaining imported source spans", () => {
    const unrelated = path.join(directory, "unrelated.typ");
    const imported = path.join(directory, "imported.typ");
    fs.writeFileSync(unrelated, "owned second root\n");
    fs.writeFileSync(imported, "owned imported source\n");
    const service = main.provideTypstTools();
    main.runCompilation(file);
    children[0].stderr.emit("data", "error: owned import\n  ┌─ imported.typ:1:1\n  │ ^^^");
    children[0].emit("exit", 1, null);
    const messages = service.getMessages(file);
    expect(messages.length).toBe(1);
    expect(messages[0].location.fullPath).toBe(imported);
    expect(service.getMessages(unrelated)).toEqual([]);
    expect(service.getMessageStatistics(unrelated)).toEqual({ total: 0, errors: 0, warnings: 0 });
  });
  it("replaces the previous root diagnostic snapshot after a clean current build", () => {
    const second = path.join(directory, "second.typ");
    fs.writeFileSync(second, "owned second root\n");
    const service = main.provideTypstTools();
    main.runCompilation(file);
    children[0].stderr.emit("data", "error: owned original error");
    children[0].emit("exit", 1, null);
    expect(service.getMessages(file).length).toBe(1);
    main.runCompilation(second);
    children[1].emit("exit", 0, null);
    expect(service.getMessages(second)).toEqual([]);
    expect(service.getMessages(file)).toEqual([]);
  });
  it("retires the public building state when its current child terminates by signal", () => {
    const service = main.provideTypstTools();
    main.runCompilation(file);
    expect(service.isBuilding(file)).toBe(true);
    children[0].emit("exit", null, "SIGTERM");
    expect(main.buildProcesses.has(file)).toBe(false);
    expect(service.isBuilding(file)).toBe(false);
    expect(main.buildStates.get(file).status).toBe("idle");
  });
  for (const code of [0, 1])
    it(`reports accepted exit ${code} without retiring a build started by its message event`, () => {
      const service = main.provideTypstTools();
      const finished = jasmine.createSpy("owned completed build");
      const finishLease =
        code === 0 ? service.onDidFinishBuild(finished) : service.onDidFailBuild(finished);
      let restarted = false;
      const messageLease = service.onDidUpdateMessages(() => {
        if (restarted) return;
        restarted = true;
        lumine.commands.dispatch(lumine.workspace.getElement(), "typst-tools:compile");
      });
      try {
        main.runCompilation(file);
        children[0].stderr.emit(
          "data",
          `${code === 0 ? "warning" : "error"}: owned accepted diagnostic`,
        );
        children[0].emit("exit", code, null);
        expect(children.length).toBe(2);
        expect(main.buildProcesses.get(file).process).toBe(children[1]);
        expect(service.isBuilding(file)).toBe(true);
        expect(finished).toHaveBeenCalledTimes(1);
      } finally {
        finishLease.dispose();
        messageLease.dispose();
      }
    });
});
