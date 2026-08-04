const PACKAGE_NAME = "typst-tools";

function log(...args) {
  if (atom.config.get(`${PACKAGE_NAME}.debug`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

module.exports = class StatusBarView {
  constructor(callbacks = {}) {
    log("Creating StatusBarView");
    this.callbacks = callbacks;
    this.tooltip = null;
    this.timerInterval = null;
    this.buildStartTime = null;
    this.currentStatus = "";
    this.compileOnSave = false;

    this.element = document.createElement("div");
    this.element.classList.add("typst-tools-status", "inline-block");

    // Create Typ label
    this.label = document.createElement("span");
    this.label.classList.add("typst-tools-status-label");
    this.label.textContent = "Typ";

    // Create timer element
    this.timer = document.createElement("span");
    this.timer.classList.add("typst-tools-status-timer");

    this.element.appendChild(this.label);
    this.element.appendChild(this.timer);

    // Add native editor tooltip
    this.tooltip = atom.tooltips.addComposite(this.element, [
      {
        title: "Compile",
        keyBindingExtra: "LMB",
        keyBindingCommand: "typst-tools:compile",
      },
      {
        title: "Toggle file observation",
        keyBindingExtra: "Alt+LMB",
        keyBindingCommand: "typst-tools:watch",
      },
      {
        title: "Split PDF\u2194Typ",
        keyBindingExtra: "MMB",
        keyBindingCommand: "typst-tools:open-pdf",
      },
      {
        title: "Kill & clean",
        keyBindingExtra: "RMB",
      },
    ]);

    // Add mousedown handler for all mouse buttons
    this.element.addEventListener("mousedown", (event) => {
      log("Status bar mousedown, button:", event.button);

      switch (event.button) {
        case 0: // Left mouse button
          if (event.altKey) {
            // Alt+Left click - toggle compile-on-save
            if (this.callbacks.onToggleCompileOnSave) {
              this.callbacks.onToggleCompileOnSave();
            }
          } else {
            // Left click - compile
            if (this.callbacks.onCompile) {
              this.callbacks.onCompile();
            }
          }
          break;
        case 1: // Middle mouse button - open PDF
          event.preventDefault();
          if (this.callbacks.onOpenPdf) {
            this.callbacks.onOpenPdf();
          }
          break;
        case 2: // Right mouse button - kill and clean
          if (this.callbacks.onKillAndClean) {
            this.callbacks.onKillAndClean();
          }
          break;
      }
    });

    // Prevent context menu on right click
    this.element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return false;
    });

    // Initialize to idle state
    this.setStatus("idle");
    log("StatusBarView created");
  }

  formatTime(ms) {
    return `${ms}ms`;
  }

  startTimer() {
    this.stopTimer();
    this.buildStartTime = Date.now();
    this.timer.textContent = "0s";

    this.timerInterval = setInterval(() => {
      const elapsed = Date.now() - this.buildStartTime;
      this.timer.textContent = this.formatTime(elapsed);
    }, 100);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  getElapsedTime() {
    if (this.buildStartTime) {
      return Date.now() - this.buildStartTime;
    }
    return 0;
  }

  setStatus(status, _message = "", options = {}) {
    log(`setStatus: ${status}`);
    this.currentStatus = status;
    this.show();

    // Clear previous classes
    this.element.classList.remove(
      "status-idle",
      "status-building",
      "status-success",
      "status-error",
    );
    this.label.classList.remove("building-animation");

    switch (status) {
      case "building":
        this.element.classList.add("status-building");
        this.label.classList.add("building-animation");
        this.timer.style.display = "";
        if (!options.skipTimer) {
          this.startTimer();
        }
        break;

      case "success":
        this.stopTimer();
        this.element.classList.add("status-success");
        this.timer.style.display = "";
        break;

      case "error":
        this.stopTimer();
        this.element.classList.add("status-error");
        this.timer.style.display = "";
        break;

      case "idle":
      default:
        this.element.classList.add("status-idle");
        this.timer.style.display = "";
        this.timer.textContent = "Idle";
        this.stopTimer();
        this.buildStartTime = null;
        break;
    }
  }

  // Restore timer state when switching between files
  restoreTimer(startTime) {
    this.stopTimer();
    if (startTime) {
      this.buildStartTime = startTime;
      const elapsed = Date.now() - startTime;
      this.timer.textContent = this.formatTime(elapsed);

      this.timerInterval = setInterval(() => {
        const elapsed = Date.now() - this.buildStartTime;
        this.timer.textContent = this.formatTime(elapsed);
      }, 100);
    }
  }

  // Show final elapsed time without running timer
  showElapsedTime(elapsedMs) {
    this.stopTimer();
    this.timer.textContent = this.formatTime(elapsedMs);
  }

  // Update compile-on-save indicator
  setCompileOnSave(enabled) {
    this.compileOnSave = enabled;
    this.label.textContent = enabled ? "Typ*" : "Typ";
  }

  show() {
    log("Showing status bar view");
    this.element.style.display = "";
  }

  hide() {
    log("Hiding status bar view");
    this.element.style.display = "none";
  }

  destroy() {
    log("Destroying StatusBarView");
    this.stopTimer();
    if (this.tooltip) {
      this.tooltip.dispose();
      this.tooltip = null;
    }
    this.element.remove();
  }

  getElement() {
    return this.element;
  }
};
