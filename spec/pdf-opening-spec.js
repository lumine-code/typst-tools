const path = require("path");

describe("typst-tools PDF opening notifications", () => {
  let mainModule, service, notification, sourcePath, pdfPath;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("typst-tools");
    mainModule = pack.mainModule;
    service = mainModule.provideTypstTools();
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
  });

  it("keeps one wait and opens once after the matching build succeeds", () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);

    service.finishBuild(path.resolve("other.typ"), "", 1);
    advanceClock(100);
    expect(notification.dismiss).not.toHaveBeenCalled();
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();

    service.finishBuild(sourcePath, "", 1);
    expect(notification.dismiss).toHaveBeenCalled();
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledOnceWith(pdfPath);
    service.finishBuild(sourcePath, "", 1);
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledTimes(1);
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("uses the latest output path without adding another wait", () => {
    const outputPath = path.resolve("document.svg");
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, outputPath);
    service.finishBuild(sourcePath, "", 1);
    advanceClock(100);

    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);
    expect(mainModule._openPdfDirect).toHaveBeenCalledOnceWith(outputPath);
  });

  for (const reason of ["Compiler error", "Build interrupted by user"]) {
    it(`clears the wait without another warning after ${reason.toLowerCase()}`, () => {
      mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
      service.failBuild(sourcePath, reason, "");
      expect(notification.dismiss).toHaveBeenCalled();
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
      expect(lumine.notifications.addError).not.toHaveBeenCalled();
      expect(mainModule.pendingPdfOpens.size).toBe(0);

      service.finishBuild(sourcePath, "", 1);
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
    service.finishBuild(sourcePath, "", 1);
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
});
