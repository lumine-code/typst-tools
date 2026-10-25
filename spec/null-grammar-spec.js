const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Emitter } = require("lumine");

describe("typst-tools automatic builds without a grammar", () => {
  let directory, editor, main, emitter;
  beforeEach(async () => {
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "typst-tools-none-"));
    const filePath = path.join(directory, "source.typ");
    fs.writeFileSync(filePath, "source\n");
    editor = await lumine.workspace.open(filePath);
    await editor.getBuffer().getFileWatchStartPromise();
    const pkg = await lumine.packages.activatePackage("typst-tools");
    main = pkg.mainModule;
    emitter = new Emitter();
    spyOn(lumine.fileWatchClient, "watchFile").and.returnValue({
      ready: Promise.resolve(),
      closed: Promise.resolve(),
      onDidChange: (callback) => emitter.on("change", callback),
      onDidInvalidate: (callback) => emitter.on("invalidate", callback),
      onDidError: (callback) => emitter.on("error", callback),
      dispose() {
        emitter.dispose();
      },
    });
    expect(main.setCompileOnSaveForFile(filePath, true)).toBe(true);
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("typst-tools");
    editor?.destroy();
    fs.unlinkSync(path.join(directory, "source.typ"));
    fs.rmdirSync(directory);
  });
  it("cancels queued automatic compilation and resumes after a grammar returns", () => {
    const compile = spyOn(main, "compileFilePath");
    const grammar = editor.getGrammar();
    emitter.emit("change", []);
    editor.setGrammar(lumine.grammars.nullGrammar);
    advanceClock(200);
    expect(compile).not.toHaveBeenCalled();
    emitter.emit("invalidate");
    advanceClock(200);
    expect(compile).not.toHaveBeenCalled();
    expect(main.isCompileOnSaveEnabledForFile(editor.getPath())).toBe(true);
    editor.setGrammar(grammar);
    emitter.emit("change", []);
    advanceClock(200);
    expect(compile).toHaveBeenCalledTimes(1);
  });
  it("interrupts this document's pending build when None is selected", () => {
    const filePath = editor.getPath();
    main.buildProcesses.set(filePath, { process: {} });
    const stop = spyOn(main, "interruptFile").and.callFake((target) => {
      main.buildProcesses.delete(target);
    });
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(stop).toHaveBeenCalledOnceWith(filePath);
  });

  it("does not interrupt a replacement build started by a failure callback", () => {
    const filePath = editor.getPath();
    const replacement = { process: {} };
    main.buildProcesses.set(filePath, { process: {} });
    const stop = spyOn(main, "interruptFile").and.callFake(() => {
      main.buildProcesses.set(filePath, replacement);
    });
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(stop).toHaveBeenCalledOnceWith(filePath);
    expect(main.buildProcesses.get(filePath)).toBe(replacement);
    main.buildProcesses.delete(filePath);
  });
});
