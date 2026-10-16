const path = require("node:path");
describe("typst-tools command availability", () => {
  let main, editor;
  const can = (name) =>
    lumine.commands.canDispatch(lumine.workspace.getElement(), "typst-tools:" + name);
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
  });
  afterEach(async () => {
    main.buildProcesses.clear();
    main.compileOnSaveFiles.clear();
    editor?.destroy();
    await lumine.packages.deactivatePackage("typst-tools");
  });
  it("keeps setup and view openers available in an empty workspace", () => {
    for (const name of [
      "compile",
      "interrupt",
      "interrupt-all",
      "watch",
      "clear-all-observed-files",
      "clean-linter",
    ])
      expect(can(name)).toBeFalse();
    expect(can("observed-files")).toBeTrue();
    expect(can("install-typst")).toBeTrue();
  });
  it("uses only cached file and process metadata for document actions", async () => {
    editor = await lumine.workspace.open();
    expect(can("compile")).toBeFalse();
    editor.getBuffer().setPath(path.join(process.cwd(), "availability.typ"));
    const source = editor.getPath();
    const expensive = spyOn(main, "resolveTypstPath").and.throwError(
      "availability must stay passive",
    );
    const text = spyOn(editor, "getText").and.callThrough();
    expect(can("compile")).toBeTrue();
    expect(can("interrupt")).toBeFalse();
    const buildPath = source;

    main.buildProcesses.set(buildPath, {});
    expect(can("compile")).toBeFalse();
    expect(can("interrupt")).toBeTrue();
    expect(can("interrupt-all")).toBeTrue();
    expect(can("watch")).toBeTrue();
    expect(expensive).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(main.observedFilesList).toBeNull();
    main.compileOnSaveFiles.set(source, {});
    expect(can("clear-all-observed-files")).toBeTrue();
    editor.getBuffer().setPath(path.join(process.cwd(), "unrelated.txt"));
    expect(can("compile")).toBeFalse();
    expect(can("interrupt")).toBeFalse();
  });
  it("does not borrow another window's source for an explicitly empty context", async () => {
    editor = await lumine.workspace.open();
    editor.getBuffer().setPath(path.join(process.cwd(), "availability.typ"));
    expect(
      main.isCommandAvailable({ target: lumine.workspace.getElement(), context: {} }, "compile"),
    ).toBeFalse();
  });
});
