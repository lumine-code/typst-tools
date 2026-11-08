const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const manifest = require("../package.json");

describe("Typst document commands with shared Tasks controls", () => {
  let main, directory, editor, sourcePath, pdfPath, pdfElement, pdfItem;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "typst-document-")));
    sourcePath = path.join(directory, "document.typ");
    pdfPath = path.join(directory, "document.pdf");
    await fs.writeFile(sourcePath, "source\n");
    await fs.writeFile(pdfPath, "owned path fixture\n");
    editor = await lumine.workspace.open(sourcePath);
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    spyOn(main, "runCompilation").and.returnValue(true);
    pdfElement = document.createElement("div");
    pdfElement.tabIndex = -1;
    pdfItem = { filePath: pdfPath, getTitle: () => "PDF", getElement: () => pdfElement };
  });

  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
    await lumine.packages.deactivatePackage("typst-tools");
    editor?.destroy();
    const pane = lumine.workspace.getCenter().paneForItem(pdfItem);
    if (pane) await pane.destroyItem(pdfItem, true);
    await lumine.fileWatchClient.settlePendingTeardown();
    const resolved = await fs.realpath(directory);
    const relative = path.relative(await fs.realpath(os.tmpdir()), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe Typst document fixture cleanup");
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function showPdf() {
    lumine.workspace.getCenter().getActivePane().activateItem(pdfItem);
    pdfElement.focus();
  }

  it("delegates status presentation to Tasks without registering provider icons", () => {
    expect(manifest.consumedServices["status-bar"]).toBeUndefined();
    expect(document.querySelector(".typst-tools-status")).toBeNull();
    expect(document.querySelector(".typst-tools-observed-status")).toBeNull();
    expect(main.consumeStatusBar).toBeUndefined();
  });

  it("compiles the focused PDF source even when its source editor is closed", async () => {
    showPdf();
    editor.destroy();
    await lumine.commands.dispatch(pdfElement, "typst-tools:compile");
    expect(main.runCompilation).toHaveBeenCalledOnceWith(sourcePath);
  });

  it("uses the saved PDF context while another document is active", async () => {
    const other = await lumine.workspace.open(undefined, { split: "right" });
    try {
      await main.compile({ context: { documentItem: pdfItem, embeddedEditor: null } });
      expect(main.runCompilation).toHaveBeenCalledOnceWith(sourcePath);
      expect(lumine.workspace.getActiveTextEditor()).toBe(other);
    } finally {
      other.destroy();
    }
  });

  it("toggles observation for the focused PDF source", async () => {
    showPdf();
    const observe = spyOn(main, "setCompileOnSaveForFile").and.returnValue(true);
    await lumine.commands.dispatch(pdfElement, "typst-tools:watch");
    expect(observe).toHaveBeenCalledOnceWith(sourcePath, true);
  });

  it("splits the source from a PDF into the invoking document pane", async () => {
    showPdf();
    const pane = lumine.workspace.getCenter().getActivePane();
    const open = spyOn(lumine.workspace, "open").and.resolveTo();
    await lumine.commands.dispatch(pdfElement, "typst-tools:split-pdf-source");
    expect(open).toHaveBeenCalledOnceWith(sourcePath, {
      split: "left",
      searchAllPanes: true,
      pane,
    });
  });

  it("splits the output from an editor into the invoking document pane", async () => {
    const pane = lumine.workspace.paneForItem(editor);
    const associate = spyOn(main.build, "associateArtifact").and.returnValue(true);
    const open = spyOn(lumine.workspace, "open").and.callFake(() => {
      expect(associate).toHaveBeenCalledOnceWith(
        { providerId: "typst-tools", filePath: sourcePath },
        pdfPath,
      );
      return Promise.resolve();
    });
    await lumine.commands.dispatch(editor.getElement(), "typst-tools:split-pdf-source");
    expect(open).toHaveBeenCalledOnceWith(pdfPath, {
      split: "right",
      searchAllPanes: true,
      pane,
    });
  });

  it("associates an existing PDF with its closed source without a previous build", async () => {
    editor.destroy();
    const associate = spyOn(main.build, "associateArtifact").and.returnValue(true);
    const open = spyOn(lumine.workspace, "open").and.callFake(() => {
      expect(associate).toHaveBeenCalledOnceWith(
        { providerId: "typst-tools", filePath: sourcePath },
        pdfPath,
      );
      return Promise.resolve({});
    });
    expect(main.build.getJobs({ providerId: "typst-tools" })).toEqual([]);

    main.openPdf({ context: { documentItem: pdfItem, embeddedEditor: null } });
    await open.calls.mostRecent().returnValue;

    expect(open).toHaveBeenCalledOnceWith(pdfPath, { searchAllPanes: true });
  });

  it("stops and clears only the focused PDF's source build", async () => {
    showPdf();
    spyOn(main, "isBuilding").and.returnValue(true);
    const stop = spyOn(main, "interruptFile").and.returnValue(true);
    const clear = spyOn(main.build, "clearMessages");
    await lumine.commands.dispatch(pdfElement, "typst-tools:stop-and-clear-diagnostics");
    expect(stop).toHaveBeenCalledOnceWith(sourcePath);
    expect(clear).toHaveBeenCalledOnceWith({ providerId: "typst-tools", filePath: sourcePath });
  });

  it("uses the invoking document's embedded source editor", async () => {
    const element = document.createElement("div");
    const item = {
      getTitle: () => "Embedded source",
      getElement: () => element,
      getActiveEmbeddedTextEditor: () => editor,
    };
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.activateItem(item);
    try {
      await lumine.commands.dispatch(element, "typst-tools:compile");
      expect(main.runCompilation).toHaveBeenCalledOnceWith(sourcePath);
    } finally {
      pane.activateItem(editor);
      await pane.destroyItem(item, true);
    }
  });
});
