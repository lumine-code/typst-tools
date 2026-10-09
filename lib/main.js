const { CompositeDisposable, Disposable, watchFile } = require("lumine");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const BuildService = require("./build-service");
const OutputParser = require("./output-parser");
const LinterProvider = require("./linter-provider");
const installer = require("./typst-installer");
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

function refreshStatus(main, owner) {
  if (!owns(main, owner)) return;
  owner.statusPending = true;
  if (owner.statusRebinding) return;
  owner.statusRebinding = true;
  try {
    while (owner.statusPending && owns(main, owner)) {
      owner.statusPending = false;
      const bar = latest(owner.statusEdges)?.payload ?? null;
      if (owner.currentBar === bar && owner.statusTiles) continue;
      const previous = owner.statusTiles;
      owner.statusTiles = null;
      owner.currentBar = null;
      main.statusBarTile = main.observedFilesStatusTile = null;
      previous?.dispose();
      if (!owns(main, owner)) return;
      if (!bar || bar !== latest(owner.statusEdges)?.payload) {
        owner.statusPending = !!owner.statusEdges.size;
        continue;
      }
      const current = () => owns(main, owner) && latest(owner.statusEdges)?.payload === bar;
      main.ensureStatusBarViews();
      if (!current()) {
        owner.statusPending = true;
        continue;
      }
      const tiles = new CompositeDisposable();
      const status = bar.addLeftTile({ item: main.statusBarView.getElement(), priority: 430 });
      tiles.add(new Disposable(() => status.destroy()));
      if (!current()) {
        tiles.dispose();
        owner.statusPending = true;
        continue;
      }
      const observed = bar.addRightTile({
        item: main.observedFilesStatusView.getElement(),
        priority: 520,
      });
      tiles.add(new Disposable(() => observed.destroy()));
      if (!current()) {
        tiles.dispose();
        owner.statusPending = true;
        continue;
      }
      owner.statusTiles = tiles;
      owner.currentBar = bar;
      main.statusBarTile = status;
      main.observedFilesStatusTile = observed;
      main.updateObservedFilesStatus();
      if (current()) main.updateStatusBarForItem(lumine.workspace.getCenter().getActivePaneItem());
    }
  } finally {
    owner.statusRebinding = false;
  }
}

