const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

describe("typst-tools status menus", () => {
  let main, directory, editor, tile, counter, tooltipCalls;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    tooltipCalls = spyOn(lumine.tooltips, "add").and.callThrough();
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "typst-tools-status-")));
    await fs.writeFile(path.join(directory, "document.typ"), "source");
    editor = await lumine.workspace.open(path.join(directory, "document.typ"));
    editor.getElement().focus();
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    main.ensureStatusBarViews();
    tile = main.statusBarView.getElement();
    counter = main.observedFilesStatusView.getElement();
    lumine.workspace.getElement().append(tile, counter);
    spyOn(main, "runCompilation").and.returnValue(true);
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
    await lumine.packages.deactivatePackage("typst-tools");
    editor?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(await fs.realpath(directory)) !== (await fs.realpath(os.tmpdir())) ||
      !path.basename(directory).startsWith("typst-tools-status-")
    )
      throw Error("Unsafe status fixture cleanup");
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  function menu(element = tile) {
    return lumine.contextMenu.templateForElement(element);
  }
  it("lists every mouse action and reads observation state when opened", () => {
    const before = menu();
    expect(before.filter((item) => item.command).map((item) => item.command)).toEqual([
      "typst-tools:compile",
      "typst-tools:watch",
      "typst-tools:split-pdf-source",
      "typst-tools:stop-and-clear-diagnostics",
    ]);
    expect(before.find((item) => item.command === "typst-tools:watch").checked).toBe(false);
    spyOn(main, "isCompileOnSaveEnabledForFile").and.returnValue(true);
    expect(menu(tile.firstChild).find((item) => item.command === "typst-tools:watch").checked).toBe(
      true,
    );
    expect(main.runCompilation).not.toHaveBeenCalled();
    const options = tooltipCalls.calls.all().find((call) => call.args[0] === tile).args[1];
    expect(options.keyBindingCommand).toBe("typst-tools:compile");
    expect(options.keyBindingTarget()).toBe(editor.getElement());
    expect(options.html).toBe(false);
    expect(options.keyBindingExtra).toBeUndefined();
    expect(options.title()).toBe("Idle. Compile this document.");
    main.statusBarView.setStatus("building");
    expect(options.title()).toBe("Building. Compile this document.");
    const counterOptions = tooltipCalls.calls.all().find((call) => call.args[0] === counter)
      .args[1];
    expect(counterOptions.keyBindingCommand).toBe("typst-tools:observed-files");
    expect(counterOptions.keyBindingTarget).toBe(counter);
    expect(counterOptions.keyBindingExtra).toBeUndefined();
    main.observedFilesStatusView.setCount(2);
    expect(counterOptions.title()).toBe("2 observed files. Open the list.");
  });
  it("shows the package's real editor-scoped shortcuts from the status menu", () => {
    // Exercise the shipped keymap against its real editor scope without requiring a parser fixture.
    editor.getElement().setAttribute("data-grammar", "typst");
    const items = menu(tile.firstChild);
    expect(items.find((item) => item.command === "typst-tools:compile").keyBindingLabel).toBe("F5");
    expect(items.find((item) => item.command === "typst-tools:watch").keyBindingLabel).toBe(
      process.platform === "darwin" ? "\u2325F5" : "Alt+F5",
    );
    expect(
      items.find((item) => item.command === "typst-tools:stop-and-clear-diagnostics")
        .keyBindingLabel,
    ).toBeUndefined();
  });
  it("shows user-assigned editor shortcuts for splitting and stopping the document", async () => {
    editor.getElement().setAttribute("data-grammar", "typst");
    const commands = ["split-pdf-source", "stop-and-clear-diagnostics"];
    const userBindings = lumine.keymaps.add("typst-tools-status-user-shortcuts", {
      'lumine-text-editor[data-grammar~="typst"]:not([mini])': {
        f9: "typst-tools:split-pdf-source",
        f10: "typst-tools:stop-and-clear-diagnostics",
      },
    });
    try {
      const extra = await lumine.workspace.openEditorWindow({ show: false });
      const other = lumine.workspace.buildTextEditor();
      extra.getEditorContainer().getActivePane().activateItem(other, { activatePane: true });
      expect(lumine.workspace.getActiveTextEditor()).toBe(other);
      const row = (items, command) =>
        items.find((item) => item.command === "typst-tools:" + command);
      const items = menu();
      for (const [index, command] of commands.entries())
        expect(row(items, command).keyBindingLabel).toBe("F" + (9 + index));
      const element = document.createElement("div");
      element.tabIndex = -1;
      const pdf = {
        filePath: editor.getPath().replace(/\.typ$/, ".pdf"),
        getTitle: () => "PDF",
        getElement: () => element,
      };
      const pane = lumine.workspace.getMainWindow().getEditorContainer().getActivePane();
      pane.activateItem(pdf);
      element.focus();
      const pdfMenu = menu();
      for (const command of commands) {
        expect(row(pdfMenu, command).keyBindingLabel).toBeUndefined();
        expect(row(pdfMenu, command).enabled).toBe(true);
      }
      await pane.destroyItem(pdf);
    } finally {
      userBindings.dispose();
    }
  });
  it("keeps shortcut lookup in the tile's window and suppresses it for a PDF", async () => {
    editor.getElement().setAttribute("data-grammar", "typst");
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const other = lumine.workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(other, { activatePane: true });
    expect(lumine.workspace.getActiveTextEditor()).toBe(other);
    expect(menu().find((item) => item.command === "typst-tools:compile").keyBindingLabel).toBe(
      "F5",
    );
    const element = document.createElement("div");
    element.tabIndex = -1;
    const item = {
      filePath: editor.getPath().replace(/\.typ$/, ".pdf"),
      getTitle: () => "PDF",
      getElement: () => element,
    };
    const container = lumine.workspace.getMainWindow().getEditorContainer();
    container.getActivePane().activateItem(item);
    element.focus();
    const items = menu();
    for (const command of ["compile", "watch"])
      expect(items.find((item) => item.command === "typst-tools:" + command).keyBindingLabel).toBe(
        command === "compile" ? "" : undefined,
      );
    expect(items.find((item) => item.command === "typst-tools:compile").enabled).toBe(true);
    await container.getActivePane().destroyItem(item);
  });
  it("compiles the PDF source through the real status popup while preserving the focused target", async () => {
    const element = document.createElement("div");
    element.tabIndex = -1;
    const pdf = {
      filePath: editor.getPath().replace(/\.typ$/, ".pdf"),
      getTitle: () => "PDF",
      getElement: () => element,
    };
    const pane = lumine.workspace.getMainWindow().getEditorContainer().getActivePane();
    const compile = spyOn(main, "compileFromStatusBar").and.callThrough();
    pane.activateItem(pdf);
    element.focus();
    const popup = lumine.contextMenu.show(tile, menu());
    try {
      popup.rootList.items
        .find((item) => item.template.command === "typst-tools:compile")
        .activate();
      await conditionPromise(() => main.runCompilation.calls.count() > 0);
      expect(main.runCompilation).toHaveBeenCalledOnceWith(editor.getPath());
      expect(compile.calls.mostRecent().args[0].target).toBe(element);
      expect(compile.calls.mostRecent().args[0].detail.fromStatusBar).toBe(true);
    } finally {
      popup.close();
      await pane.destroyItem(pdf, true);
    }
  });
  it("resolves the primary keyboard hint from the tile's current editor", async () => {
    const options = tooltipCalls.calls.all().find((call) => call.args[0] === tile).args[1];
    const other = await lumine.workspace.open();
    expect(options.keyBindingTarget()).toBe(other.getElement());
    spyOn(lumine.workspace, "resolveCommandContext").and.returnValue({ embeddedEditor: null });
    expect(options.keyBindingTarget()).toBeNull();
    other.destroy();
  });
  it("opens right-click menus without executing or blocking an action", () => {
    const stop = spyOn(main, "killAndCleanFromStatusBar");
    const clear = spyOn(main, "clearCompileOnSaveFiles");
    for (const element of [tile, counter]) {
      element.remove();
      element.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
      const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(stop).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(main.runCompilation).not.toHaveBeenCalled();
    expect(
      menu(counter)
        .filter((item) => item.command)
        .map((item) => item.command),
    ).toEqual(["typst-tools:observed-files", "typst-tools:clear-all-observed-files"]);
  });
  it("uses the same split command for middle click and the menu", async () => {
    const open = spyOn(main, "openPdfFromStatusBar");
    tile.dispatchEvent(new MouseEvent("mousedown", { button: 1, bubbles: true }));
    expect(open.calls.count()).toBe(1);
    expect(open.calls.mostRecent().args[0].context.embeddedEditor).toBe(editor);
    await lumine.commands.dispatch(tile, "typst-tools:split-pdf-source");
    expect(open.calls.count()).toBe(2);
    expect(open.calls.mostRecent().args[0].context.embeddedEditor).toBe(editor);
  });
  it("observes and compiles the PDF source without another active text editor", async () => {
    const context = {
      embeddedEditor: null,
      documentItem: { filePath: editor.getPath().replace(/\.typ$/, ".pdf") },
    };
    const event = { target: tile, context };
    const observe = spyOn(main, "setCompileOnSaveForFile").and.returnValue(true);
    main.toggleCompileOnSave(event);
    expect(observe.calls.mostRecent().args[0]).toBe(editor.getPath());
    expect(observe.calls.mostRecent().args[1]).toBe(true);
    await main.compileFromStatusBar(event);
    expect(main.runCompilation).toHaveBeenCalledOnceWith(editor.getPath());
  });
  it("captures the invoking window's editor before compiling", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const other = lumine.workspace.buildTextEditor();
    other.getBuffer().setPath(path.join(directory, "other.typ"));
    extra.getEditorContainer().getActivePane().activateItem(other, { activatePane: true });
    extra.getElement().append(tile);
    const compile = spyOn(main, "compile").and.resolveTo();
    await lumine.commands.dispatch(tile, "typst-tools:compile");
    expect(compile.calls.mostRecent().args[0].context.embeddedEditor).toBe(other);
  });
  it("uses the document's embedded editor from a tile command", async () => {
    const element = document.createElement("div");
    const embeddedItem = {
      getTitle: () => "Embedded source",
      getElement: () => element,
      getActiveEmbeddedTextEditor: () => editor,
    };
    lumine.workspace.getActivePane().activateItem(embeddedItem);
    const compile = spyOn(main, "compile").and.resolveTo();
    await lumine.commands.dispatch(tile, "typst-tools:compile");
    expect(compile.calls.mostRecent().args[0].context.embeddedEditor).toBe(editor);
    lumine.workspace.getActivePane().destroyItem(embeddedItem);
  });
  it("disposes runtime menu registrations when deactivated", async () => {
    await lumine.packages.deactivatePackage("typst-tools");
    const dispatch = spyOn(lumine.commands, "dispatch").and.resolveTo();
    tile.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    counter.click();
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      lumine.contextMenu.itemSets.some(
        (set) => set.selector === "status-bar-tile.typst-tools-status",
      ),
    ).toBe(false);
  });
});
