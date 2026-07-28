const path = require("path");
const fs = require("fs");
const os = require("os");

// The shared modal vocabulary lives in the editor checkout, which sits at a
// different relative depth in CI than it does in the workspace, so it is
// resolved through the resource path rather than by counting `..`.
const {
  activeSession,
  modalElement,
  visibleLabels,
  visibleItems,
  dispatch,
  confirm,
  settle,
} = require(path.join(atom.getLoadSettings().resourcePath, "spec", "helpers", "modal-helpers"));

describe("typst-tools", () => {
  let workspaceElement, mainModule, tempDirs;

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typst-tools-spec-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    tempDirs = [];
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);
    const pack = await atom.packages.activatePackage("typst-tools");
    mainModule = pack.mainModule;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows can refuse to delete recently watched directories.
      }
    }
  });

  describe("command registration", () => {
    it("registers the installer and observed-file commands on the workspace", () => {
      const commands = atom.commands
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
      const editor = await atom.workspace.open();
      const editorElement = atom.views.getView(editor);
      editorElement.dataset.grammar = "text typst";
      const commands = atom.commands
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

  describe("provided typst-tools service", () => {
    let service;

    beforeEach(() => {
      service = mainModule.provideTypstTools();
    });

    it("exposes the API consumed by pdf-view", () => {
      // pdf-view calls compile() and subscribes to the three build events.
      for (const method of [
        "compile",
        "onDidStartBuild",
        "onDidFinishBuild",
        "onDidFailBuild",
        "onDidChangeBuildStatus",
        "getStatus",
        "isBuilding",
        "interrupt",
        "interruptAll",
        "toggleCompileOnSave",
        "isCompileOnSaveEnabled",
        "getMessages",
        "getMessageStatistics",
        "getOutputPath",
        "openPdf",
      ]) {
        expect(typeof service[method]).toBe("function");
      }
    });

    it("emits build lifecycle events with the file payload", () => {
      const file = path.join(__dirname, "doc.typ");
      const started = [];
      const finished = [];
      const failed = [];
      const statuses = [];
      const disposables = [
        service.onDidStartBuild((data) => started.push(data)),
        service.onDidFinishBuild((data) => finished.push(data)),
        service.onDidFailBuild((data) => failed.push(data)),
        service.onDidChangeBuildStatus((data) => statuses.push(data)),
      ];
      for (const disposable of disposables) {
        expect(typeof disposable.dispose).toBe("function");
      }

      service.startBuild(file);
      expect(started).toEqual([{ file }]);
      expect(service.isBuilding(file)).toBe(true);
      expect(service.getStatus(file).status).toBe("building");

      service.finishBuild(file, "output text", 123);
      expect(finished.length).toBe(1);
      expect(finished[0].file).toBe(file);
      expect(finished[0].output).toBe("output text");
      expect(service.isBuilding(file)).toBe(false);
      expect(service.getStatus(file).status).toBe("success");

      service.startBuild(file);
      service.failBuild(file, "Exit code 1", "stderr text");
      expect(failed.length).toBe(1);
      expect(failed[0].file).toBe(file);
      expect(failed[0].error).toBe("Exit code 1");
      expect(service.getStatus(file).status).toBe("error");

      expect(statuses.map((s) => s.status)).toEqual(["building", "success", "building", "error"]);

      for (const disposable of disposables) {
        disposable.dispose();
      }
      service.reset();
    });

    it("delegates compile() to the main module for .typ files only", () => {
      spyOn(mainModule, "runCompilation");
      expect(service.compile("/tmp/doc.txt")).toBe(false);
      expect(service.compile(null)).toBe(false);
      expect(mainModule.runCompilation).not.toHaveBeenCalled();
      expect(service.compile("/tmp/doc.typ")).toBe(true);
      expect(mainModule.runCompilation).toHaveBeenCalledWith("/tmp/doc.typ");
    });

    it("refuses to start a second build for a file already building", () => {
      spyOn(mainModule, "runCompilation");
      const file = "/tmp/busy.typ";
      service.startBuild(file);
      expect(service.compile(file)).toBe(false);
      expect(mainModule.runCompilation).not.toHaveBeenCalled();
      service.reset(file);
    });

    it("reports aggregate status across files", () => {
      service.startBuild("/tmp/a.typ");
      service.startBuild("/tmp/b.typ");
      const status = service.getStatus();
      expect(status.status).toBe("building");
      expect(status.buildingCount).toBe(2);
      service.reset();
      expect(service.getStatus().status).toBe("idle");
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
      expect(messages[0].location.position.start).toEqual({ row: -1, column: -1 });
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

  describe("linter integration", () => {
    it("registers an indie linter through the linter.registry service", () => {
      const registered = [];
      const indie = {
        name: "Typst",
        setAllMessages() {},
        clearMessages() {},
        dispose() {},
      };
      mainModule.consumeLinterRegistry((options) => {
        registered.push(options);
        return indie;
      });
      expect(registered).toEqual([{ name: "Typst" }]);
      expect(mainModule.linterProvider.indieInstance).toBe(indie);
    });

    it("converts and deduplicates messages for the linter", () => {
      const calls = [];
      mainModule.linterProvider.register({
        setAllMessages(messages) {
          calls.push(messages);
        },
        clearMessages() {},
      });
      const message = {
        severity: "error",
        excerpt: "boom",
        location: {
          file: "doc.typ",
          fullPath: "/proj/doc.typ",
          position: { start: { row: 2, column: 4 }, end: { row: 2, column: 7 } },
        },
      };
      mainModule.linterProvider.setMessages([message, { ...message }]);
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual([
        {
          severity: "error",
          location: {
            file: "/proj/doc.typ",
            position: [
              [2, 4],
              [2, 7],
            ],
          },
          excerpt: "boom",
        },
      ]);
    });
  });

  describe("compile-on-save observation", () => {
    it("observes files by path and tracks them in the status view", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "doc.typ");
      fs.writeFileSync(file, "#set page(width: 10cm)");

      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(true);
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(true);
      expect(mainModule.getCompileOnSaveFiles()).toEqual([path.resolve(file)]);
      expect(mainModule.observedFilesStatusView.count).toBe(1);

      // Enabling twice is a no-op.
      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(false);

      expect(mainModule.setCompileOnSaveForFile(file, false)).toBe(true);
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(false);
      expect(mainModule.getCompileOnSaveFiles()).toEqual([]);
      expect(mainModule.observedFilesStatusView.count).toBe(0);
    });

    it("keeps observing after the file's editor is destroyed", async () => {
      const dir = makeTempDir();
      const file = path.join(dir, "doc.typ");
      fs.writeFileSync(file, "#set page(width: 10cm)");

      const editor = await atom.workspace.open(file);
      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(true);
      expect(mainModule.isCompileOnSaveEnabled(editor)).toBe(true);

      editor.destroy();

      // The observer is keyed by path, not by editor, so closing the editor
      // must not stop compile-on-save.
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(true);
      expect(mainModule.observedFilesStatusView.count).toBe(1);

      mainModule.setCompileOnSaveForFile(file, false);
    });

    it("clears every observed file at once", () => {
      const dir = makeTempDir();
      const files = ["a.typ", "b.typ"].map((name) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, "#set page(width: 10cm)");
        mainModule.setCompileOnSaveForFile(file, true);
        return file;
      });

      expect(mainModule.getCompileOnSaveFiles().length).toBe(files.length);
      mainModule.clearCompileOnSaveFiles();
      expect(mainModule.getCompileOnSaveFiles()).toEqual([]);
      expect(mainModule.observedFilesStatusView.count).toBe(0);
    });

    it("rejects non-typst files", () => {
      const file = path.join(os.tmpdir(), "doc.txt");
      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(false);
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(false);
    });
  });

  describe("observed files list", () => {
    let dir, previousProjectPaths;

    function observe(name) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "#set page(width: 10cm)");
      mainModule.setCompileOnSaveForFile(file, true);
      return path.resolve(file);
    }

    async function openList() {
      mainModule.showObservedFiles();
      await settle();
    }

    beforeEach(() => {
      // Rows read project-relative, so the list needs a known project root
      // rather than whatever the harness happens to have open. `realpath`
      // because Windows hands out 8.3 temp paths that would not relativize.
      dir = fs.realpathSync.native(makeTempDir());
      // The harness builds one atom environment for the whole run, so the root
      // has to go back afterwards: the outer afterEach deletes this directory
      // and every later spec would be left with a project pointing at it.
      previousProjectPaths = atom.project.getPaths();
      atom.project.setPaths([dir]);
    });

    afterEach(() => {
      const session = activeSession();
      if (session) session.cancel("api");
      mainModule.clearCompileOnSaveFiles();
      atom.project.setPaths(previousProjectPaths);
    });

    it("lists every observed file with its output path", async () => {
      observe("a.typ");
      observe("b.typ");
      await openList();

      expect(modalElement().dataset.modalView).toBe("typst-tools.observed-files");
      expect(visibleLabels()).toEqual(["a.typ", "b.typ"]);
      const details = Array.from(modalElement().querySelectorAll(".secondary-line")).map(
        (line) => line.textContent,
      );
      expect(details).toEqual(["Output: a.pdf", "Output: b.pdf"]);
    });

    it("opens the focused file on confirm", async () => {
      const files = [observe("a.typ"), observe("b.typ")];
      spyOn(atom.workspace, "open").and.callFake(() => Promise.resolve());
      await openList();

      confirm();
      await settle();

      expect(atom.workspace.open).toHaveBeenCalledWith(files[0], { searchAllPanes: true });
      expect(activeSession()).toBe(null);
    });

    it("binds ctrl-d to the unobserve action while the list is open", async () => {
      observe("a.typ");
      await openList();

      const keystrokes = atom.keymaps
        .findKeyBindings({ command: "modals:unobserve-file", target: modalElement() })
        .map((binding) => binding.keystrokes);
      expect(keystrokes).toContain("ctrl-d");
    });

    it("stops observing the focused file and stays open", async () => {
      const files = [observe("a.typ"), observe("b.typ")];
      await openList();

      dispatch("modals:unobserve-file");
      await settle();

      expect(mainModule.isCompileOnSaveEnabledForFile(files[0])).toBe(false);
      expect(mainModule.getCompileOnSaveFiles()).toEqual([files[1]]);
      expect(activeSession()).not.toBe(null);
      expect(visibleLabels()).toEqual(["b.typ"]);
    });

    it("closes once the last observed file is unobserved", async () => {
      observe("a.typ");
      await openList();

      dispatch("modals:unobserve-file");
      await settle();

      expect(mainModule.getCompileOnSaveFiles()).toEqual([]);
      expect(activeSession()).toBe(null);
    });

    it("re-reads an open list when every file is cleared at once", async () => {
      observe("a.typ");
      observe("b.typ");
      await openList();
      expect(visibleItems().length).toBe(2);

      mainModule.clearCompileOnSaveFiles();
      await settle();

      expect(activeSession()).not.toBe(null);
      expect(visibleItems()).toEqual([]);
    });
  });

  describe("status bar integration", () => {
    it("adds left and right tiles through the status-bar service", () => {
      const left = [];
      const right = [];
      mainModule.consumeStatusBar({
        addLeftTile(tile) {
          left.push(tile);
          return { destroy() {} };
        },
        addRightTile(tile) {
          right.push(tile);
          return { destroy() {} };
        },
      });
      expect(left.length).toBe(1);
      expect(left[0].item.classList.contains("typst-tools-status")).toBe(true);
      expect(right.length).toBe(1);
      expect(right[0].item.classList.contains("typst-tools-observed-status")).toBe(true);
    });

    it("reflects build status through element classes", () => {
      const view = mainModule.statusBarView;
      view.setStatus("building", "", { skipTimer: true });
      expect(view.element.classList.contains("status-building")).toBe(true);
      view.setStatus("success");
      expect(view.element.classList.contains("status-success")).toBe(true);
      expect(view.element.classList.contains("status-building")).toBe(false);
      view.setStatus("error");
      expect(view.element.classList.contains("status-error")).toBe(true);
      view.setStatus("idle");
      expect(view.element.classList.contains("status-idle")).toBe(true);
    });

    it("marks the label when compile-on-save is enabled", () => {
      const view = mainModule.statusBarView;
      view.setCompileOnSave(true);
      expect(view.label.textContent).toBe("Typ*");
      view.setCompileOnSave(false);
      expect(view.label.textContent).toBe("Typ");
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