function refreshIndie(main, owner) {
  if (!owns(main, owner)) return;
  owner.linterProvider.register(latest(owner.registryEdges)?.record.indie ?? null);
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
  statusBarView: null,
  statusBarTile: null,
  observedFilesStatusView: null,
  observedFilesStatusTile: null,
  observedFilesList: null,
  buildService: null,
  outputParser: null,
  linterProvider: null,
  buildStates: null,
  buildProcesses: null,
  pendingPdfOpens: null,
  compileOnSaveFiles: null, // Track file paths with compile-on-save enabled
  currentTypFile: null,
  active: false,
  activationGeneration: 0,

  /**
   * Activates the package and registers Typst commands.
   */
  activate() {
    this.active = true;
    this.activationGeneration++;
    this.subscriptions = new CompositeDisposable();
    this.buildService = new BuildService();
    this.buildService.setMainModule(this);
    this.outputParser = new OutputParser();
    this.linterProvider = new LinterProvider();
    this.observedFilesList = null;
    this.observedFilesStatusView = null;
    this.statusBarView = null;
    this.statusBarTile = null;
    this.observedFilesStatusTile = null;
    this.buildStates = new Map();
    this.buildProcesses = new Map();
    this.pendingPdfOpens = new Map();
    this.compileOnSaveFiles = new Map();
    this.owner = {
      subscriptions: this.subscriptions,
      linterProvider: this.linterProvider,
      statusEdges: new Set(),
      registryEdges: new Set(),
      registryRecords: new Map(),
      statusTiles: null,
      currentBar: null,
      retired: false,
    };

    // Register commands
    this.subscriptions.add(
      // One registration, on the workspace. Packages > Typst Tools is always
      // visible and the application menu dispatches at whatever holds focus, so
      // a grammar scope here meant every item did nothing unless a .typ editor
      // had focus. The keymap still carries that scope, and every handler
      // already refuses with a notification outside a saved Typst file.
      lumine.commands.add("lumine-workspace", {
        "typst-tools:compile": {
          description: "Build this document once and open the result.",
          didDispatch: () => this.compile(),
        },
        "typst-tools:watch": {
          description: "Build this document again whenever it is saved.",
          didDispatch: () => this.toggleCompileOnSave(),
        },
        "typst-tools:open-pdf": {
          description: "Open the built PDF in the editor's own viewer.",
          didDispatch: () => this.openPdf(),
        },
        "typst-tools:interrupt": {
          description: "Stop the build of this document.",
          didDispatch: () => this.interrupt(),
        },
        "typst-tools:interrupt-all": {
          description: "Stop every build now running.",
          didDispatch: () => this.interruptAll(),
        },
        "typst-tools:clean-linter": {
          description: "Drop the messages the last build reported.",
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
          didDispatch: () => this.clearCompileOnSaveFiles(),
        },
      }),
      // Track active pane item changes (text editors and PDF views)
      lumine.workspace
        .getCenter()
        .observeActivePaneItem((item) => this.updateStatusBarForItem(item)),
    );
  },

  /**
   * Deactivates the package and cleans up resources.
   */
  deactivate() {
    const owner = this.owner;
    this.owner = null;
    this.active = false;
    this.activationGeneration++;
    const pending = Array.from(this.pendingPdfOpens?.values() ?? []);
    const processes = Array.from(this.buildProcesses?.values() ?? []);
    const observed = Array.from(this.compileOnSaveFiles?.values() ?? []);
    const subscriptions = this.subscriptions;
    const views = [this.statusBarView, this.observedFilesStatusView, this.observedFilesList];
    const service = this.buildService;
    const legacyTiles = owner?.statusTiles
      ? []
      : [this.statusBarTile, this.observedFilesStatusTile];
    this.pendingPdfOpens?.clear();
    this.buildProcesses?.clear();
    this.compileOnSaveFiles?.clear();
    this.subscriptions =
      this.statusBarView =
      this.observedFilesStatusView =
      this.observedFilesList =
        null;
    this.statusBarTile = this.observedFilesStatusTile = this.buildService = null;
    if (owner) {
      owner.retired = true;
      for (const edge of owner.statusEdges) edge.payload = null;
      for (const edge of owner.registryEdges) edge.record = null;
      owner.statusEdges.clear();
      owner.registryEdges.clear();
      const records = Array.from(owner.registryRecords.values());
      owner.registryRecords.clear();
      owner.linterProvider.register(null);
      for (const record of records) {
        const indie = record.indie;
        record.indie = record.factory = null;
        indie?.dispose();
      }
    }
    for (const request of pending) request.dispose();
    subscriptions?.dispose();
    owner?.statusTiles?.dispose();
    if (owner) owner.statusTiles = owner.currentBar = null;
    for (const tile of legacyTiles) tile?.destroy();
    for (const view of views) view?.destroy();
    service?.destroy();
    for (const info of observed) {
      info.disposable?.dispose();
      if (info.timeout) clearTimeout(info.timeout);
    }
    for (const info of processes) this.killProcess(info.process);
  },

  serialize() {
    return {};
  },

  // ============================================
  // SERVICE METHODS
  // ============================================

  consumeStatusBar(statusBar) {
    const owner = this.owner;
    if (!owns(this, owner)) return new Disposable();
    const edge = { payload: statusBar };
    owner.statusEdges.add(edge);
    const lease = new Disposable(() => {
      edge.payload = null;
      if (!owner.statusEdges.delete(edge)) return;
      owner.subscriptions.remove(lease);
      refreshStatus(this, owner);
    });
    owner.subscriptions.add(lease);
    queueMicrotask(() => refreshStatus(this, owner));
    return lease;
  },

  provideTypstTools() {
    log("Providing typst-tools service");
    return this.buildService;
  },

  consumeLinterRegistry(registerIndie) {
    const owner = this.owner;
    if (!owns(this, owner)) return new Disposable();
    let record = owner.registryRecords.get(registerIndie);
    const allocate = !record;
    if (!record) {
      record = { factory: registerIndie, references: 0, indie: null };
      owner.registryRecords.set(registerIndie, record);
    }
    record.references++;
    const edge = { record };
    owner.registryEdges.add(edge);
    const lease = new Disposable(() => {
      edge.record = null;
      if (!owner.registryEdges.delete(edge)) return;
      owner.subscriptions.remove(lease);
      if (--record.references === 0) {
        owner.registryRecords.delete(record.factory);
        const indie = record.indie;
        record.indie = record.factory = null;
        refreshIndie(this, owner);
        indie?.dispose();
      } else refreshIndie(this, owner);
    });
    owner.subscriptions.add(lease);
    if (allocate) {
      let indie;
      try {
        indie = registerIndie({ name: "Typst" });
      } catch (error) {
        lease.dispose();
        throw error;
      }
      if (!owns(this, owner) || owner.registryRecords.get(registerIndie) !== record)
        indie.dispose();
      else record.indie = indie;
    }
    refreshIndie(this, owner);
    return lease;
  },

  // ============================================
  // STATUS BAR MANAGEMENT
  // ============================================

  ensureStatusBarViews() {
    const owner = this.owner;
    if (!owns(this, owner)) return { statusBarView: null, observedFilesStatusView: null };
    if (!this.statusBarView) {
      const StatusBarView = require("./status-bar-view");
      const view = new StatusBarView({
        onCompile: () => this.compileFromStatusBar(),
        onOpenPdf: () => this.openPdfFromStatusBar(),
        onKillAndClean: () => this.killAndCleanFromStatusBar(),
        onToggleCompileOnSave: () => this.toggleCompileOnSave(),
      });
      if (!owns(this, owner)) {
        view.destroy();
        return { statusBarView: null, observedFilesStatusView: null };
      }
      this.statusBarView = view;
    }
    if (!this.observedFilesStatusView) {
      const ObservedFilesStatusView = require("./observed-status");
      const view = new ObservedFilesStatusView({
        onOpenObservedFiles: () => this.showObservedFiles(),
        onClearObservedFiles: () => this.clearCompileOnSaveFiles(),
      });
      if (!owns(this, owner)) {
        view.destroy();
        return { statusBarView: null, observedFilesStatusView: null };
      }
      this.observedFilesStatusView = view;
    }
    return {
      statusBarView: this.statusBarView,
      observedFilesStatusView: this.observedFilesStatusView,
    };
  },

  ensureObservedFilesList() {
    if (!this.observedFilesList) {
      const ObservedFilesList = require("./observed-list");
      this.observedFilesList = new ObservedFilesList(this);
    }
    return this.observedFilesList;
  },

  updateStatusBarForItem(item) {
    if (!item) {
      this.hideStatusBar();
    } else if (item.filePath && item.filePath.endsWith(".pdf")) {
      this.updateStatusBarVisibility(item, "pdf");
    } else if (lumine.workspace.isTextEditor(item)) {
      this.updateStatusBarVisibility(item, "editor");
    } else {
      this.hideStatusBar();
    }
  },

  hideStatusBar() {
    this.currentTypFile = null;
    this.statusBarView?.hide();
  },

  updateStatusBarVisibility(item, type) {
    if (!this.statusBarView) return;

    let filePath = null;

    if (type === "editor") {
      filePath = item.getPath();
      if (!filePath || !filePath.endsWith(".typ")) {
        this.hideStatusBar();
        return;
      }
    } else if (type === "pdf") {
      const typFilePath = item.filePath.replace(/\.pdf$/, ".typ");
      if (!fs.existsSync(typFilePath)) {
        this.hideStatusBar();
        return;
      }
      filePath = typFilePath;
    }

    if (!filePath) {
      this.hideStatusBar();
      return;
    }

    this.currentTypFile = filePath;

    // Get the build state for this file and update status bar
    const buildState = this.getBuildState(filePath);
    log("Restoring build state:", buildState.status, "for", path.basename(filePath));

    // Check if this file is currently building (has active process)
    const processInfo = this.buildProcesses.get(filePath);
    if (processInfo) {
      this.statusBarView.setStatus(buildState.status, buildState.message, { skipTimer: true });
      this.statusBarView.restoreTimer(processInfo.startTime);
    } else if (buildState.elapsedTime) {
      this.statusBarView.setStatus(buildState.status, buildState.message);
      this.statusBarView.showElapsedTime(buildState.elapsedTime);
    } else {
      this.statusBarView.setStatus(buildState.status, buildState.message);
    }

    // Update compile-on-save indicator
    if (type === "editor") {
      this.statusBarView.setCompileOnSave(this.isCompileOnSaveEnabled(item));
    } else {
      this.statusBarView.setCompileOnSave(false);
    }

    this.statusBarView.show();
  },

  setBuildState(filePath, status, message = "", timerInfo = {}) {
    const existingState = this.buildStates.get(filePath) || {};
    this.buildStates.set(filePath, {
      status,
      message,
      timestamp: Date.now(),
      startTime: timerInfo.startTime || existingState.startTime || null,
      elapsedTime: timerInfo.elapsedTime || null,
    });
    log(`Build state for ${path.basename(filePath)}: ${status}`);
  },

  getBuildState(filePath) {
    if (this.buildStates.has(filePath)) {
      return this.buildStates.get(filePath);
    }
    return {
      status: "idle",
      message: "Typst",
      timestamp: null,
      startTime: null,
      elapsedTime: null,
    };
  },

  isStatusBarActiveFor(filePath) {
    if (!this.statusBarView) return false;

    const activeEditor = lumine.workspace.getActiveTextEditor();
    if (activeEditor && activeEditor.getPath() === filePath) {
      return true;
    }
    return this.currentTypFile === filePath;
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

  async compile() {
    const owner = this.owner;
    if (!owns(this, owner)) return;
    const editor = lumine.workspace.getActiveTextEditor();
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    if (isPending(editor)) {
      const pane = lumine.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }

    const filePath = editor.getPath();
    const buffer = editor.getBuffer();
    const request = (this.compileRequest = (this.compileRequest || 0) + 1);
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".typ")) {
      lumine.notifications.addWarning("Not a Typst file");
      return;
    }

    // Check if already building this file
    if (this.buildProcesses.has(filePath)) {
      lumine.notifications.addWarning("Build already in progress", {
        detail: `${path.basename(filePath)} is currently being compiled.`,
        dismissable: true,
      });
      return;
    }

    // Save file before compiling
    if (editor.getFileState() !== "unmodified") {
      await editor.save();
    }

    if (
      !owns(this, owner) ||
      request !== this.compileRequest ||
      editor.isDestroyed() ||
      editor.getBuffer() !== buffer ||
      editor.getPath() !== filePath
    )
      return;
    return this.runCompilation(filePath);
  },

  runCompilation(filePath) {
    const owner = this.owner;
    if (!owns(this, owner) || this.buildProcesses.has(filePath)) return false;
    const processes = this.buildProcesses;
    const parser = this.outputParser;
    const linter = owner.linterProvider;
    const service = this.buildService;
    const { exePath, extraArgs } = this.resolveTypstPath();
    if (!owns(this, owner)) return false;
    if (!exePath) {
      lumine.notifications.addError("typst not found", {
        dismissable: true,
        description:
          "No typst binary found. Use **Typst Tools: Install Typst** from the command palette to download it, or set the path in settings.",
        buttons: [
          {
            text: "Install Typst",
            onDidClick: () => this.installTypst(),
          },
        ],
      });
      return false;
    }

    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);
    const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";

    // Build args
    const args = [...extraArgs, "compile"];

    // Add font paths
    const fontPaths = lumine.config.get(`${PACKAGE_NAME}.fontPaths`) || [];
    for (const fp of fontPaths) {
      if (fp) args.push("--font-path", fp);
    }

    // Add format if not default pdf
    if (format !== "pdf") {
      args.push("--format", format);
    }

    // Add additional args from config
    const additionalArgs = lumine.config.get(`${PACKAGE_NAME}.additionalArgs`) || [];
    args.push(...additionalArgs);

    // Add the file name as the last argument
    args.push(fileName);

    log(`Running: ${exePath} ${args.join(" ")}`);

    // Track build start time
    const startTime = Date.now();
    const record = { process: null, startTime, completed: false };
    processes.set(filePath, record);
    const current = () =>
      owns(this, owner) &&
      this.buildProcesses === processes &&
      processes.get(filePath) === record &&
      !record.completed;
    const canPublish = () =>
      owns(this, owner) && this.buildProcesses === processes && !processes.has(filePath);

    // Update status bar and store build state
    this.setBuildState(filePath, "building", `Compiling ${fileName}`, { startTime });

    if (this.isStatusBarActiveFor(filePath)) {
      this.statusBarView.setStatus("building", `Compiling ${fileName}`);
    }

    lumine.notifications.addInfo(`Compiling ${fileName}…`);
    if (!current()) return false;

    // Clear linter messages at start of compilation
    linter.clearMessages();
    if (!current()) return false;

    // Notify build service
    record.serviceRecord = service?.startBuild(filePath);
    if (!current()) return false;

    let stderr = "";

    const childProcess = spawn(exePath, args, {
      cwd: fileDir,
      shell: false,
      detached: process.platform !== "win32",
    });

    // Store the process reference
    record.process = childProcess;
    if (!current()) {
      this.killProcess(childProcess);
      return false;
    }

    // Capture stderr (typst sends diagnostics to stderr)
    childProcess.stderr.on("data", (data) => {
      if (current()) stderr += data.toString();
    });

    // Handle process exit
    childProcess.on("exit", (code, signal) => {
      if (!current()) return;
      record.completed = true;
      const elapsedTime = Date.now() - startTime;
      processes.delete(filePath);

      // Check if process was killed by signal (interrupted)
      if (signal) {
        log(`Process terminated by signal: ${signal}`);
        this.setBuildState(filePath, "idle", "Build interrupted");
        if (this.isStatusBarActiveFor(filePath))
          this.statusBarView.setStatus("idle", "Build interrupted");
        service?.failBuild(filePath, `Build interrupted by ${signal}`, "", record.serviceRecord);
        return;
      }

      if (code === 0) {
        try {
          // Parse stderr for warnings even on success
          const messages = parser.parse(stderr, filePath);

          if (messages.length > 0) {
            linter.setMessages(messages);
          }
          if (!canPublish()) return;
          service?.updateMessages(filePath, messages);
          if (!canPublish()) return;

          this.setBuildState(filePath, "success", `${fileName} compiled successfully`, {
            startTime,
            elapsedTime,
          });

          if (this.isStatusBarActiveFor(filePath)) {
            this.statusBarView.setStatus("success", `${fileName} compiled successfully`);
            this.statusBarView.showElapsedTime(elapsedTime);
          }

          lumine.notifications.addSuccess(`${fileName} compiled successfully`, {
            detail: `Completed in ${Math.floor(elapsedTime / 1000)}s`,
          });
        } finally {
          service?.finishBuild(filePath, stderr, elapsedTime, record.serviceRecord);
        }
      } else {
        try {
          // Parse stderr for error messages
          let messages = parser.parse(stderr, filePath);

          // If no errors found in output, create fallback message
          if (messages.length === 0) {
            messages = [
              {
                severity: "error",
                excerpt: `Compilation failed (exit code ${code})`,
                location: {
                  file: path.basename(filePath),
                  fullPath: filePath,
                  position: {
                    start: { row: 0, column: 0 },
                    end: { row: 0, column: 0 },
                  },
                },
              },
            ];
          }

          parser.messages = messages;
          linter.setMessages(messages);
          if (!canPublish()) return;

          this.setBuildState(filePath, "error", `Compilation failed (exit code ${code})`, {
            startTime,
            elapsedTime,
          });

          if (this.isStatusBarActiveFor(filePath)) {
            this.statusBarView.setStatus("error", `Compilation failed`);
            this.statusBarView.showElapsedTime(elapsedTime);
          }

          lumine.notifications.addError(`${fileName} compilation failed`, {
            detail: `Exit code ${code}\nCompleted in ${Math.floor(elapsedTime / 1000)}s`,
            dismissable: true,
          });

          if (canPublish()) service?.updateMessages(filePath, messages);
        } finally {
          service?.failBuild(filePath, `Exit code ${code}`, stderr, record.serviceRecord);
        }
      }
    });

    // Handle process errors (e.g., command not found)
    childProcess.on("error", (error) => {
      if (!current()) return;
      record.completed = true;
      const elapsedTime = Date.now() - startTime;
      processes.delete(filePath);
      parser.parse("", filePath);

      this.setBuildState(filePath, "error", "typst not found", { startTime, elapsedTime });

      if (this.isStatusBarActiveFor(filePath)) {
        this.statusBarView.setStatus("error", "typst not found");
        this.statusBarView.showElapsedTime(elapsedTime);
      }

      lumine.notifications.addError("Failed to run typst", {
        detail: `Make sure typst is installed and in your PATH.\n\nError: ${error.message}`,
        dismissable: true,
        buttons: [
          {
            text: "Install Typst",
            onDidClick: () => this.installTypst(),
          },
        ],
      });

      service?.failBuild(filePath, "typst not found", error.message, record.serviceRecord);
    });
    return true;
  },

  // ============================================
  // COMPILE ON SAVE
  // ============================================

  toggleCompileOnSave() {
    const editor = lumine.workspace.getActiveTextEditor();
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    if (isPending(editor)) {
      const pane = lumine.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }

    const filePath = editor.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".typ")) {
      lumine.notifications.addWarning("Not a Typst file");
      return;
    }

    const fileName = path.basename(filePath);
    const enabled = this.isCompileOnSaveEnabledForFile(filePath);

    if (this.setCompileOnSaveForFile(filePath, !enabled)) {
      if (enabled) {
        lumine.notifications.addHint(`Compile on save disabled for ${fileName}`);
        log(`Compile on save disabled for ${fileName}`);
      } else {
        lumine.notifications.addHint(`Compile on save enabled for ${fileName}`);
        log(`Compile on save enabled for ${fileName}`);
      }
    }

    // Update status bar to reflect compile-on-save state
    this.updateStatusBarVisibility(editor, "editor");
  },

  getCompileOnSaveKey(filePath) {
    return normalizePathForTypst(path.resolve(filePath));
  },

  isCompileOnSaveEnabledForFile(filePath) {
    if (!filePath || !filePath.endsWith(".typ")) {
      return false;
    }

    return this.compileOnSaveFiles.has(this.getCompileOnSaveKey(filePath));
  },

  setCompileOnSaveForFile(filePath, enabled) {
    if (!filePath || !filePath.endsWith(".typ")) {
      return false;
    }

    const key = this.getCompileOnSaveKey(filePath);
    const currentlyEnabled = this.compileOnSaveFiles.has(key);

    if (enabled === currentlyEnabled) {
      return false;
    }

    if (!enabled) {
      const info = this.compileOnSaveFiles.get(key);
      if (info?.disposable) {
        info.disposable.dispose();
      }
      if (info?.timeout) {
        clearTimeout(info.timeout);
      }
      this.compileOnSaveFiles.delete(key);
      this.updateObservedFilesStatus();
      return true;
    }

    const resolvedFilePath = path.resolve(filePath);
    const info = {
      filePath: resolvedFilePath,
      timeout: null,
      disposable: null,
      file: null,
    };

    const scheduleCompile = () => {
      if (info.timeout) {
        clearTimeout(info.timeout);
      }

      info.timeout = setTimeout(() => {
        info.timeout = null;
        this.compileFilePath(resolvedFilePath);
      }, 150);
    };

    try {
      // Keep the configured source path observed after its editor is closed.
      info.file = watchFile(resolvedFilePath);
      info.disposable = new CompositeDisposable(
        info.file,
        info.file.onDidChange(scheduleCompile),
        info.file.onDidInvalidate(scheduleCompile),
        info.file.onDidError((error) => log("Unable to watch Typst source:", error.message)),
      );
    } catch (error) {
      log("Failed to observe compile-on-save file:", error.message);
      return false;
    }

    this.compileOnSaveFiles.set(key, info);
    this.updateObservedFilesStatus();
    return true;
  },

  getCompileOnSaveFiles() {
    return Array.from(this.compileOnSaveFiles.values(), (info) => info.filePath);
  },

  isCompileOnSaveEnabled(editor) {
    if (!editor) return false;
    return this.isCompileOnSaveEnabledForFile(editor.getPath());
  },

  showObservedFiles() {
    return this.ensureObservedFilesList().show();
  },

  updateObservedFilesStatus() {
    if (this.observedFilesStatusView) {
      this.observedFilesStatusView.setCount(this.getCompileOnSaveFiles().length);
    }
  },

  clearCompileOnSaveFiles() {
    const count = this.compileOnSaveFiles.size;
    if (count === 0) {
      return;
    }

    for (const info of this.compileOnSaveFiles.values()) {
      if (info.disposable) {
        info.disposable.dispose();
      }
      if (info.timeout) {
        clearTimeout(info.timeout);
      }
    }

    this.compileOnSaveFiles.clear();
    this.updateObservedFilesStatus();
    if (this.observedFilesList) {
      this.observedFilesList.update();
    }
    if (this.statusBarView) {
      this.statusBarView.setCompileOnSave(false);
    }
  },

  compileFilePath(filePath) {
    if (!filePath || !filePath.endsWith(".typ")) return;

    // Skip if already building this file
    if (this.buildProcesses.has(filePath)) {
      log(`Skipping compile-on-save, build already in progress for ${path.basename(filePath)}`);
      return;
    }

    this.runCompilation(filePath);
  },

  // ============================================
  // PROCESS MANAGEMENT
  // ============================================

  killProcess(childProcess) {
    if (!childProcess) return;

    if (process.platform === "win32") {
      const taskkill = spawn("taskkill", ["/pid", childProcess.pid.toString(), "/T", "/F"]);
      taskkill.on("exit", () => {
        log(`Process tree killed for PID ${childProcess.pid}`);
      });
    } else {
      try {
        process.kill(-childProcess.pid, "SIGTERM");
      } catch (error) {
        log("Failed to kill process group:", error.message);
        childProcess.kill("SIGTERM");
      }
    }
  },

  interrupt() {
    const editor = lumine.workspace.getActiveTextEditor();
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath || !filePath.endsWith(".typ")) {
      lumine.notifications.addWarning("Not a Typst file");
      return;
    }

    const processInfo = this.buildProcesses.get(filePath);
    if (!processInfo) {
      lumine.notifications.addInfo("No build process running for this file");
      return;
    }

    this.killProcess(processInfo.process);
    this.buildProcesses.delete(filePath);

    this.setBuildState(filePath, "idle", "Build interrupted");
    if (this.isStatusBarActiveFor(filePath)) {
      this.statusBarView.setStatus("idle", "Build interrupted");
    }

    if (this.buildService) {
      this.buildService.failBuild(filePath, "Build interrupted by user", "");
    }

    lumine.notifications.addInfo(`Build interrupted for ${path.basename(filePath)}`);
  },

  interruptAll() {
    const count = this.interruptAllProcesses();
    if (count === 0) {
      lumine.notifications.addInfo("No processes running");
    } else {
      lumine.notifications.addInfo(`Interrupted ${count} process(es)`);
    }
  },

  /**
   * Interrupt all builds (API method)
   * @returns {number} Number of processes interrupted
   */
  interruptAllProcesses() {
    let count = 0;

    // Kill all build processes
    for (const [filePath, processInfo] of this.buildProcesses) {
      this.killProcess(processInfo.process);
      this.setBuildState(filePath, "idle", "Build interrupted");
      if (this.buildService) {
        this.buildService.failBuild(filePath, "Build interrupted by user", "");
      }
      count++;
    }
    this.buildProcesses.clear();

    // Update status bar for current file
    const editor = lumine.workspace.getActiveTextEditor();
    if (editor && this.statusBarView) {
      const filePath = editor.getPath();
      if (filePath && filePath.endsWith(".typ")) {
        this.statusBarView.setStatus("idle");
      }
    }

    this.cleanLinter();
    return count;
  },

  /**
   * Interrupt a specific file's build (API method)
   * @param {string} filePath
   * @returns {boolean}
   */
  interruptFile(filePath) {
    if (!filePath || !filePath.endsWith(".typ")) return false;

    const processInfo = this.buildProcesses.get(filePath);
    if (!processInfo) return false;

    this.killProcess(processInfo.process);
    this.buildProcesses.delete(filePath);

    this.setBuildState(filePath, "idle", "Build interrupted");
    if (this.isStatusBarActiveFor(filePath)) {
      this.statusBarView.setStatus("idle");
    }

    if (this.buildService) {
      this.buildService.failBuild(filePath, "Build interrupted by user", "");
    }

    return true;
  },

  // ============================================
  // PDF OPENING
  // ============================================

  openPdf() {
    const editor = lumine.workspace.getActiveTextEditor();
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath || !filePath.endsWith(".typ")) {
      lumine.notifications.addWarning("Not a Typst file");
      return;
    }

    const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const outputPath = getOutputPath(filePath, format);

    // Check if build is in progress
    if (this.buildProcesses.has(filePath)) {
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

    this._openPdfDirect(outputPath);
  },

  _openPdfDirect(outputPath) {
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
        this._openPdfDirect(pending.outputPath);
      }, 100);
    };

    disposable.add(
      this.buildService.onDidFinishBuild((data) => {
        if (normalizePathForTypst(path.resolve(data.file)) === key) openAfterBuild();
      }),
      this.buildService.onDidFailBuild((data) => {
        if (normalizePathForTypst(path.resolve(data.file)) === key) {
          pending.dispose();
        }
      }),
    );
  },

  clearPendingPdfOpens() {
    for (const pending of this.pendingPdfOpens?.values() || []) {
      pending.dispose();
    }
  },

  /**
   * Open PDF for a file (API method)
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async openPdfForFile(filePath) {
    if (!filePath || !filePath.endsWith(".typ")) return false;

    const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const outputPath = getOutputPath(filePath, format);

    if (!fs.existsSync(outputPath)) return false;

    try {
      await lumine.workspace.open(outputPath, { searchAllPanes: true });
      return true;
    } catch (error) {
      log("Failed to open PDF:", error.message);
      return false;
    }
  },

  // ============================================
  // STATUS BAR CALLBACKS
  // ============================================

  async compileFromStatusBar() {
    if (!this.currentTypFile) return;

    // If viewing a PDF, try to compile the corresponding .typ
    const activeItem = lumine.workspace.getCenter().getActivePaneItem();
    if (activeItem && activeItem.filePath && activeItem.filePath.endsWith(".pdf")) {
      const typFile = activeItem.filePath.replace(/\.pdf$/, ".typ");
      const typEditor = lumine.workspace
        .getTextEditors()
        .find((editor) => editor.getPath() === typFile);
      if (typEditor && typEditor.getFileState() !== "unmodified") {
        await typEditor.save();
      }
      if (fs.existsSync(typFile)) {
        this.runCompilation(typFile);
        return;
      }
    }

    // Otherwise compile from editor
    await this.compile();
  },

  openPdfFromStatusBar() {
    if (!this.currentTypFile) return;

    const activeItem = lumine.workspace.getCenter().getActivePaneItem();

    if (activeItem && activeItem.filePath && activeItem.filePath.endsWith(".pdf")) {
      // From PDF view - open .typ in left pane
      const typFile = activeItem.filePath.replace(/\.pdf$/, ".typ");
      if (fs.existsSync(typFile)) {
        lumine.workspace.open(typFile, { split: "left", searchAllPanes: true });
      }
    } else {
      // From editor - open PDF in right pane
      const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
      const outputPath = getOutputPath(this.currentTypFile, format);
      if (fs.existsSync(outputPath)) {
        lumine.workspace.open(outputPath, { split: "right", searchAllPanes: true });
      } else {
        lumine.notifications.addWarning("Output file not found. Compile first.");
      }
    }
  },

  killAndCleanFromStatusBar() {
    if (!this.currentTypFile) return;

    // Interrupt any running process for this file
    this.interruptFile(this.currentTypFile);
    this.cleanLinter();
  },

  // ============================================
  // LINTER
  // ============================================

  cleanLinter() {
    if (this.linterProvider) {
      this.linterProvider.clearMessages();
    }
  },

  // ============================================
  // API DELEGATION METHODS
  // ============================================

  getMessages(filePath = null) {
    if (!filePath) {
      const editor = lumine.workspace.getActiveTextEditor();
      if (editor) filePath = editor.getPath();
    }
    if (!filePath || !filePath.endsWith(".typ")) return [];
    if (
      !this.outputParser?.compilationRoot ||
      normalizePathForTypst(path.resolve(filePath)) !==
        normalizePathForTypst(path.resolve(this.outputParser.compilationRoot))
    )
      return [];
    return this.outputParser.messages || [];
  },

  getMessageStatistics(filePath = null) {
    const messages = this.getMessages(filePath);
    return {
      total: messages.length,
      errors: messages.filter((m) => m.severity === "error").length,
      warnings: messages.filter((m) => m.severity === "warning").length,
    };
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
      const result = await installer.install();
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
