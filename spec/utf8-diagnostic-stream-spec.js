const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

describe("Typst UTF-8 diagnostic stream", () => {
  let directory, rootPath, importedPath, editor, main, service, lease, child;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(childProcess, "spawn").and.callFake(() => {
      child = new EventEmitter();
      child.stderr = new PassThrough();
      child.kill = jasmine.createSpy("owned diagnostic transport kill");
      return child;
    });
    spyOn(childProcess, "execFileSync").and.throwError("Uncontrolled executable lookup");
    if (lumine.packages.isPackageActive("typst-tools"))
      await lumine.packages.deactivatePackage("typst-tools");
    if (lumine.packages.isPackageLoaded("typst-tools"))
      await lumine.packages.unloadPackage("typst-tools");
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "typst-utf8-")));
    rootPath = path.join(directory, "main.typ");
    importedPath = path.join(directory, "imported.typ");
    fs.writeFileSync(rootPath, "First\nSecond\nLocated error\n");
    fs.writeFileSync(importedPath, "First\nSecond\nLocated error\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("linter");
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    spyOn(main, "killProcess").and.callFake((ownedChild) => ownedChild.kill());
    spyOn(main, "resolveTypstPath").and.returnValue({
      exePath: path.join(directory, "nonexistent-typst"),
      extraArgs: [],
    });
    lease = lumine.packages.serviceHub.consume("typst-tools", "^1.0.0", (payload) => {
      service = payload;
    });
    editor = await lumine.workspace.open(rootPath);
    expect(service).toBe(main.buildService);
    expect(main.linterProvider.indieInstance.name).toBe("Typst");
  });

  afterEach(async () => {
    child?.stderr.destroy();
    lease?.dispose();
    editor?.destroy();
    if (lumine.packages.isPackageActive("typst-tools"))
      await lumine.packages.deactivatePackage("typst-tools");
    if (lumine.packages.isPackageLoaded("typst-tools"))
      await lumine.packages.unloadPackage("typst-tools");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      const resolved = fs.realpathSync.native(directory);
      const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Unsafe diagnostic fixture cleanup");
      await fs.promises.rm(resolved, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      });
    }
    directory = rootPath = importedPath = editor = main = service = lease = child = null;
  });

  async function diagnostic(splitCharacter) {
    const bytes = Buffer.from("error: café missing\n  ┌─ imported.typ:3:5\n  │ ^^^\n", "utf8");
    expect(service.compile(rootPath)).toBeTrue();
    const split = splitCharacter
      ? bytes.indexOf(Buffer.from(splitCharacter, "utf8")) + 1
      : bytes.length;
    child.stderr.write(bytes.subarray(0, split));
    await new Promise((resolve) => child.stderr.end(bytes.subarray(split), resolve));
    child.emit("exit", 1, null);
    const messages = service.getMessages(rootPath);
    expect(messages.length).toBe(1);
    expect(main.linterProvider.indieInstance.getMessages().length).toBe(1);
    return messages[0];
  }

  it("preserves the location header when its box character spans chunks", async () => {
    const message = await diagnostic("┌");
    expect(message.location.fullPath).toBe(importedPath);
    expect(message.location.position.start).toEqual({ row: 2, column: 4 });
    expect(message.location.position.end).toEqual({ row: 2, column: 7 });
  });

  it("preserves an accented diagnostic excerpt across chunks", async () => {
    expect((await diagnostic("é")).excerpt).toBe("café missing");
  });

  it("retains ordinary whole-chunk UTF-8 diagnostics", async () => {
    const message = await diagnostic(null);
    expect(message.excerpt).toBe("café missing");
    expect(message.location.fullPath).toBe(importedPath);
    expect(message.location.position.start).toEqual({ row: 2, column: 4 });
  });
});
