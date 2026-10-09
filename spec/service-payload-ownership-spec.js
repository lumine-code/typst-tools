const path = require("node:path");

describe("Typst actual service payload ownership", () => {
  let main, hub, consumers, providers, bars, registry, editor;
  beforeEach(async () => {
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    const linter = (await lumine.packages.activatePackage("linter")).mainModule;
    registry = linter.provideLinterRegistry();
    const barPackage = await lumine.packages.activatePackage("status-bar");
    const Bar = require(path.join(barPackage.path, "lib", "status-bar-view"));
    bars = [new Bar(), new Bar()];
    for (const bar of bars) jasmine.attachToDOM(bar.element);
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    hub = new lumine.packages.serviceHub.constructor();
    consumers = [];
    providers = [];
    editor = lumine.workspace.buildTextEditor();
    editor.getBuffer().setPath(path.join(process.env.LUMINE_HOME, "owned-service.typ"));
    editor.setText("owned\n");
    lumine.workspace.getActivePane().addItem(editor);
    lumine.workspace.getActivePane().activateItem(editor);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });
  afterEach(async () => {
    consumers.forEach((consumer) => consumer.dispose());
    providers.forEach((provider) => provider.dispose());
    await lumine.packages.deactivatePackage("typst-tools");
    editor?.destroy();
    bars.forEach((bar) => bar.destroy());
    await lumine.packages.deactivatePackage("status-bar");
    await lumine.packages.deactivatePackage("linter");
    await lumine.fileWatchClient.settlePendingTeardown();
  });
  function consume(service, method) {
    const lease = hub.consume(service, "^1.0.0", (payload) => main[method](payload));
    consumers.push(lease);
    return lease;
  }
  function provide(service, value) {
    const lease = hub.provide(service, "1.0.0", value);
    providers.push(lease);
    return lease;
  }
  const drain = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  it("keeps actual singleton status tiles after one shared Hub edge withdraws", async () => {
    const first = consume("status-bar", "consumeStatusBar");
    provide("status-bar", bars[0]);
    consume("status-bar", "consumeStatusBar");
    await drain();
    first.dispose();
    expect(bars[0].element.querySelectorAll(".typst-tools-status").length).toBe(1);
    expect(bars[0].element.querySelectorAll(".typst-tools-observed-status").length).toBe(1);
  });
  it("restores actual status placement to the last surviving A-B-A edge", async () => {
    consume("status-bar", "consumeStatusBar");
    provide("status-bar", bars[0]);
    provide("status-bar", bars[1]);
    const newest = provide("status-bar", bars[0]);
    await drain();
    newest.dispose();
    await drain();
    expect(bars[1].element.querySelectorAll(".typst-tools-status").length).toBe(1);
    expect(bars[0].element.querySelectorAll(".typst-tools-status").length).toBe(0);
  });
  it("keeps a real Indie delegate when the newest shared registry edge withdraws", () => {
    consume("linter.registry", "consumeLinterRegistry");
    provide("linter.registry", registry);
    const newest = consume("linter.registry", "consumeLinterRegistry");
    newest.dispose();
    expect(main.linterProvider.indieInstance).not.toBeNull();
    main.linterProvider.setMessages(
      main.outputParser.parse("error: owned live error", editor.getPath()),
    );
    expect(main.linterProvider.indieInstance?.getMessages().length).toBe(1);
  });
  it("restores the real Indie delegate from the latest surviving distinct registry", () => {
    consume("linter.registry", "consumeLinterRegistry");
    const a = (options) => registry(options),
      b = (options) => registry(options);
    provide("linter.registry", a);
    provide("linter.registry", b);
    const delegate = main.linterProvider.indieInstance;
    const newest = provide("linter.registry", a);
    newest.dispose();
    expect(main.linterProvider.indieInstance).toBe(delegate);
  });
  it("disposes a real Indie allocation returned after its registering owner retires", () => {
    let delegate;
    const lease = main.consumeLinterRegistry((options) => {
      delegate = registry(options);
      main.deactivate();
      return delegate;
    });
    providers.push(lease);
    expect(delegate.subscriptions.disposed).toBe(true);
  });
  it("disposes a real native tile returned after its factory retires the owner", () => {
    let callback, tile;
    spyOn(window, "queueMicrotask").and.callFake((value) => (callback = value));
    const allocate = bars[0].addLeftTile.bind(bars[0]);
    spyOn(bars[0], "addLeftTile").and.callFake((options) => {
      tile = allocate(options);
      spyOn(tile, "destroy").and.callThrough();
      main.deactivate();
      return tile;
    });
    providers.push(main.consumeStatusBar(bars[0]));
    expect(() => callback()).not.toThrow();
    expect(tile.destroy).toHaveBeenCalled();
    expect(bars[0].element.querySelectorAll(".typst-tools-status").length).toBe(0);
  });
  it("preserves a newer actual registry allocation consumed during an older factory", () => {
    consume("linter.registry", "consumeLinterRegistry");
    let newer;
    const b = (options) => registry(options);
    const lease = main.consumeLinterRegistry((options) => {
      const older = registry(options);
      provide("linter.registry", b);
      newer = main.linterProvider.indieInstance;
      return older;
    });
    providers.push(lease);
    expect(main.linterProvider.indieInstance).toBe(newer);
    expect(newer.subscriptions.disposed).toBe(false);
  });
  it("keeps the new Package generation after old manual service leases dispose", async () => {
    const oldStatus = main.consumeStatusBar(bars[0]);
    const oldIndie = main.consumeLinterRegistry(registry);
    await drain();
    await lumine.packages.deactivatePackage("typst-tools");
    main = (await lumine.packages.activatePackage("typst-tools")).mainModule;
    providers.push(main.consumeStatusBar(bars[0]), main.consumeLinterRegistry(registry));
    const current = main.linterProvider.indieInstance;
    await drain();
    oldStatus.dispose();
    oldIndie.dispose();
    expect(main.linterProvider.indieInstance).toBe(current);
    expect(current.subscriptions.disposed).toBe(false);
    expect(bars[0].element.querySelectorAll(".typst-tools-status").length).toBe(1);
  });
});
