module.exports = class ObservedFilesStatusView {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.count = 0;
    this.tooltip = null;

    this.element = document.createElement("div");
    this.element.classList.add("typst-tools-observed-status", "inline-block");

    this.icon = document.createElement("span");
    this.icon.classList.add("icon", "icon-eye");
    this.element.appendChild(this.icon);

    this.label = document.createElement("span");
    this.label.classList.add("typst-tools-observed-status-label");
    this.element.appendChild(this.label);

    this.tooltip = atom.tooltips.add(this.element, {
      title: "Left click: List observed files | Right click: Clear all observed files",
    });

    this.element.addEventListener("click", (event) => {
      if (event.button === 0 && this.callbacks.onOpenObservedFiles) {
        event.preventDefault();
        this.callbacks.onOpenObservedFiles();
      }
    });

    this.element.addEventListener("mousedown", (event) => {
      if (event.button === 2 && this.callbacks.onClearObservedFiles) {
        event.preventDefault();
        this.callbacks.onClearObservedFiles();
      }
    });

    this.element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      return false;
    });

    this.setCount(0);
  }

  setCount(count) {
    this.count = count;
    this.label.textContent = `Typst (${count})`;
    this.element.title = `${count} file${count === 1 ? "" : "s"} observed for compile-on-save`;
    this.element.style.display = count > 0 ? "" : "none";
  }

  destroy() {
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
