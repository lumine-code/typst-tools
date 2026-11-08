const { CompositeDisposable, Disposable, Emitter } = require("lumine");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { getOutputPath } = require("./utils");

const PACKAGE_NAME = "typst-tools";

function normalizePathForTypst(filePath) {
  const normalizedPath = path.normalize(filePath);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function isPending(item) {
  if (item.isPending != null) {
    return item.isPending();
  }
  const pane = lumine.workspace.getActivePane();
  return pane ? pane.getPendingItem() === item : false;
}

function log(...args) {
  if (lumine.config.get(`${PACKAGE_NAME}.debug`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

function owns(main, owner) {
  return !!owner && main.active && main.owner === owner && !owner.retired;
}

function latest(edges) {
  return Array.from(edges).at(-1) ?? null;
}

/**
 * Typst Tools Package
 * Provides Typst compilation, compile-on-save, PDF viewing, and error parsing.
 */
module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "typst-tools",
      tips: [
        "You can compile the Typst document you are editing with {{ 'typst-tools:compile' | keystroke }}",
      ],
    };
  },

  subscriptions: null,
  observedFilesList: null,
  build: null,
  pendingPdfOpens: null,
  active: false,

  /**
   * Activates the package and registers Typst commands.
   */
  activate() {
    this.active = true;
    this.subscriptions = new CompositeDisposable();
    this.build = null;
    this.observedFilesList = null;
    this.pendingPdfOpens = new Map();
    this.owner = {
      subscriptions: this.subscriptions,
      pdfEmitter: new Emitter(),
      buildEdges: new Set(),
      buildRecords: new Map(),
      retired: false,
    };
    this.subscriptions.add(this.owner.pdfEmitter);

    // Register commands
    this.subscriptions.add(
      // These workspace operations deliberately resolve the current document
      // while another surface has focus. Editor shortcuts keep their grammar
      // scope, and handlers guard the saved Typst source they operate on.
      lumine.commands.add("lumine-workspace", {
        "typst-tools:compile": {
          description: "Build this Typst document once.",
          isAvailable: (event) => this.isCommandAvailable(event, "compile"),
          didDispatch: (event) => this.compile(event),
        },
        "typst-tools:split-pdf-source": {
          description: "Open the PDF or its source in the adjacent pane.",
          isAvailable: (event) => this.isCommandAvailable(event),
          didDispatch: (event) => this.splitPdfSource(event),
        },
        "typst-tools:stop-and-clear-diagnostics": {
          description: "Stop this document's build and clear its diagnostics.",
          isAvailable: (event) => this.isCommandAvailable(event, "stop"),
          didDispatch: (event) => this.stopAndClearDiagnostics(event),
        },
        "typst-tools:watch": {
          description: "Build this document again whenever it is saved.",
          checked: (event) => {
            const { filePath } = this.documentContext(event);
            return Boolean(filePath && this.isCompileOnSaveEnabledForFile(filePath));
          },
          isAvailable: (event) => Boolean(this.build) && this.isCommandAvailable(event),
          didDispatch: (event) => this.toggleCompileOnSave(event),
        },
        "typst-tools:open-pdf": {
          description: "Open the built PDF in the editor's own viewer.",
          isAvailable: (event) => this.isCommandAvailable(event),
          didDispatch: (event) => this.openPdf(event),
        },
        "typst-tools:interrupt": {
          description: "Stop the build of this document.",
          isAvailable: (event) => this.isCommandAvailable(event, "interrupt"),
          didDispatch: (event) => this.interrupt(event),
        },
        "typst-tools:interrupt-all": {
          description: "Stop every build now running.",
          isAvailable: () => this.getJobs(true).length > 0,
          didDispatch: () => this.interruptAll(),
        },
        "typst-tools:clean-linter": {
          description: "Drop the messages the last build reported.",
          isAvailable: () => this.getMessages().length > 0,
          didDispatch: () => this.cleanLinter(),
        },
        "typst-tools:list-fonts": {
          description: "List the fonts this Typst installation can use.",
          didDispatch: () => this.listFonts(),
        },
        "typst-tools:install-typst": {
          description: "Download the Typst binary the package needs.",
          didDispatch: () => this.installTypst(),
        },
        "typst-tools:observed-files": {
          description: "List the files being built on save, and stop any of them.",
          didDispatch: () => this.showObservedFiles(),
        },
        "typst-tools:clear-all-observed-files": {
          description: "Stop building every file that was set to build on save.",
          isAvailable: () => this.getCompileOnSaveFiles().length > 0,
          didDispatch: () => this.clearCompileOnSaveFiles(),
        },
      }),
    );
  },

  /**
   * Deactivates the package and cleans up resources.
   */
  deactivate() {
    const owner = this.owner;
    this.owner = null;
    this.active = false;
    this.build = null;
    if (owner) owner.retired = true;
    this.clearPendingPdfOpens();
    this.subscriptions?.dispose();
    this.observedFilesList?.destroy();
    this.subscriptions = this.observedFilesList = null;
    owner?.buildEdges.clear();
    owner?.buildRecords.clear();
  },

  // ============================================
  // SERVICE METHODS
  // ============================================

  consumeTasks(service) {
    const owner = this.owner;
    if (!owns(this, owner)) return new Disposable();
    let record = owner.buildRecords.get(service);
    if (!record) {
      record = { service, references: 0, subscriptions: new CompositeDisposable() };
      owner.buildRecords.set(service, record);
      const current = () =>
        owns(this, owner) &&
        this.build === service &&
        [...owner.buildEdges].some((edge) => edge.record === record);
      const refresh = () => {
        if (!current()) return;
        lumine.commands.invalidateAvailability();
        this.observedFilesList?.update();
      };
      record.subscriptions.add(
        service.registerProvider(this.createBuildProvider()),
        service.onDidChangeJob((job) => {
          if (job.providerId !== PACKAGE_NAME) return;
          refresh();
          if (current()) owner.pdfEmitter.emit("builds");
        }),
        service.onDidFinishJob((job) => {
          if (job.providerId === PACKAGE_NAME) refresh();
        }),
        service.onDidChangeObserved((event) => {
          if (event.providerId !== PACKAGE_NAME) return;
          refresh();
          if (current()) owner.pdfEmitter.emit("builds");
        }),
        service.onDidChangeArtifactTargets(({ artifactPath }) => {
          if (current() && /\.pdf$/i.test(artifactPath))
            owner.pdfEmitter.emit("sources", { pdfPath: artifactPath });
        }),
      );
      if (!owns(this, owner)) {
        record.subscriptions.dispose();
        return new Disposable();
      }
    }
    record.references++;
    const edge = { record };
    owner.buildEdges.add(edge);
    const lease = new Disposable(() => {
      if (!owner.buildEdges.delete(edge)) return;
      owner.subscriptions.remove(lease);
      if (--record.references === 0) {
        owner.buildRecords.delete(service);
        record.subscriptions.dispose();
      }
      if (owns(this, owner)) this.refreshBuildService(owner);
    });
    owner.subscriptions.add(lease);
    this.refreshBuildService(owner);
    return lease;
  },

  refreshBuildService(owner) {
    if (!owns(this, owner)) return;
    const service = latest(owner.buildEdges)?.record.service ?? null;
    const changed = this.build !== service;
    if (changed) this.clearPendingPdfOpens();
    this.build = service;
    this.observedFilesList?.update();
    lumine.commands.invalidateAvailability();
    if (changed) {
      owner.pdfEmitter.emit("sources", {});
      if (owns(this, owner)) owner.pdfEmitter.emit("builds");
    }
  },

  providePdfBuildProvider() {
    const owner = this.owner;
    if (!owns(this, owner)) return null;
    if (owner.pdfBuildProvider) return owner.pdfBuildProvider;
    const canBuild = (sourcePath) =>
      owns(this, owner) &&
      Boolean(this.build) &&
      typeof sourcePath === "string" &&
      sourcePath.endsWith(".typ") &&
      !sourcePath.includes("\0") &&
      !this.isBuilding(path.resolve(sourcePath));
    const canToggleCompileOnSave = (sourcePath) =>
      owns(this, owner) &&
      Boolean(this.build) &&
      typeof sourcePath === "string" &&
      path.isAbsolute(sourcePath) &&
      sourcePath.endsWith(".typ") &&
      !sourcePath.includes("\0");
    owner.pdfBuildProvider = {
      id: PACKAGE_NAME,
      name: "Typst",
      resolveSource: (pdfPath, options = {}) => this.resolvePdfSource(owner, pdfPath, options),
      canBuild,
      build: (sourcePath) =>
        canBuild(sourcePath) ? this.runCompilation(path.resolve(sourcePath)) || null : null,
      canToggleCompileOnSave,
      isCompileOnSaveEnabled: (sourcePath) =>
        canToggleCompileOnSave(sourcePath) && this.isCompileOnSaveEnabledForFile(sourcePath),
      toggleCompileOnSave: (sourcePath) =>
        canToggleCompileOnSave(sourcePath) &&
        this.setCompileOnSaveForFile(sourcePath, !this.isCompileOnSaveEnabledForFile(sourcePath)),
      isBuilding: (pdfPath) => {
        if (
          !owns(this, owner) ||
          !this.build ||
          typeof pdfPath !== "string" ||
          pdfPath.includes("\0") ||
          !/\.pdf$/i.test(pdfPath)
        )
          return false;
        const key = normalizePathForTypst(path.resolve(pdfPath));
        return this.getJobs(true).some((job) =>
          job.artifacts?.some(
            (artifact) => normalizePathForTypst(path.resolve(artifact.path)) === key,
          ),
        );
      },
      onDidChangeBuilds: (callback) =>
        owns(this, owner) ? owner.pdfEmitter.on("builds", callback) : new Disposable(),
      onDidChangeSources: (callback) =>
        owns(this, owner) ? owner.pdfEmitter.on("sources", callback) : new Disposable(),
    };
    return owner.pdfBuildProvider;
  },

  async resolvePdfSource(owner, pdfPath, { signal, sourcePath } = {}) {
    if (!owns(this, owner)) return null;
    signal?.throwIfAborted();
    if (typeof pdfPath !== "string" || !/\.pdf$/i.test(pdfPath) || pdfPath.includes("\0"))
      return null;
    const backend = this.build;
    const output = path.resolve(pdfPath);
    const association = backend?.getArtifactTarget(output) ?? null;
    if (association && association.providerId !== PACKAGE_NAME) return null;
    const candidates = association
      ? [association.filePath]
      : [sourcePath, output.replace(/\.pdf$/i, ".typ")];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.endsWith(".typ") || candidate.includes("\0"))
        continue;
      const source = path.resolve(candidate);
      if (!association) {
        const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
        if (normalizePathForTypst(getOutputPath(source, format)) !== normalizePathForTypst(output))
          continue;
      }
      let exists = false;
      try {
        exists = (await fs.promises.stat(source)).isFile();
      } catch {
        /* A missing source is not a claim. */
      }
      if (!owns(this, owner) || this.build !== backend) return null;
      signal?.throwIfAborted();
      const current = backend?.getArtifactTarget(output) ?? null;
      if (
        current &&
        (current.providerId !== PACKAGE_NAME ||
          normalizePathForTypst(path.resolve(current.filePath)) !== normalizePathForTypst(source))
      )
        return null;
      if (association && !current) return null;
      if (exists) return source;
    }
    return null;
  },

  createBuildProvider() {
    return {
      id: PACKAGE_NAME,
      name: "Typst",
      supports: (filePath) => typeof filePath === "string" && filePath.endsWith(".typ"),
      prepare: async ({ filePath, reason }, signal) => {
        signal.throwIfAborted();
        if (reason === "manual") {
          const editor = lumine.workspace
            .getTextEditors()
            .find((item) => item.getPath() === filePath);
          if (editor && editor.getFileState() !== "unmodified") await editor.save();
          signal.throwIfAborted();
        }
        return this.prepareBuild(filePath);
      },
      collectResult: ({ filePath, stderr, code, error, plan }) => {
        const Parser = require("./output-parser");
        const messages = new Parser().parse(stderr, filePath);
        if (messages.length === 0 && (error || code !== 0))
          messages.push({
            severity: "error",
            excerpt: error?.message ?? `Compilation failed (exit code ${code})`,
            location: {
              fullPath: filePath,
              position: { start: { row: 0, column: 0 }, end: { row: 0, column: 1 } },
            },
          });
        return {
          artifacts: plan?.artifacts ?? [],
          diagnostics: messages.map((message) => ({
            severity: message.severity,
            excerpt: message.excerpt,
            location: {
              file: message.location.fullPath,
              position: [
                [message.location.position.start.row, message.location.position.start.column],
                [message.location.position.end.row, message.location.position.end.column],
              ],
            },
          })),
        };
      },
    };
  },

  ensureObservedFilesList() {
    if (!this.observedFilesList) {
      const ObservedFilesList = require("./observed-list");
      this.observedFilesList = new ObservedFilesList(this);
    }
    return this.observedFilesList;
  },

  documentContext(event) {
    const context =
      event?.context ?? (event?.target && lumine.workspace.resolveCommandContext(event));
    const editor = context ? context.embeddedEditor : lumine.workspace.getActiveTextEditor();
    const item = context ? context.documentItem : lumine.workspace.getCenter().getActivePaneItem();
    const pdf = Boolean(item?.filePath?.endsWith(".pdf"));
    const filePath = pdf ? item.filePath.replace(/\.pdf$/, ".typ") : editor?.getPath();
    return { context, editor: pdf ? null : editor, filePath, pdf };
  },

  isCommandAvailable(event, kind) {
    const { filePath } = this.documentContext(event);
    if (!filePath?.endsWith(".typ")) return false;
    const running = this.isBuilding(filePath);
    if (kind === "interrupt") return running;
    if (kind === "stop") return running || this.getMessages(filePath).length > 0;
    return kind !== "compile" || Boolean(this.build && !running);
  },

  // ============================================
  // TYPST PATH RESOLUTION
  // ============================================

  /**
   * Resolve the typst executable path.
   * Priority: custom config > bundled binary > system PATH
   * @returns {string|null}
   */
  resolveTypstPath() {
    const command = lumine.config.get(`${PACKAGE_NAME}.typstPath`) || "typst";

    // Custom command (user changed from default)
    if (command !== "typst") {
      const configuredPath = command.trim();
      if (path.isAbsolute(configuredPath) && fs.existsSync(configuredPath)) {
        return { exePath: configuredPath, extraArgs: [] };
      }
      const [exe, ...extraArgs] = configuredPath.split(/\s+/);
      // Check if it exists as absolute path
      if (path.isAbsolute(exe) && fs.existsSync(exe)) {
        log(`Using custom path: ${exe}`);
        return { exePath: exe, extraArgs };
      }
      // Try which
      try {
        const found =
          process.platform === "win32"
            ? execFileSync("where", [exe], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
            : execFileSync("which", [exe], { encoding: "utf8" }).trim();
        if (found) {
          log(`Using custom command: ${found}`);
          return { exePath: found, extraArgs };
        }
      } catch {
        // Not found in PATH; fall through to the failure result.
      }
      return { exePath: null, extraArgs: [] };
    }

    // Bundled binary
    const installer = require("./typst-installer");
    if (installer.hasBundled()) {
      const binPath = installer.getBinPath();
      log(`Using bundled binary: ${binPath} (${installer.getInstalledVersion()})`);
      return { exePath: binPath, extraArgs: [] };
    }

    // System PATH
    try {
      const found =
        process.platform === "win32"
          ? execFileSync("where", ["typst"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
          : execFileSync("which", ["typst"], { encoding: "utf8" }).trim();
      if (found) {
        log(`Using system typst: ${found}`);
        return { exePath: found, extraArgs: [] };
      }
    } catch {
      // Not found in PATH; fall through to the failure result.
    }

    return { exePath: null, extraArgs: [] };
  },

  // ============================================
  // COMPILE COMMAND
  // ============================================

  async compile(event) {
    const owner = this.owner;
    if (!owns(this, owner)) return;
    const { context, editor: documentEditor, filePath } = this.documentContext(event);
    if (!filePath?.endsWith(".typ")) return;
    const editor =
      documentEditor ??
      lumine.workspace.getTextEditors().find((item) => item.getPath() === filePath);
    if (editor && isPending(editor)) lumine.workspace.paneForItem(editor)?.clearPendingItem();
    const buffer = editor?.getBuffer?.();
    const request = (this.compileRequest = (this.compileRequest || 0) + 1);
    if (this.isBuilding(filePath)) return;
    if (editor && editor.getFileState() !== "unmodified") await editor.save();
    if (
      !owns(this, owner) ||
      request !== this.compileRequest ||
      editor?.isDestroyed() ||
      context?.documentItem?.isDestroyed?.() ||
      (editor && (editor.getBuffer?.() !== buffer || editor.getPath() !== filePath))
    )
      return;
    if (!editor && !fs.existsSync(filePath)) return;
    return this.runCompilation(filePath);
  },

  runCompilation(filePath) {
    if (!this.active || !this.build || !filePath?.endsWith(".typ")) return false;
    return this.build.run({ providerId: PACKAGE_NAME, filePath, reason: "manual" });
  },

  prepareBuild(filePath) {
    const { exePath, extraArgs } = this.resolveTypstPath();
    if (!exePath) {
      lumine.notifications.addError("typst not found", {
        dismissable: true,
        description: "Install Typst from the command palette or configure its executable path.",
        buttons: [{ text: "Install Typst", onDidClick: () => this.installTypst() }],
      });
      throw new Error("typst not found");
    }
    const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const args = [...extraArgs, "compile"];
    for (const fontPath of lumine.config.get(`${PACKAGE_NAME}.fontPaths`) || [])
      if (fontPath) args.push("--font-path", fontPath);
    if (format !== "pdf") args.push("--format", format);
    args.push(
      ...(lumine.config.get(`${PACKAGE_NAME}.additionalArgs`) || []),
      path.basename(filePath),
    );
    return {
      cmd: exePath,
      args,
      cwd: path.dirname(filePath),
      shell: false,
      artifacts: [{ path: getOutputPath(filePath, format), kind: format, sourcePath: filePath }],
    };
  },

  // ============================================
  // COMPILE ON SAVE
  // ============================================

  toggleCompileOnSave(event) {
    const { editor, filePath } = this.documentContext(event);
    if (!editor && !filePath) return;
    if (editor && isPending(editor)) {
      const pane = lumine.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }
    if (!filePath.endsWith(".typ")) {
      lumine.notifications.addWarning("Not a Typst file");
      return;
    }

    const enabled = this.isCompileOnSaveEnabledForFile(filePath);

    if (this.setCompileOnSaveForFile(filePath, !enabled))
      log(`Compile on save ${enabled ? "disabled" : "enabled"} for ${path.basename(filePath)}`);
  },

  isCompileOnSaveEnabledForFile(filePath) {
    const key = filePath && normalizePathForTypst(path.resolve(filePath));
    return Boolean(
      key &&
      this.getCompileOnSaveFiles().some(
        (file) => normalizePathForTypst(path.resolve(file)) === key,
      ),
    );
  },

  setCompileOnSaveForFile(filePath, enabled) {
    if (!filePath?.endsWith(".typ") || !this.build) return false;
    return this.build.setObserved({ providerId: PACKAGE_NAME, filePath }, enabled);
  },

  getCompileOnSaveFiles() {
    return (
      this.build?.getObserved({ providerId: PACKAGE_NAME }).map((entry) => entry.filePath) ?? []
    );
  },

  showObservedFiles() {
    return this.ensureObservedFilesList().show();
  },

  clearCompileOnSaveFiles() {
    this.build?.clearObserved({ providerId: PACKAGE_NAME });
    this.observedFilesList?.update();
  },

  getJobs(activeOnly = false) {
    return this.build?.getJobs({ providerId: PACKAGE_NAME, activeOnly }) ?? [];
  },

  getJob(filePath) {
    return this.build?.getJob({ providerId: PACKAGE_NAME, filePath }) ?? null;
  },

  isBuilding(filePath) {
    return ["preparing", "running", "collecting"].includes(this.getJob(filePath)?.state);
  },

  interrupt(event) {
    const { filePath } = this.documentContext(event);
    if (filePath) return this.interruptFile(filePath);
  },

  interruptAll() {
    return this.build?.stopAll({ providerId: PACKAGE_NAME }) ?? 0;
  },

  interruptFile(filePath) {
    if (!filePath?.endsWith(".typ")) return false;
    return this.build?.stop({ providerId: PACKAGE_NAME, filePath }) ?? false;
  },

  // ============================================
  // PDF OPENING
  // ============================================

  openPdf(event) {
    const { filePath } = this.documentContext(event);
    if (!filePath?.endsWith(".typ")) return;

    const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const outputPath = getOutputPath(filePath, format);

    // Check if build is in progress
    if (this.isBuilding(filePath)) {
      this.waitForBuildAndOpen(filePath, outputPath);
      return;
    }

    if (!fs.existsSync(outputPath)) {
      lumine.notifications.addWarning("Output file not found", {
        detail: `Expected file: ${outputPath}\n\nPlease compile the Typst file first.`,
        dismissable: true,
      });
      return;
    }

    this._openPdfDirect(outputPath, filePath);
  },

  _openPdfDirect(outputPath, filePath) {
    if (filePath) this.build?.associateArtifact({ providerId: PACKAGE_NAME, filePath }, outputPath);
    return lumine.workspace.open(outputPath, { searchAllPanes: true }).catch((error) => {
      lumine.notifications.addError("Failed to open output file", {
        detail: error.message,
        dismissable: true,
      });
    });
  },

  waitForBuildAndOpen(filePath, outputPath) {
    const pendingOpens = this.pendingPdfOpens;
    const key = normalizePathForTypst(path.resolve(filePath));
    const existing = pendingOpens.get(key);
    if (existing?.timeout === null) {
      existing.outputPath = outputPath;
      return;
    }
    existing?.dispose();

    const disposable = new CompositeDisposable();
    const notification = lumine.notifications.addInfo("Waiting for compilation to finish...", {
      description: "The output will open automatically when the build completes.",
      dismissable: true,
    });
    const pending = {
      outputPath,
      timeout: null,
      dispose: () => {
        disposable.dispose();
        notification.dismiss();
        if (pending.timeout) clearTimeout(pending.timeout);
        pendingOpens.delete(key);
      },
    };
    pendingOpens.set(key, pending);

    const openAfterBuild = () => {
      disposable.dispose();
      notification.dismiss();
      pending.timeout = setTimeout(() => {
        pending.dispose();
        this._openPdfDirect(pending.outputPath, filePath);
      }, 100);
    };

    if (!this.build) {
      pending.dispose();
      return;
    }
    disposable.add(
      this.build.onDidFinishJob((job) => {
        if (
          job.providerId !== PACKAGE_NAME ||
          normalizePathForTypst(path.resolve(job.filePath)) !== key
        )
          return;
        if (job.state === "passed") openAfterBuild();
        else pending.dispose();
      }),
    );
  },

  clearPendingPdfOpens() {
    for (const pending of this.pendingPdfOpens?.values() || []) {
      pending.dispose();
    }
  },

  splitPdfSource(event) {
    const { context, filePath, pdf } = this.documentContext(event);
    if (!filePath?.endsWith(".typ")) return;
    const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const target = pdf ? filePath : getOutputPath(filePath, format);
    if (!fs.existsSync(target)) {
      lumine.notifications.addWarning(
        pdf ? "Typst file not found." : "Output file not found. Compile first.",
      );
      return;
    }
    const options = { split: pdf ? "left" : "right", searchAllPanes: true };
    if (context?.documentPane) options.pane = context.documentPane;
    if (!pdf) this.build?.associateArtifact({ providerId: PACKAGE_NAME, filePath }, target);
    return lumine.workspace.open(target, options);
  },

  stopAndClearDiagnostics(event) {
    const { filePath } = this.documentContext(event);
    if (!filePath?.endsWith(".typ")) return;
    this.interruptFile(filePath);
    this.build?.clearMessages({ providerId: PACKAGE_NAME, filePath });
  },

  cleanLinter() {
    this.build?.clearMessages({ providerId: PACKAGE_NAME });
    lumine.commands.invalidateAvailability();
  },

  getMessages(filePath = null) {
    return (
      this.build?.getMessages({ providerId: PACKAGE_NAME, ...(filePath ? { filePath } : {}) }) ?? []
    );
  },

  // ============================================
  // ADDITIONAL COMMANDS
  // ============================================

  listFonts() {
    const { exePath, extraArgs } = this.resolveTypstPath();
    if (!exePath) {
      lumine.notifications.addError("typst not found", {
        dismissable: true,
        buttons: [
          {
            text: "Install Typst",
            onDidClick: () => this.installTypst(),
          },
        ],
      });
      return;
    }

    try {
      const result = execFileSync(exePath, [...extraArgs, "fonts"], {
        encoding: "utf8",
        timeout: 10000,
      });
      lumine.notifications.addInfo("Available Fonts", {
        detail: result,
        dismissable: true,
      });
    } catch (error) {
      lumine.notifications.addError("Failed to list fonts", {
        detail: error.message,
        dismissable: true,
      });
    }
  },

  async installTypst() {
    const notification = lumine.notifications.addInfo("Downloading typst...", {
      dismissable: true,
      description: `Platform: ${process.platform}-${process.arch}`,
    });

    try {
      const result = await require("./typst-installer").install();
      notification.dismiss();
      lumine.notifications.addSuccess(`Typst ${result.version} installed.`, {
        description: `Binary: \`${result.path}\``,
        dismissable: true,
      });
      log(`Installed typst ${result.version} to ${result.path}`);
    } catch (err) {
      notification.dismiss();
      lumine.notifications.addError("Failed to install typst.", {
        dismissable: true,
        description: err.message,
      });
      log("Install error:", err.message);
    }
  },
};
