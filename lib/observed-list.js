const { getOutputPath } = require("./utils");
const { CompositeDisposable, Disposable } = require("lumine");

module.exports = class ObservedFilesList {
  constructor(mainModule) {
    this.mainModule = mainModule;
    this.window = lumine.workspace.getFocusedWindow() ?? lumine.workspace.getMainWindow();
    this.items = [];

    this.selectListHost = lumine.workspace.addSelectList(
      {
        emptyMessage: "No files observed for compile-on-save",
        placeholderText: "Observed compile-on-save files...",
        getItemId: (item) => item.filePath,
        source: { mode: "snapshot", load: () => this.loadItems() },
        search: { getFilterText: (item) => item.displayPath },
        renderItem: (item, { filterKey, highlight }) => {
          return {
            primary: highlight(filterKey),
            secondary: `Output: ${item.outputDisplayPath}`,
            didRender: (element) => {
              const icon = lumine.icons.applyTo(
                element.querySelector(".primary-line"),
                {
                  path: item.filePath,
                  context: "typst-tools-observed-files",
                  hints: { directory: false },
                },
                { setData: false },
              );
              const listener = (event) => this.openItemOnModifiedClick(event, item);
              element.addEventListener("click", listener, true);
              return new CompositeDisposable(
                icon,
                new Disposable(() => element.removeEventListener("click", listener, true)),
              );
            },
          };
        },
        commands: {
          "typst-tools:open-selected-file": {
            description: "Open the selected observed file, reusing its pane if it is already open.",
            didDispatch: (event) => this.openSelectedFile(event.detail.item),
          },
          "typst-tools:open-with": {
            description: "Choose how and where to open the selected observed file.",
            didDispatch: (event) => this.performPathAction(event.detail, "open-with"),
          },
          "typst-tools:open-external": {
            description: "Open the observed file in the configured external application.",
            didDispatch: (event) => this.performPathAction(event.detail, "open-external"),
          },
          "typst-tools:show-in-folder": {
            description: "Reveal the observed file in the system file manager.",
            didDispatch: (event) => this.performPathAction(event.detail, "show-in-folder"),
          },
          "typst-tools:unobserve-selected-file": {
            description: "Stop compiling the selected file on save and drop it from this list.",
            didDispatch: (event) => this.unobserveSelectedFile(event.detail.item),
          },
        },
        actions: [
          {
            command: "typst-tools:open-selected-file",
            context: "item",
            primary: true,
            group: "File",
            disposition: "close",
            dispatch: "local",
          },
          {
            command: "typst-tools:open-with",
            context: "item",
            group: "File",
            disposition: "push",
            dispatch: "local",
          },
          {
            command: "typst-tools:open-external",
            context: "item",
            group: "File",
            disposition: "close",
            dispatch: "local",
          },
          {
            command: "typst-tools:show-in-folder",
            context: "item",
            group: "File",
            disposition: "close",
            dispatch: "local",
          },
          {
            command: "typst-tools:unobserve-selected-file",
            context: "item",
            group: "File",
            disposition: "stay",
            dispatch: "local",
          },
          {
            command: "typst-tools:clear-all-observed-files",
            context: "dialog",
            when: () => this.items.length > 0,
            group: "All Files",
            tone: "danger",
            disposition: "stay",
            dispatch: "workspace",
          },
        ],
      },
      {
        window: this.window,
        className: "typst-tools-observed-files-list",
        crumb: "Observed Files",
      },
    );
    this.selectList = this.selectListHost.getModel();
  }

  buildItems() {
    return this.mainModule.getCompileOnSaveFiles().map((filePath) => {
      const outputPath = getOutputPath(filePath);
      return {
        filePath,
        outputPath,
        displayPath: this.displayPath(filePath),
        outputDisplayPath: this.displayPath(outputPath),
      };
    });
  }

  displayPath(filePath) {
    const [projectPath, relativePath] = lumine.project.relativizePath(filePath);
    if (projectPath && relativePath) {
      return relativePath;
    }
    return filePath;
  }

  loadItems() {
    this.items = this.buildItems();
    return this.items;
  }

  async update(initialSelectionIndex = null) {
    await this.selectList.setItems(this.loadItems());
    if (initialSelectionIndex != null && this.items.length > 0) {
      await this.selectList.selectIndex(Math.min(initialSelectionIndex, this.items.length - 1));
    }
  }

  openSelectedFile(item = null) {
    item ??= this.selectList.getSelectedItem();
    if (!item) {
      return;
    }

    return lumine.workspace.open(item.filePath, {
      pane: this.window.getEditorContainer().getActivePane(),
      pending: lumine.config.get("core.allowPendingPaneItems"),
      searchAllPanes: true,
    });
  }

  openItemOnModifiedClick(event, item) {
    if (event.button !== 0 || (!event.altKey && !event.shiftKey)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void this.selectList.selectItemById(item.filePath);
    if (!event.altKey) return;
    const command = event.ctrlKey
      ? "typst-tools:open-external"
      : event.shiftKey
        ? "typst-tools:show-in-folder"
        : "typst-tools:open-with";
    void this.selectList.runAction(command).catch(() => {});
  }

  performPathAction(context, mode) {
    const item = context.item ?? this.selectList.getSelectedItem();
    if (!item) return;
    context.signal?.throwIfAborted();
    if (mode === "open-with") {
      const opening = lumine.commands.dispatch(this.window.getElement(), "open-with:toggle", {
        path: item.filePath,
      });
      if (!opening) throw new Error("The Open With package is not available.");
      return opening;
    }
    const opener = mode === "open-external" ? "open-external" : "open-external:show";
    return lumine.workspace.open(item.filePath, {
      pane: this.window.getEditorContainer().getActivePane(),
      pathKind: "file",
      opener,
      signal: context.signal,
    });
  }

  async unobserveSelectedFile(item = this.selectList.getSelectedItem()) {
    if (!item) {
      return;
    }

    const index = this.selectList.getSelectedIndex() ?? 0;
    this.mainModule.setCompileOnSaveForFile(item.filePath, false);

    await this.update(Math.max(0, Math.min(index, this.items.length - 2)));
    if (this.items.length === 0) {
      this.selectListHost.hide();
    }
  }

  show() {
    return this.selectListHost.show();
  }

  toggle() {
    return this.selectListHost.toggle();
  }

  destroy() {
    return this.selectListHost.destroy();
  }
};
