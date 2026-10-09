const { Emitter } = require("lumine");

const PACKAGE_NAME = "typst-tools";

function log(...args) {
  if (lumine.config.get(`${PACKAGE_NAME}.debug`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

/**
 * Typst Tools Build Service API
 *
 * Provides a public API for other packages (e.g., pdf-view) to interact
 * with typst-tools. Exposes build status, compilation control, log messages,
 * and compile-on-save functionality.
 *
 * @example
 * consumeTypstTools(service) {
 *   service.onDidFinishBuild(({ file, output }) => {
 *     console.log(`Build finished: ${file}`);
 *   });
 *   service.compile('/path/to/file.typ');
 * }
 */
module.exports = class BuildService {
  constructor() {
    log("Creating BuildService");
    this.emitter = new Emitter();
    this.buildingFiles = new Map();
    this.mainModule = null;
  }

  /**
   * Set reference to main module (called during activation)
   * @private
   */
  setMainModule(mainModule) {
    this.mainModule = mainModule;
  }

  // ============================================
  // BUILD EVENTS
  // ============================================

  /**
   * Subscribe to build start events
   * @param {Function} callback - Called with { file: string }
   * @returns {Disposable}
   */
  onDidStartBuild(callback) {
    log("BuildService: Registered onDidStartBuild callback");
    return this.emitter.on("did-start-build", callback);
  }

  /**
   * Subscribe to successful build completion events
   * @param {Function} callback - Called with { file: string, output: string, elapsedTime: number }
   * @returns {Disposable}
   */
  onDidFinishBuild(callback) {
    log("BuildService: Registered onDidFinishBuild callback");
    return this.emitter.on("did-finish-build", callback);
  }

  /**
   * Subscribe to build failure events
   * @param {Function} callback - Called with { file: string, error: string, output: string }
   * @returns {Disposable}
   */
  onDidFailBuild(callback) {
    log("BuildService: Registered onDidFailBuild callback");
    return this.emitter.on("did-fail-build", callback);
  }

  /**
   * Subscribe to any build status change
   * @param {Function} callback - Called with { file: string, status: string, error?: string }
   * @returns {Disposable}
   */
  onDidChangeBuildStatus(callback) {
    log("BuildService: Registered onDidChangeBuildStatus callback");
    return this.emitter.on("did-change-build-status", callback);
  }

  /**
   * Subscribe to log messages update events
   * @param {Function} callback - Called with { file: string, messages: Array }
   * @returns {Disposable}
   */
  onDidUpdateMessages(callback) {
    log("BuildService: Registered onDidUpdateMessages callback");
    return this.emitter.on("did-update-messages", callback);
  }

  // ============================================
  // BUILD STATUS
  // ============================================

  /**
   * Get build status for a file or all files
   * @param {string} [filePath] - Optional file path
   * @returns {Object} Status object
   */
  getStatus(filePath = null) {
    if (filePath) {
      const fileStatus = this.buildingFiles.get(filePath);
      return {
        status: fileStatus ? fileStatus.status : "idle",
        file: filePath,
        startTime: fileStatus?.startTime || null,
        endTime: fileStatus?.endTime || null,
        error: fileStatus?.error || null,
      };
    }
    const buildingCount = Array.from(this.buildingFiles.values()).filter(
      (s) => s.status === "building",
    ).length;
    return {
      status: buildingCount > 0 ? "building" : "idle",
      buildingCount,
      files: Array.from(this.buildingFiles.entries()).map(([file, data]) => ({
        file,
        status: data.status,
        startTime: data.startTime || null,
        endTime: data.endTime || null,
      })),
    };
  }

  /**
   * Check if a specific file is currently building
   * @param {string} filePath
   * @returns {boolean}
   */
  isBuilding(filePath) {
    const fileStatus = this.buildingFiles.get(filePath);
    return fileStatus && fileStatus.status === "building";
  }

  /**
   * Check if any build is currently in progress
   * @returns {boolean}
   */
  isAnyBuilding() {
    return Array.from(this.buildingFiles.values()).some((s) => s.status === "building");
  }

  /**
   * Check if compile-on-save is enabled for the current editor
   * @param {TextEditor} [editor] - Optional editor, defaults to active
   * @returns {boolean}
   */
  isCompileOnSaveEnabled(editor) {
    if (!this.mainModule) return false;
    return this.mainModule.isCompileOnSaveEnabled(editor);
  }

  // ============================================
  // BUILD CONTROL
  // ============================================

  /**
   * Compile a Typst file
   * @param {string} filePath - Path to the .typ file
   * @returns {boolean} True if compilation was started
   */
  compile(filePath) {
    if (!this.mainModule) {
      console.error(`[${PACKAGE_NAME}] BuildService: Main module not available`);
      return false;
    }

    if (!filePath || !filePath.endsWith(".typ")) {
      log("BuildService: Invalid file path for compile");
      return false;
    }

    if (this.isBuilding(filePath)) {
      log("BuildService: Build already in progress");
      return false;
    }

    return this.mainModule.runCompilation(filePath) !== false;
  }

  /**
   * Toggle compile-on-save for the active editor
   */
  toggleCompileOnSave() {
    if (!this.mainModule) {
      console.error(`[${PACKAGE_NAME}] BuildService: Main module not available`);
      return;
    }

    this.mainModule.toggleCompileOnSave();
  }

  /**
   * Interrupt a specific build
   * @param {string} filePath
   * @returns {boolean} True if build was interrupted
   */
  interrupt(filePath) {
    if (!this.mainModule) {
      console.error(`[${PACKAGE_NAME}] BuildService: Main module not available`);
      return false;
    }

    return this.mainModule.interruptFile(filePath);
  }

  /**
   * Interrupt all running builds
   * @returns {number} Number of processes interrupted
   */
  interruptAll() {
    if (!this.mainModule) {
      console.error(`[${PACKAGE_NAME}] BuildService: Main module not available`);
      return 0;
    }

    return this.mainModule.interruptAllProcesses();
  }

  // ============================================
  // LOG MESSAGES
  // ============================================

  /**
   * Get parsed messages for a file
   * @param {string} [filePath]
   * @returns {Array}
   */
  getMessages(filePath = null) {
    if (!this.mainModule) return [];
    return this.mainModule.getMessages(filePath);
  }

  /**
   * Get message statistics for a file
   * @param {string} [filePath]
   * @returns {{ total: number, errors: number, warnings: number }}
   */
  getMessageStatistics(filePath = null) {
    if (!this.mainModule) return { total: 0, errors: 0, warnings: 0 };
    return this.mainModule.getMessageStatistics(filePath);
  }

  // ============================================
  // OUTPUT FILES
  // ============================================

  /**
   * Get the output file path for a typ file
   * @param {string} filePath
   * @returns {string|null}
   */
  getOutputPath(filePath) {
    if (!filePath || !filePath.endsWith(".typ")) return null;
    const format = lumine.config.get(`${PACKAGE_NAME}.outputFormat`) || "pdf";
    const outputPath = filePath.replace(/\.typ$/, `.${format}`);
    const fs = require("fs");
    return fs.existsSync(outputPath) ? outputPath : null;
  }

  /**
   * Open the output file for a typ file in the workspace
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async openPdf(filePath) {
    if (!this.mainModule) return false;
    return this.mainModule.openPdfForFile(filePath);
  }

  // ============================================
  // INTERNAL METHODS (used by main.js)
  // ============================================

  /** @private */
  startBuild(filePath) {
    if (this.destroyed) return null;
    log(`BuildService: startBuild(${filePath})`);
    const record = {
      status: "building",
      startTime: Date.now(),
    };
    this.buildingFiles.set(filePath, record);
    this.emitter.emit("did-start-build", { file: filePath });
    if (this.buildingFiles.get(filePath) === record)
      this.emitter.emit("did-change-build-status", {
        status: "building",
        file: filePath,
      });
    return record;
  }

  /** @private */
  finishBuild(filePath, output, elapsedTime = null, record = null) {
    if (this.destroyed) return;
    log(`BuildService: finishBuild(${filePath})`);
    const endTime = Date.now();
    const state = { status: "success", endTime };
    const current = !record || this.buildingFiles.get(filePath) === record;
    if (current) this.buildingFiles.set(filePath, state);
    this.emitter.emit("did-finish-build", {
      file: filePath,
      output: output,
      elapsedTime: elapsedTime,
    });
    if (current && this.buildingFiles.get(filePath) === state)
      this.emitter.emit("did-change-build-status", {
        status: "success",
        file: filePath,
      });
  }

  /** @private */
  failBuild(filePath, error, output, record = null) {
    if (this.destroyed) return;
    log(`BuildService: failBuild(${filePath})`);
    const endTime = Date.now();
    const state = { status: "error", endTime, error };
    const current = !record || this.buildingFiles.get(filePath) === record;
    if (current) this.buildingFiles.set(filePath, state);
    this.emitter.emit("did-fail-build", {
      file: filePath,
      error: error,
      output: output,
    });
    if (current && this.buildingFiles.get(filePath) === state)
      this.emitter.emit("did-change-build-status", {
        status: "error",
        file: filePath,
        error: error,
      });
  }

  /** @private */
  updateMessages(filePath, messages) {
    if (this.destroyed) return;
    this.emitter.emit("did-update-messages", {
      file: filePath,
      messages: messages,
    });
  }

  /** @private */
  reset(filePath = null) {
    log(`BuildService: reset(${filePath || "all"})`);
    if (filePath) {
      this.buildingFiles.delete(filePath);
      this.emitter.emit("did-change-build-status", {
        status: "idle",
        file: filePath,
      });
    } else {
      this.buildingFiles.clear();
      this.emitter.emit("did-change-build-status", {
        status: "idle",
        file: null,
      });
    }
  }

  /** @private */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mainModule = null;
    log("BuildService: destroy()");
    this.buildingFiles.clear();
    this.emitter.dispose();
  }
};
