const { Icon } = require("lumine");

describe("typst-tools item actions", () => {
  let list, iconRegistration;

  const item = {
    filePath: "C:\\project\\document.typ",
    outputDisplayPath: "document.pdf",
    displayPath: "document.typ",
  };

  function setItems(items) {
    list.items = items;
    return list.selectList.setItems(items);
  }

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pkg = await lumine.packages.activatePackage("typst-tools");
    list = pkg.mainModule.observedFilesList;
  });

  afterEach(async () => {
    iconRegistration?.dispose();
    await lumine.packages.deactivatePackage("typst-tools");
  });

  it("routes observed file paths through the shared icon registry", async () => {
    await setItems([item]);
    const line = list.selectList.getElement().querySelector(".primary-line");
    expect(line).toHaveClass("icon-file-text");

    iconRegistration = lumine.icons.addProvider(
      {
        id: "typst-tools-observed-files-spec",
        handles: ["path"],
        usesContext: true,
        iconFor(target) {
          return target.context === "typst-tools-observed-files"
            ? Icon.classes(["icon-flame"])
            : null;
        },
      },
      { priority: 100 },
    );
    expect(line).toHaveClass("icon-flame");
  });

  it("derives its item and list actions from command registrations and the keymap", () => {
    list.selectListHost.getPanel();
    setItems([item]);
    const actions = list.selectList.getAvailableActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    expect(actions.map((action) => action.command)).toEqual([
      "typst-tools:open-selected-file",
      "typst-tools:unobserve-selected-file",
      "typst-tools:clear-all-observed-files",
    ]);

    const open = byCommand.get("typst-tools:open-selected-file");
    expect(open.name).toBe("Open Selected File");
    expect(open.description).toBe(
      "Open the selected observed file, reusing its pane if it is already open.",
    );
    expect(open.primary).toBe(true);
    expect(open.context).toBe("item");

    const unobserve = byCommand.get("typst-tools:unobserve-selected-file");
    expect(unobserve.name).toBe("Unobserve Selected File");
    expect(unobserve.description).toBe(
      "Stop compiling the selected file on save and drop it from this list.",
    );
    expect(unobserve.keystrokes).toEqual(["ctrl-d"]);
    expect(unobserve.context).toBe("item");

    const clear = byCommand.get("typst-tools:clear-all-observed-files");
    expect(clear.description).toBe("Stop building every file that was set to build on save.");
    expect(clear.keystrokes).toEqual([]);
    expect(clear.context).toBe("dialog");
    expect(clear.tone).toBe("danger");
    expect(list.selectList.getItemId(item)).toBe(item.filePath);
  });

  it("keeps only Clear All without a selection and hides it when the source is empty", () => {
    setItems([item]);
    list.selectList.setItems([]);

    expect(list.selectList.getAvailableActions().map((action) => action.command)).toEqual([
      "typst-tools:clear-all-observed-files",
    ]);

    setItems([]);
    expect(list.selectList.getAvailableActions()).toEqual([]);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    await list.show();
    await setItems([item]);

    await list.selectListHost.showActions();

    expect(lumine.workspace.getModalTrail()).toEqual(["Observed Files", "Actions"]);

    const spy = spyOn(list, "unobserveSelectedFile");
    lumine.workspace.popModal();
    await list.selectList.runAction("typst-tools:unobserve-selected-file");

    expect(spy).toHaveBeenCalled();
    expect(list.selectListHost.isVisible()).toBeTruthy();
  });
});
