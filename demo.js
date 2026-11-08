// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["tasks", "language-typst", "pdf-view"],
  viewport: { width: 1250, height: 760 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("documents/typst-tools/report.typ");
    await lumine.project.setPaths([fixture("documents/typst-tools")]);
    lumine.config.set(
      "typst-tools.typstPath",
      process.env.LUMINE_DEMO_TYPST || lumine.config.get("typst-tools.typstPath") || "typst",
    );
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Compile a Typst document and inspect the generated PDF beside its source.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, waitFor } = context;
        const main = lumine.packages.getActivePackage("typst-tools").mainModule;
        const job = await main.compile();
        if (!job) throw new Error("Typst did not accept the build.");
        await job.completion;
        if (job.state !== "passed") throw new Error("Typst compilation failed.");
        await waitFor(() => !main.isBuilding(state.editor.getPath()), "Typst compilation");
        {
          lumine.commands.dispatch(
            lumine.views.getView(state.editor),
            "typst-tools:split-pdf-source",
          );
        }
      },
      async afterPointerMove({ lumine, waitFor }) {
        for (const notice of lumine.notifications.getNotifications()) {
          if (/^(Compiling report\.typ|report\.typ compiled successfully)/.test(notice.message))
            notice.dismiss();
        }
        await waitFor(
          () => !document.querySelector("lumine-notification"),
          "compile notices to close",
        );
      },
      ready(context) {
        const { lumine } = context;
        const buildIcon = document.querySelector("status-bar .tasks-status .icon-tools");
        const iconBounds = buildIcon?.getBoundingClientRect();
        return Boolean(
          iconBounds?.width > 0 &&
          iconBounds?.height > 0 &&
          !document.querySelector(
            ".latex-tools-status, .latex-tools-observed-status, .typst-tools-status, .typst-tools-observed-status",
          ) &&
          lumine.workspace.getCenter().getPanes().length === 2 &&
          lumine.workspace.getPaneItems().some((i) => i.getPath?.()?.endsWith(".pdf")),
        );
      },
    },
  ],
  async cleanup() {},
};
