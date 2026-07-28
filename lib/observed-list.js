const path = require("path");
const { getOutputPath } = require("./utils");

const VIEW_ID = "typst-tools.observed-files";

// The compile-on-save watch list. The modal itself belongs to `atom.modals`;
// what is left here is building the items and saying what Enter and Ctrl+D do.
module.exports = class ObservedFilesList {
  constructor(mainModule) {
    this.mainModule = mainModule;
    this.session = null;
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
    const [projectPath, relativePath] = atom.project.relativizePath(filePath);
    if (projectPath && relativePath) {
      return relativePath;
    }
    return filePath;
  }

  show() {
    this.session = atom.modals.open({
      id: VIEW_ID,
      className: "typst-tools-observed-files-list",
      placeholder: "Observed compile-on-save files...",
      emptyMessage: "No files observed for compile-on-save",
      // Read on every run rather than cached, so the list is current each time
      // it opens and after each unobserve.
      source: () => this.buildItems(),
      help:
        "Available commands:\n" +
        "- **Enter**: Open file\n" +
        "- **Ctrl+D**: Stop observing selected file",
      renderer: {
        entry: (item) => ({ id: item.filePath, text: item.displayPath }),
        row: (item) => ({
          label: item.displayPath,
          detail: `Output: ${item.outputDisplayPath}`,
          icon: ["icon-file-text"],
        }),
      },
      actions: [
        {
          name: "confirm",
          label: "Open file",
          // Declared `when: "item"` so confirming an empty list closes rather
          // than opening `undefined`.
          when: "item",
          run: async ({ item }) => {
            await atom.workspace.open(item.filePath, { searchAllPanes: true });
          },
        },
        {
          name: "unobserve-file",
          label: "Stop observing selected file",
          keystroke: "ctrl-d",
          run: ({ item }) => this.unobserve(item),
        },
      ],
      didClose: () => {
        this.session = null;
      },
    });
  }

  unobserve(item) {
    this.mainModule.setCompileOnSaveForFile(item.filePath, false);
    atom.notifications.addInfo(`Stopped observing ${path.basename(item.filePath)}`);
    // Unobserving the last file leaves nothing to list, so the modal closes
    // instead of standing there empty. Otherwise it stays open and re-reads the
    // observed set; the kernel keeps the focus where the removed row was.
    const remaining = this.mainModule.getCompileOnSaveFiles().length > 0;
    return { keepOpen: remaining, refresh: remaining };
  }

  // Re-reads the observed set into an open list; a no-op when it is closed.
  refresh() {
    if (this.session) this.session.refresh();
  }

  destroy() {
    if (this.session) this.session.cancel("api");
  }
};
