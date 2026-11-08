const path = require("path");
const fs = require("fs");
const os = require("os");

describe("typst-tools", () => {
  let workspaceElement, mainModule, tempDirs, editors;

  function makeTempDir() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "typst-tools-spec-")));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    tempDirs = [];
    editors = [];
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    await lumine.packages.activatePackage("tasks");
    const pack = await lumine.packages.activatePackage("typst-tools");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    mainModule.clearCompileOnSaveFiles();
    for (const editor of editors) editor.destroy();
    await lumine.packages.deactivatePackage("typst-tools");
    await lumine.fileWatchClient.settlePendingTeardown();
    for (const dir of tempDirs) {
      const relative = path.relative(fs.realpathSync(os.tmpdir()), dir);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !path.basename(dir).startsWith("typst-tools-spec-")
      ) {
        throw new Error("Unsafe Typst fixture cleanup");
      }
      await fs.promises.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });

  describe("command registration", () => {
    it("keeps the observed-files picker lazy", () => {
      expect(mainModule.observedFilesList).toBeNull();

      const list = mainModule.ensureObservedFilesList();
      expect(list).toBe(mainModule.observedFilesList);
      expect(mainModule.ensureObservedFilesList()).toBe(list);
    });

    it("recreates lazy UI after a deactivate/reactivate lifecycle", async () => {
      const firstList = mainModule.ensureObservedFilesList();
      spyOn(firstList, "destroy").and.callThrough();

      await lumine.packages.deactivatePackage("typst-tools");
      expect(firstList.destroy).toHaveBeenCalled();

      const pack = await lumine.packages.activatePackage("typst-tools");
      mainModule = pack.mainModule;
      expect(mainModule.observedFilesList).toBeNull();
      expect(mainModule.ensureObservedFilesList()).not.toBe(firstList);
    });

    it("registers the installer and observed-file commands on the workspace", () => {
      const commands = lumine.commands
        .findCommands({ target: workspaceElement })
        .map((command) => command.name);
      for (const name of [
        "typst-tools:install-typst",
        "typst-tools:observed-files",
        "typst-tools:clear-all-observed-files",
      ]) {
        expect(commands).toContain(name);
      }
    });

    it("registers the build commands on typst editors", async () => {
      const editor = await lumine.workspace.open();
      editors.push(editor);
      const editorElement = lumine.views.getView(editor);
      editorElement.dataset.grammar = "text typst";
      const commands = lumine.commands
        .findCommands({ target: editorElement })
        .map((command) => command.name);
      for (const name of [
        "typst-tools:compile",
        "typst-tools:watch",
        "typst-tools:open-pdf",
        "typst-tools:interrupt",
        "typst-tools:interrupt-all",
        "typst-tools:clean-linter",
        "typst-tools:list-fonts",
      ]) {
        expect(commands).toContain(name);
      }
    });
  });

  describe("PDF source compilation", () => {
    it("compiles an existing source without an open editor", async () => {
      const directory = makeTempDir();
      const typFile = path.join(directory, "document.typ");
      const pdfFile = path.join(directory, "document.pdf");
      fs.writeFileSync(typFile, "content");
      spyOn(lumine.workspace.getCenter(), "getActivePaneItem").and.returnValue({
        filePath: pdfFile,
      });
      spyOn(lumine.workspace, "getTextEditors").and.returnValue([]);
      spyOn(mainModule, "runCompilation");

      await mainModule.compile();

      expect(mainModule.runCompilation).toHaveBeenCalledWith(typFile);
    });

    it("recreates a removed Typst source before compiling it", async () => {
      const directory = makeTempDir();
      const typFile = path.join(directory, "document.typ");
      const pdfFile = path.join(directory, "document.pdf");
      spyOn(lumine.workspace.getCenter(), "getActivePaneItem").and.returnValue({
        filePath: pdfFile,
      });

      let finishSave;
      const editor = {
        getPath: () => typFile,
        getFileState: () => "removed",
        save: jasmine.createSpy("save").and.callFake(
          () =>
            new Promise((resolve) => {
              finishSave = () => {
                fs.writeFileSync(typFile, "content");
                resolve();
              };
            }),
        ),
      };
      spyOn(lumine.workspace, "getTextEditors").and.returnValue([editor]);
      editor.isDestroyed = () => false;
      spyOn(mainModule, "runCompilation");

      const compiling = mainModule.compile();
      expect(editor.save).toHaveBeenCalled();
      expect(mainModule.runCompilation).not.toHaveBeenCalled();

      finishSave();
      await compiling;
      expect(mainModule.runCompilation).toHaveBeenCalledWith(typFile);
    });
  });

  describe("output parser", () => {
    let OutputParser, parser;

    beforeEach(() => {
      OutputParser = require(path.join(__dirname, "..", "lib", "output-parser"));
      parser = new OutputParser();
    });

    it("parses an error with file, position and span", () => {
      const stderr = [
        "error: unknown variable: bad",
        "  ┌─ main.typ:3:5",
        "  │",
        "3 │     bad syntax",
        "  │     ^^^",
        "",
      ].join("\n");
      const mainFile = path.join(__dirname, "main.typ");
      const messages = parser.parse(stderr, mainFile);
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe("error");
      expect(messages[0].excerpt).toBe("unknown variable: bad");
      expect(messages[0].location.fullPath).toBe(mainFile);
      expect(messages[0].location.position.start).toEqual({ row: 2, column: 4 });
      expect(messages[0].location.position.end).toEqual({ row: 2, column: 7 });
    });

    it("parses warnings and multiple diagnostics", () => {
      const stderr = [
        "warning: unused import",
        "  ┌─ lib.typ:1:0",
        "  │",
        "1 │ #import calc",
        "  │ ^^^^^^^",
        "error: expected expression",
        "  ┌─ main.typ:10:2",
      ].join("\n");
      const messages = parser.parse(stderr, "/proj/main.typ");
      expect(messages.length).toBe(2);
      expect(messages[0].severity).toBe("warning");
      expect(messages[1].severity).toBe("error");
      expect(messages[1].location.position.start.row).toBe(9);
    });

    it("falls back to the main file when no location is present", () => {
      const messages = parser.parse("error: something exploded", "/proj/main.typ");
      expect(messages.length).toBe(1);
      expect(messages[0].location.fullPath).toBe("/proj/main.typ");
      expect(messages[0].location.position.start).toEqual({ row: 0, column: 0 });
    });

    it("returns no messages for empty output", () => {
      expect(parser.parse("", "/proj/main.typ")).toEqual([]);
      expect(parser.parse("   \n  ", "/proj/main.typ")).toEqual([]);
    });

    it("computes statistics", () => {
      parser.parse("error: a\nwarning: b\nwarning: c", "/proj/main.typ");
      expect(parser.getStatistics()).toEqual({ total: 3, errors: 1, warnings: 2 });
    });
  });

  describe("path helpers", () => {
    const { getOutputPath, getSourcePath } = require(path.join(__dirname, "..", "lib", "utils"));

    it("maps .typ files to output paths", () => {
      expect(getOutputPath("/proj/doc.typ")).toBe("/proj/doc.pdf");
      expect(getOutputPath("/proj/doc.typ", "svg")).toBe("/proj/doc.svg");
    });

    it("maps output files back to .typ sources", () => {
      expect(getSourcePath("/proj/doc.pdf")).toBe("/proj/doc.typ");
      expect(getSourcePath("/proj/doc.svg")).toBe("/proj/doc.typ");
    });
  });

  describe("typst installer", () => {
    const installer = require(path.join(__dirname, "..", "lib", "typst-installer"));

    it("maps the current platform to a release asset name", () => {
      const name = installer.getAssetName();
      expect(name).toMatch(/^typst-(x86_64|aarch64)-.*(\.zip|\.tar\.xz)$/);
    });

    it("points the bundled binary inside the package bin directory", () => {
      const binPath = installer.getBinPath();
      expect(binPath.startsWith(path.join(__dirname, "..", "bin"))).toBe(true);
    });
  });
});
