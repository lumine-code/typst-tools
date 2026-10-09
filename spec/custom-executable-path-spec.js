const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");

describe("Configured Typst executable paths", () => {
  let main, root, scratch, executable;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    // These tests resolve paths; their placeholder executables are never run.
    spyOn(childProcess, "execFileSync").and.callFake(() => {
      throw new Error("Owned PATH lookup miss");
    });
    root = await fs.realpath(os.tmpdir());
    scratch = await fs.realpath(await fs.mkdtemp(path.join(root, "typst-path-")));
    executable = path.join(scratch, process.platform === "win32" ? "typst.exe" : "typst");
    await fs.writeFile(executable, "owned path fixture");
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
  });

  afterEach(async () => {
    if (lumine.packages.isPackageActive("typst-tools"))
      await lumine.packages.deactivatePackage("typst-tools");
    if (lumine.packages.isPackageLoaded("typst-tools"))
      await lumine.packages.unloadPackage("typst-tools");
    lumine.config.unset("typst-tools.typstPath");
    const resolved = await fs.realpath(scratch);
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Fixture cleanup escaped the owned temporary root.");
    await fs.rm(resolved, { recursive: true, force: true });
    main = root = scratch = executable = null;
  });

  it("resolves an existing absolute executable path containing spaces without a PATH lookup", async () => {
    const directory = path.join(scratch, "Compiler With Spaces");
    await fs.mkdir(directory);
    const target = path.join(directory, path.basename(executable));
    await fs.writeFile(target, "owned path fixture");
    lumine.config.set("typst-tools.typstPath", target);
    expect(main.resolveTypstPath()).toEqual({ exePath: target, extraArgs: [] });
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("preserves the existing command form with extra arguments", () => {
    lumine.config.set("typst-tools.typstPath", `${executable} --owned-option`);
    expect(main.resolveTypstPath()).toEqual({ exePath: executable, extraArgs: ["--owned-option"] });
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
});
