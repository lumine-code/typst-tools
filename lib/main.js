const { CompositeDisposable, Disposable, watchFile } = require("atom");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const StatusBarView = require("./status-bar-view");
const BuildService = require("./build-service");
const OutputParser = require("./output-parser");
const LinterProvider = require("./linter-provider");
const ObservedFilesList = require("./observed-list");
const ObservedFilesStatusView = require("./observed-status");
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
  const pane = atom.workspace.getActivePane();
  return pane ? pane.getPendingItem() === item : false;
}

function log(...args) {
  if (atom.config.get(`${PACKAGE_NAME}.debug`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

/**
 * Typst Tools Package
 * Provides Typst compilation, compile-on-save, PDF viewing, and error parsing.
 */
module.exports = {
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
  compileOnSaveFiles: null, // Track file paths with compile-on-save enabled
  currentTypFile: null,

  /**
   * Activates the package and registers Typst commands.
   */
  activate() {
    this.subscriptions = new CompositeDisposable();
    this.buildService = new BuildService();
    this.buildService.setMainModule(this);
    this.outputParser = new OutputParser();
    this.linterProvider = new LinterProvider();
    this.observedFilesList = new ObservedFilesList(this);
    this.observedFilesStatusView = new ObservedFilesStatusView({
      onOpenObservedFiles: () => this.showObservedFiles(),
      onClearObservedFiles: () => this.clearCompileOnSaveFiles(),
    });
    this.statusBarView = new StatusBarView({
      onCompile: () => this.compileFromStatusBar(),
      onOpenPdf: () => this.openPdfFromStatusBar(),
      onKillAndClean: () => this.killAndCleanFromStatusBar(),
      onToggleCompileOnSave: () => this.toggleCompileOnSave(),
    });
    this.buildStates = new Map();
    this.buildProcesses = new Map();
    this.compileOnSaveFiles = new Map();

    // Register commands
    this.subscriptions.add(
      atom.commands.add('atom-text-editor[data-grammar~="typst"]', {
        "typst-tools:compile": () => this.compile(),
        "typst-tools:watch": () => this.toggleCompileOnSave(),
        "typst-tools:open-pdf": () => this.openPdf(),
        "typst-tools:interrupt": () => this.interrupt(),
        "typst-tools:interrupt-all": () => this.interruptAll(),
        "typst-tools:clean-linter": () => this.cleanLinter(),
        "typst-tools:list-fonts": () => this.listFonts(),
      }),
      atom.commands.add("atom-workspace", {
        "typst-tools:install-typst": () => this.installTypst(),
        "typst-tools:observed-files": () => this.showObservedFiles(),
        "typst-tools:clear-all-observed-files": () => this.clearCompileOnSaveFiles(),
      }),
      // Track active pane item changes (text editors and PDF viewers)
      atom.workspace.getCenter().observeActivePaneItem((item) => {
        if (!item) {
          this.statusBarView.hide();
        } else if (item.filePath && item.filePath.endsWith(".pdf")) {
          // PDF viewer - show status bar if adjacent .typ exists
          this.updateStatusBarVisibility(item, "pdf");
        } else if (atom.workspace.isTextEditor(item)) {
          // Text editor - show status bar if .typ file
          this.updateStatusBarVisibility(item, "editor");
        } else {
          this.statusBarView.hide();
        }
      }),
    );
  },

  /**
   * Deactivates the package and cleans up resources.
   */
  deactivate() {
    // Kill all running build processes
    if (this.buildProcesses) {
      for (const processInfo of this.buildProcesses.values()) {
        this.killProcess(processInfo.process);
      }
      this.buildProcesses.clear();
    }

    // Clean up compile-on-save observers
    if (this.compileOnSaveFiles) {
      for (const info of this.compileOnSaveFiles.values()) {
        if (info.disposable) {
          info.disposable.dispose();
        }
        if (info.timeout) {
          clearTimeout(info.timeout);
        }
      }
      this.compileOnSaveFiles.clear();
    }

    if (this.subscriptions) this.subscriptions.dispose();
    if (this.statusBarTile) this.statusBarTile.destroy();
    if (this.observedFilesStatusTile) {
      this.observedFilesStatusTile.destroy();
      this.observedFilesStatusTile = null;
    }
    if (this.statusBarView) this.statusBarView.destroy();
    if (this.observedFilesStatusView) {
      this.observedFilesStatusView.destroy();
      this.observedFilesStatusView = null;
    }
    if (this.buildService) this.buildService.destroy();
    if (this.observedFilesList) {
      this.observedFilesList.destroy();
      this.observedFilesList = null;
    }
  },

  serialize() {
    return {};
  },

  // ============================================
  // SERVICE METHODS
  // ============================================

  consumeStatusBar(statusBar) {
    this.statusBarTile = statusBar.addLeftTile({
      item: this.statusBarView.getElement(),
      priority: 0,
    });
    this.observedFilesStatusTile = statusBar.addRightTile({
      item: this.observedFilesStatusView.getElement(),
      priority: 0,
    });
    this.updateObservedFilesStatus();

    const activeEditor = atom.workspace.getActiveTextEditor();
    if (activeEditor) {
      this.updateStatusBarVisibility(activeEditor, "editor");
    }
  },

  provideTypstTools() {
    log("Providing typst-tools service");
    return this.buildService;
  },

  consumeIndie(registerIndie) {
    log("Consuming linter-indie service");
    const linter = registerIndie({
      name: "Typst",
    });
    this.subscriptions.add(linter);
    this.linterProvider.register(linter);
    log("Linter indie instance registered");
  },

  // ============================================
  // STATUS BAR MANAGEMENT
  // ============================================

  updateStatusBarVisibility(item, type) {
    if (!this.statusBarView) return;

    let filePath = null;

    if (type === "editor") {
      filePath = item.getPath();
      if (!filePath || !filePath.endsWith(".typ")) {
        this.statusBarView.hide();
        return;
      }
    } else if (type === "pdf") {
      const typFilePath = item.filePath.replace(/\.pdf$/, ".typ");
      if (!fs.existsSync(typFilePath)) {
        this.statusBarView.hide();
        return;
      }
      filePath = typFilePath;
    }

    if (!filePath) {
      this.currentTypFile = null;
      this.statusBarView.hide();
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
    const activeEditor = atom.workspace.getActiveTextEditor();
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
    const command = atom.config.get(`${PACKAGE_NAME}.typstPath`) || "typst";

    // Custom command (user changed from default)
    if (command !== "typst") {
      const [exe, ...extraArgs] = command.trim().split(/\s+/);
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

  compile() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    if (isPending(editor)) {
      const pane = atom.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".typ")) {
      atom.notifications.addWarning("Not a Typst file");
      return;
    }

    // Check if already building this file
    if (this.buildProcesses.has(filePath)) {
      atom.notifications.addWarning("Build already in progress", {
        detail: `${path.basename(filePath)} is currently being compiled.`,
        dismissable: true,
      });
      return;
    }

    // Save file before compiling
    if (editor.isModified()) {
      editor.save();
    }

    this.runCompilation(filePath);
  },

  runCompilation(filePath) {
    const { exePath, extraArgs } = this.resolveTypstPath();
    if (!exePath) {
      atom.notifications.addError("typst not found", {
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
      return;
    }

    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);
    const format = atom.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";

    // Build args
    const args = [...extraArgs, "compile"];

    // Add font paths
    const fontPaths = atom.config.get(`${PACKAGE_NAME}.fontPaths`) || [];
    for (const fp of fontPaths) {
      if (fp) args.push("--font-path", fp);
    }

    // Add format if not default pdf
    if (format !== "pdf") {
      args.push("--format", format);
    }

    // Add additional args from config
    const additionalArgs = atom.config.get(`${PACKAGE_NAME}.additionalArgs`) || [];
    args.push(...additionalArgs);

    // Add the file name as the last argument
    args.push(fileName);

    log(`Running: ${exePath} ${args.join(" ")}`);

    // Track build start time
    const startTime = Date.now();

    // Update status bar and store build state
    this.setBuildState(filePath, "building", `Compiling ${fileName}`, { startTime });

    if (this.isStatusBarActiveFor(filePath)) {
      this.statusBarView.setStatus("building", `Compiling ${fileName}`);
    }

    // Clear linter messages at start of compilation
    this.linterProvider.clearMessages();

    // Notify build service
    if (this.buildService) {
      this.buildService.startBuild(filePath);
    }

    let stderr = "";

    const childProcess = spawn(exePath, args, {
      cwd: fileDir,
      shell: false,
      detached: process.platform !== "win32",
    });

    // Store the process reference
    this.buildProcesses.set(filePath, {
      process: childProcess,
      startTime,
    });

    // Capture stderr (typst sends diagnostics to stderr)
    childProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Handle process exit
    childProcess.on("exit", (code, signal) => {
      const elapsedTime = Date.now() - startTime;
      this.buildProcesses.delete(filePath);

      // Check if process was killed by signal (interrupted)
      if (signal) {
        log(`Process terminated by signal: ${signal}`);
        return;
      }

      if (code === 0) {
        // Parse stderr for warnings even on success
        let messages = [];
        if (stderr.trim()) {
          messages = this.outputParser.parse(stderr, filePath);
        }

        if (messages.length > 0) {
          this.linterProvider.setMessages(messages);
          if (this.buildService) {
            this.buildService.updateMessages(filePath, messages);
          }
        }

        this.setBuildState(filePath, "success", `${fileName} compiled successfully`, {
          startTime,
          elapsedTime,
        });

        if (this.isStatusBarActiveFor(filePath)) {
          this.statusBarView.setStatus("success", `${fileName} compiled successfully`);
          this.statusBarView.showElapsedTime(elapsedTime);
        }

        atom.notifications.addSuccess(`${fileName} compiled successfully`, {
          detail: `Completed in ${Math.floor(elapsedTime / 1000)}s`,
        });

        if (this.buildService) {
          this.buildService.finishBuild(filePath, stderr, elapsedTime);
        }
      } else {
        // Parse stderr for error messages
        let messages = [];
        if (stderr.trim()) {
          messages = this.outputParser.parse(stderr, filePath);
        }

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

        this.linterProvider.setMessages(messages);

        this.setBuildState(filePath, "error", `Compilation failed (exit code ${code})`, {
          startTime,
          elapsedTime,
        });

        if (this.isStatusBarActiveFor(filePath)) {
          this.statusBarView.setStatus("error", `Compilation failed`);
          this.statusBarView.showElapsedTime(elapsedTime);
        }

        atom.notifications.addError(`${fileName} compilation failed`, {
          detail: `Exit code ${code}\nCompleted in ${Math.floor(elapsedTime / 1000)}s`,
          dismissable: true,
        });

        if (this.buildService) {
          this.buildService.updateMessages(filePath, messages);
          this.buildService.failBuild(filePath, `Exit code ${code}`, stderr);
        }
      }
    });

    // Handle process errors (e.g., command not found)
    childProcess.on("error", (error) => {
      const elapsedTime = Date.now() - startTime;
      this.buildProcesses.delete(filePath);

      this.setBuildState(filePath, "error", "typst not found", { startTime, elapsedTime });

      if (this.isStatusBarActiveFor(filePath)) {
        this.statusBarView.setStatus("error", "typst not found");
        this.statusBarView.showElapsedTime(elapsedTime);
      }

      atom.notifications.addError("Failed to run typst", {
        detail: `Make sure typst is installed and in your PATH.\n\nError: ${error.message}`,
        dismissable: true,
        buttons: [
          {
            text: "Install Typst",
            onDidClick: () => this.installTypst(),
          },
        ],
      });

      if (this.buildService) {
        this.buildService.failBuild(filePath, "typst not found", error.message);
      }
    });
  },

  // ============================================
  // COMPILE ON SAVE
  // ============================================

  toggleCompileOnSave() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    if (isPending(editor)) {
      const pane = atom.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".typ")) {
      atom.notifications.addWarning("Not a Typst file");
      return;
    }

    const fileName = path.basename(filePath);
    const enabled = this.isCompileOnSaveEnabledForFile(filePath);

    if (this.setCompileOnSaveForFile(filePath, !enabled)) {
      if (enabled) {
        atom.notifications.addInfo(`Compile on save disabled for ${fileName}`);
        log(`Compile on save disabled for ${fileName}`);
      } else {
        atom.notifications.addSuccess(`Compile on save enabled for ${fileName}`);
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
      // The synchronous atom `File` was removed from Lumine; `watchFile` is the
      // async replacement. It owns a native watcher that must be disposed —
      // the event subscription alone does not stop it. Watching the path rather
      // than the editor is what keeps compile-on-save running in the background
      // after the file's editor is closed.
      info.file = watchFile(resolvedFilePath);
      info.disposable = new CompositeDisposable(
        new Disposable(() => info.file.dispose()),
        info.file.onDidChange(scheduleCompile),
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
    if (this.observedFilesList) {
      this.observedFilesList.show();
    }
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

    atom.notifications.addInfo(`Cleared ${count} observed file${count === 1 ? "" : "s"}`);
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
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    const filePath = editor.getPath();
    if (!filePath || !filePath.endsWith(".typ")) {
      atom.notifications.addWarning("Not a Typst file");
      return;
    }

    const processInfo = this.buildProcesses.get(filePath);
    if (!processInfo) {
      atom.notifications.addInfo("No build process running for this file");
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

    atom.notifications.addInfo(`Build interrupted for ${path.basename(filePath)}`);
  },

  interruptAll() {
    const count = this.interruptAllProcesses();
    if (count === 0) {
      atom.notifications.addInfo("No processes running");
    } else {
      atom.notifications.addInfo(`Interrupted ${count} process(es)`);
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
    const editor = atom.workspace.getActiveTextEditor();
    if (editor) {
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
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    const filePath = editor.getPath();
    if (!filePath || !filePath.endsWith(".typ")) {
      atom.notifications.addWarning("Not a Typst file");
      return;
    }

    const format = atom.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const outputPath = getOutputPath(filePath, format);

    // Check if build is in progress
    if (this.buildProcesses.has(filePath)) {
      this.waitForBuildAndOpen(filePath, outputPath);
      return;
    }

    if (!fs.existsSync(outputPath)) {
      atom.notifications.addWarning("Output file not found", {
        detail: `Expected file: ${outputPath}\n\nPlease compile the Typst file first.`,
        dismissable: true,
      });
      return;
    }

    atom.workspace
      .open(outputPath, { searchAllPanes: true })
      .then(() => {
        atom.notifications.addInfo(`Opened ${path.basename(outputPath)}`);
      })
      .catch((error) => {
        atom.notifications.addError("Failed to open output file", {
          detail: error.message,
          dismissable: true,
        });
      });
  },

  waitForBuildAndOpen(filePath, outputPath) {
    const disposable = new CompositeDisposable();

    const openAfterBuild = () => {
      disposable.dispose();
      setTimeout(() => {
        atom.workspace.open(outputPath, { searchAllPanes: true });
      }, 100);
    };

    disposable.add(
      this.buildService.onDidFinishBuild((data) => {
        if (data.file === filePath) openAfterBuild();
      }),
      this.buildService.onDidFailBuild((data) => {
        if (data.file === filePath) {
          disposable.dispose();
          atom.notifications.addWarning("Build failed", {
            detail: "Output file may be incomplete or outdated.",
            dismissable: true,
          });
        }
      }),
    );

    atom.notifications.addInfo("Waiting for compilation to finish...", {
      description: "The output will open automatically when the build completes.",
      dismissable: true,
    });
  },

  /**
   * Open PDF for a file (API method)
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async openPdfForFile(filePath) {
    if (!filePath || !filePath.endsWith(".typ")) return false;

    const format = atom.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const outputPath = getOutputPath(filePath, format);

    if (!fs.existsSync(outputPath)) return false;

    try {
      await atom.workspace.open(outputPath, { searchAllPanes: true });
      return true;
    } catch (error) {
      log("Failed to open PDF:", error.message);
      return false;
    }
  },

  // ============================================
  // STATUS BAR CALLBACKS
  // ============================================

  compileFromStatusBar() {
    if (!this.currentTypFile) return;

    // If viewing a PDF, try to compile the corresponding .typ
    const activeItem = atom.workspace.getCenter().getActivePaneItem();
    if (activeItem && activeItem.filePath && activeItem.filePath.endsWith(".pdf")) {
      const typFile = activeItem.filePath.replace(/\.pdf$/, ".typ");
      if (fs.existsSync(typFile)) {
        // Save the .typ file if open and modified
        for (const editor of atom.workspace.getTextEditors()) {
          if (editor.getPath() === typFile && editor.isModified()) {
            editor.save();
            break;
          }
        }
        this.runCompilation(typFile);
        return;
      }
    }

    // Otherwise compile from editor
    this.compile();
  },

  openPdfFromStatusBar() {
    if (!this.currentTypFile) return;

    const activeItem = atom.workspace.getCenter().getActivePaneItem();

    if (activeItem && activeItem.filePath && activeItem.filePath.endsWith(".pdf")) {
      // From PDF viewer - open .typ in left pane
      const typFile = activeItem.filePath.replace(/\.pdf$/, ".typ");
      if (fs.existsSync(typFile)) {
        atom.workspace.open(typFile, { split: "left", searchAllPanes: true });
      }
    } else {
      // From editor - open PDF in right pane
      const format = atom.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
      const outputPath = getOutputPath(this.currentTypFile, format);
      if (fs.existsSync(outputPath)) {
        atom.workspace.open(outputPath, { split: "right", searchAllPanes: true });
      } else {
        atom.notifications.addWarning("Output file not found. Compile first.");
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
      const editor = atom.workspace.getActiveTextEditor();
      if (editor) filePath = editor.getPath();
    }
    if (!filePath || !filePath.endsWith(".typ")) return [];
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
      atom.notifications.addError("typst not found", {
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
      atom.notifications.addInfo("Available Fonts", {
        detail: result,
        dismissable: true,
      });
    } catch (error) {
      atom.notifications.addError("Failed to list fonts", {
        detail: error.message,
        dismissable: true,
      });
    }
  },

  async installTypst() {
    const notification = atom.notifications.addInfo("Downloading typst...", {
      dismissable: true,
      description: `Platform: ${process.platform}-${process.arch}`,
    });

    try {
      const result = await installer.install();
      notification.dismiss();
      atom.notifications.addSuccess(`Typst ${result.version} installed.`, {
        description: `Binary: \`${result.path}\``,
        dismissable: true,
      });
      log(`Installed typst ${result.version} to ${result.path}`);
    } catch (err) {
      notification.dismiss();
      atom.notifications.addError("Failed to install typst.", {
        dismissable: true,
        description: err.message,
      });
      log("Install error:", err.message);
    }
  },
};
