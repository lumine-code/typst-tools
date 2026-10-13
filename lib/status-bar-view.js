const PACKAGE_NAME = "typst-tools";

function log(...args) {
  if (lumine.config.get(`${PACKAGE_NAME}.debug`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

module.exports = class StatusBarView {
  constructor() {
    this.destroyed = false;
    log("Creating StatusBarView");
    this.tooltip = null;
    this.timerInterval = null;
    this.buildStartTime = null;
    this.currentStatus = "";
    this.compileOnSave = false;

    this.element = document.createElement("status-bar-tile");
    this.element.setAttribute("data-context-menu-boundary", "");
    this.element.classList.add("typst-tools-status");

    // Create Typ label
    this.label = document.createElement("span");
    this.label.classList.add("typst-tools-status-label");
    this.label.textContent = "Typ";

    // Create timer element
    this.timer = document.createElement("span");
    this.timer.classList.add("typst-tools-status-timer");

    this.element.appendChild(this.label);
    this.element.appendChild(this.timer);

    this.tooltip = lumine.tooltips.add(this.element, {
      title: () => {
        const state =
          {
            idle: "Idle",
            building: "Building",
            success: "Build succeeded",
            error: "Build failed",
          }[this.currentStatus] ?? "Idle";
        return `${state}. Compile this document.`;
      },
    });
    this.element.addEventListener("mousedown", (event) => {
      if (this.destroyed) return;
      if (event.button === 0) {
        if (process.platform === "darwin" && event.ctrlKey) return;
        lumine.commands.dispatch(
          this.element,
          event.altKey ? "typst-tools:watch" : "typst-tools:compile",
        );
      } else if (event.button === 1) {
        event.preventDefault();
        lumine.commands.dispatch(this.element, "typst-tools:split-pdf-source");
      }
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
    if (this.destroyed) return;
    this.destroyed = true;
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
