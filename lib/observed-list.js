const path = require("path");
const { getOutputPath } = require("./utils");

module.exports = class ObservedFilesList {
  constructor(mainModule) {
    this.mainModule = mainModule;
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
            didRender: (element) =>
              lumine.icons.applyTo(
                element.querySelector(".primary-line"),
                {
                  path: item.filePath,
                  context: "typst-tools-observed-files",
                  hints: { directory: false },
                },
                { setData: false },
              ),
          };
        },
        commands: {
          "typst-tools:open-selected-file": {
            description: "Open the selected observed file, reusing its pane if it is already open.",
            didDispatch: (event) => this.openSelectedFile(event.detail.item),
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
      { className: "typst-tools-observed-files-list", crumb: "Observed Files" },
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

    return lumine.workspace.open(item.filePath, { searchAllPanes: true });
  }

  async unobserveSelectedFile(item = this.selectList.getSelectedItem()) {
    if (!item) {
      return;
    }

    const index = this.selectList.getSelectedIndex() ?? 0;
    this.mainModule.setCompileOnSaveForFile(item.filePath, false);
    lumine.notifications.addHint(`Stopped observing ${path.basename(item.filePath)}`);

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
