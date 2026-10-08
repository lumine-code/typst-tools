const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Typst diagnostics through the actual indie linter service", () => {
  let main, hub, attachment, editor, directory, filePath;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "typst-linter-")));
    filePath = path.join(directory, "main.typ");
    fs.writeFileSync(filePath, "First line\nSecond line\nLocated error line\nLast line");
    const linter = (await lumine.packages.activatePackage("linter")).mainModule;
    attachment = linter.consumeLinterUI({
      name: "Typst diagnostic integration",
      attach(value) {
        hub = value;
      },
    });
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    editor = await lumine.workspace.open(filePath);
    expect(main.linterProvider.indieInstance.name).toBe("Typst");
  });

  afterEach(async () => {
    attachment?.dispose();
    editor?.destroy();
    await lumine.packages.deactivatePackage("typst-tools");
    await lumine.packages.deactivatePackage("linter");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      const resolved = fs.realpathSync.native(directory);
      const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Unsafe Typst fixture cleanup target");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  function publish(stderr) {
    main.linterProvider.setMessages(main.outputParser.parse(stderr, filePath));
    return main.linterProvider.indieInstance.getMessages();
  }

  for (const devMode of [true, false]) {
    it(`replaces stale diagnostics with a locationless error in ${devMode ? "development" : "ordinary"} mode`, async () => {
      const mode = spyOn(lumine.window, "isDevMode").and.returnValue(devMode);
      publish("error: old located error\n  ┌─ main.typ:3:5\n  │ ^^^");
      await conditionPromise(
        () => hub.getMessages().some((message) => message.excerpt === "old located error"),
        "the initial located publication",
      );
      const messages = publish("error: failed to load font");
      expect(messages.map((message) => message.excerpt)).toEqual(["failed to load font"]);
      const message = messages.find((entry) => entry.excerpt === "failed to load font");
      if (!message) return;
      expect(message.location.position.start.row).toBe(0);
      expect(message.location.position.start.column).toBe(0);
      expect(message.location.position.end.row).toBe(0);
      expect(message.location.position.end.column).toBe(Number.MAX_SAFE_INTEGER);
      await conditionPromise(
        () => hub.getCurrentMessages().some((entry) => entry.excerpt === "failed to load font"),
        "the locationless diagnostic in the current editor UI",
      );
      editor.setCursorBufferPosition([3, 2]);
      hub.revealMessage(message);
      expect(editor.getCursorBufferPosition().toArray()).toEqual([0, 0]);
      expect(hub.getMessages().some((entry) => entry.excerpt === "old located error")).toBe(false);
      mode.and.callThrough();
    });
  }

  it("publishes mixed located and locationless diagnostics without dropping located spans", async () => {
    const warnings = spyOn(lumine.notifications, "addWarning").and.callThrough();
    const messages = publish(
      "error: unknown font\nwarning: located warning\n  ┌─ main.typ:3:5\n  │ ^^^",
    );
    expect(messages.map((message) => message.excerpt)).toEqual(["unknown font", "located warning"]);
    if (messages.length !== 2) return;
    await conditionPromise(() => hub.getCurrentMessages().length === 2, "both Typst diagnostics");
    const located = messages.find((message) => message.excerpt === "located warning");
    expect(located.location.position.start.toArray()).toEqual([2, 4]);
    expect(located.location.position.end.toArray()).toEqual([2, 7]);
    editor.setCursorBufferPosition([0, 0]);
    hub.revealMessage(located);
    expect(editor.getCursorBufferPosition().toArray()).toEqual([2, 4]);
    expect(
      warnings.calls.allArgs().some(([title]) => title.includes("Invalid Linter Result")),
    ).toBe(false);
  });

  it("publishes repeated locationless diagnostics and clears the actual UI publication", async () => {
    const messages = publish("error: first failure\nwarning: second failure");
    expect(messages.map((message) => message.excerpt)).toEqual(["first failure", "second failure"]);
    if (messages.length !== 2) return;
    await conditionPromise(
      () => hub.getCurrentMessages().length === 2,
      "both locationless diagnostics",
    );
    main.linterProvider.clearMessages();
    await conditionPromise(() => hub.getMessages().length === 0, "cleared Typst diagnostics");
  });
});
