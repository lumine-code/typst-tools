const { Emitter } = require("lumine");
const path = require("path");

describe("typst-tools PDF opening notifications", () => {
  let mainModule, emitter, notification, sourcePath, pdfPath;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("typst-tools");
    mainModule = pack.mainModule;
    emitter = new Emitter();
    mainModule.build = {
      onDidFinishJob: (callback) => emitter.on("finish", callback),
      associateArtifact: jasmine.createSpy("associateArtifact").and.returnValue(true),
    };

    sourcePath = path.resolve("document.typ");
    pdfPath = path.resolve("document.pdf");
    notification = { dismiss: jasmine.createSpy("dismiss") };
    spyOn(lumine.notifications, "addInfo").and.returnValue(notification);
    spyOn(lumine.notifications, "addWarning");
    spyOn(lumine.notifications, "addError");
    spyOn(mainModule, "_openPdfDirect");
  });

  afterEach(async () => {
    mainModule.clearPendingPdfOpens();
    await lumine.packages.deactivatePackage("typst-tools");
    emitter.dispose();
  });

  function finish(filePath, state) {
    emitter.emit("finish", { providerId: "typst-tools", filePath, state });
  }

  it("keeps one wait and opens once after the matching build succeeds", () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);

    finish(path.resolve("other.typ"), "passed");
    advanceClock(100);
    expect(notification.dismiss).not.toHaveBeenCalled();
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();

    finish(sourcePath, "passed");
    expect(notification.dismiss).toHaveBeenCalled();
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledOnceWith(pdfPath, sourcePath);
    finish(sourcePath, "passed");
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledTimes(1);
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("uses the latest output path without adding another wait", () => {
    const outputPath = path.resolve("document.svg");
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, outputPath);
    finish(sourcePath, "passed");
    advanceClock(100);

    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);
    expect(mainModule._openPdfDirect).toHaveBeenCalledOnceWith(outputPath, sourcePath);
  });

  it("waits for a newer build instead of opening the previous build's output", () => {
    const outputPath = path.resolve("document.svg");
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath, "passed");
    mainModule.waitForBuildAndOpen(sourcePath, outputPath);
    advanceClock(100);

    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(1);

    finish(sourcePath, "passed");
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledOnceWith(outputPath, sourcePath);
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("does not open stale output when a newer build fails during the open delay", () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath, "passed");
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath, "failed");
    advanceClock(100);

    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(0);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  for (const reason of ["Compiler error", "Build interrupted by user"]) {
    it(`clears the wait without another warning after ${reason.toLowerCase()}`, () => {
      mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
      finish(sourcePath, "failed");
      expect(notification.dismiss).toHaveBeenCalled();
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
      expect(lumine.notifications.addError).not.toHaveBeenCalled();
      expect(mainModule.pendingPdfOpens.size).toBe(0);

      finish(sourcePath, "passed");
      advanceClock(100);
      expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    });
  }

  it("dismisses pending waits when deactivated", async () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    await lumine.packages.deactivatePackage("typst-tools");
    expect(notification.dismiss).toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("cancels a delayed open when deactivated after the build finishes", async () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath, "passed");
    await lumine.packages.deactivatePackage("typst-tools");
    advanceClock(100);
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("opens PDFs silently and keeps open errors", async () => {
    mainModule._openPdfDirect.and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});
    await mainModule._openPdfDirect(pdfPath);
    expect(lumine.notifications.addInfo).not.toHaveBeenCalled();

    open.and.rejectWith(new Error("Cannot read PDF"));
    await mainModule._openPdfDirect(pdfPath);
    expect(lumine.notifications.addError).toHaveBeenCalledWith("Failed to open output file", {
      detail: "Cannot read PDF",
      dismissable: true,
    });
  });

  it("associates an explicit source before opening its PDF without requiring a previous job", async () => {
    const outputPath = path.resolve("published.pdf");
    mainModule._openPdfDirect.and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.callFake(() => {
      expect(mainModule.build.associateArtifact).toHaveBeenCalledOnceWith(
        { providerId: "typst-tools", filePath: sourcePath },
        outputPath,
      );
      return Promise.resolve({});
    });

    await mainModule._openPdfDirect(outputPath, sourcePath);

    expect(open).toHaveBeenCalledOnceWith(outputPath, { searchAllPanes: true });
  });
});
