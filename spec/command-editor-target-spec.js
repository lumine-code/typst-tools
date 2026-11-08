const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

describe("Typst compile command editor target", () => {
  let main, first, second, directory, temporary, files;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.clipboard, "write");
    spyOn(childProcess, "spawn").and.throwError("No compiler process is permitted");
    spyOn(childProcess, "execFileSync").and.throwError("No executable lookup is permitted");
    temporary = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "typst-target-owned-")));
    files = ["first.typ", "second.typ"].map((name) => path.join(directory, name));
    for (const file of files) fs.writeFileSync(file, "original");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    spyOn(main, "runCompilation").and.returnValue(true);
    first = await lumine.workspace.open(files[0]);
    second = await lumine.workspace.open(files[1], { split: "right" });
    first.setText("first accepted save");
    second.setText("second accepted save");
  });
  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("typst-tools"))
      await lumine.packages.unloadPackage("typst-tools");
    first?.destroy();
    second?.destroy();
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(fs.realpathSync.native(directory)) !== temporary ||
      !path.basename(directory).startsWith("typst-target-owned-")
    )
      throw Error("Unsafe Typst target fixture cleanup");
    for (const file of files) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  it("saves and submits the dispatch editor while another pane remains active", async () => {
    await lumine.commands.dispatch(first.element, "typst-tools:compile");
    expect(lumine.workspace.getActiveTextEditor()).toBe(second);
    expect(fs.readFileSync(files[0], "utf8")).toBe("first accepted save");
    expect(fs.readFileSync(files[1], "utf8")).toBe("original");
    expect(main.runCompilation).toHaveBeenCalledOnceWith(files[0]);
  });
  it("uses the active file for a workspace command", async () => {
    await lumine.commands.dispatch(lumine.workspace.getElement(), "typst-tools:compile");
    expect(fs.readFileSync(files[0], "utf8")).toBe("original");
    expect(fs.readFileSync(files[1], "utf8")).toBe("second accepted save");
    expect(main.runCompilation).toHaveBeenCalledOnceWith(files[1]);
  });
  it("watches the dispatch editor instead of the active file", async () => {
    await lumine.commands.dispatch(first.element, "typst-tools:watch");
    expect(main.isCompileOnSaveEnabledForFile(files[0])).toBe(true);
    expect(main.isCompileOnSaveEnabledForFile(files[1])).toBe(false);
  });

  it("reports the saved target's compile-on-save policy and refreshes aliases after direct changes", () => {
    const state = (target) => lumine.commands.getCommandState("typst-tools:watch", { target });
    const invalidate = spyOn(lumine.commands, "invalidateAvailability").and.callThrough();
    expect(state(first.element)).toEqual({ type: "checkbox", checked: false });
    expect(main.setCompileOnSaveForFile(files[0], true)).toBe(true);
    expect(invalidate).toHaveBeenCalled();
    expect(lumine.workspace.getActiveTextEditor()).toBe(second);
    expect(state(first.element)).toEqual({ type: "checkbox", checked: true });
    expect(state(second.element)).toEqual({ type: "checkbox", checked: false });

    invalidate.calls.reset();
    main.clearCompileOnSaveFiles();
    expect(invalidate).toHaveBeenCalled();
    expect(state(first.element)).toEqual({ type: "checkbox", checked: false });
    expect(main.runCompilation).not.toHaveBeenCalled();
  });
  it("opens the output belonging to the dispatch editor", async () => {
    const outputs = files.map((file) => file.replace(/\.typ$/, ".pdf"));
    for (const output of outputs) fs.writeFileSync(output, "owned output placeholder");
    spyOn(main, "_openPdfDirect").and.resolveTo();
    try {
      await lumine.commands.dispatch(first.element, "typst-tools:open-pdf");
      expect(main._openPdfDirect).toHaveBeenCalledOnceWith(outputs[0], first.getPath());
    } finally {
      for (const output of outputs) fs.unlinkSync(output);
    }
  });
  it("interrupts only the build belonging to the dispatch editor", async () => {
    spyOn(main, "isBuilding").and.returnValue(true);
    const stop = spyOn(main.build, "stop").and.returnValue(true);
    await lumine.commands.dispatch(first.element, "typst-tools:interrupt");
    expect(stop).toHaveBeenCalledOnceWith({ providerId: "typst-tools", filePath: files[0] });
  });
});
