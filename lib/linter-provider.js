const PACKAGE_NAME = "typst-tools";

function log(...args) {
  if (lumine.config.get(`${PACKAGE_NAME}.debug`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

module.exports = class LinterProvider {
  constructor() {
    this.name = "Typst";
    this.indieInstance = null;
  }

  // Called by linter package to register this indie linter
  register(indie) {
    this.indieInstance = indie;
    log("Linter indie instance registered");
  }

  setMessages(messages) {
    if (!this.indieInstance) {
      console.warn(`[${PACKAGE_NAME}] Linter indie instance not available`);
      return;
    }

    // Remove duplicates (same severity, file, position, and excerpt)
    const seen = new Set();
    const uniqueMessages = messages.filter((msg) => {
      const key = `${msg.severity}|${msg.location.fullPath}|${msg.location.position.start.row}:${msg.location.position.start.column}|${msg.excerpt}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    // Convert to linter message format
    const linterMessages = uniqueMessages.map((msg) => ({
      severity: msg.severity,
      location: {
        file: msg.location.fullPath,
        position: [
          [msg.location.position.start.row, msg.location.position.start.column],
          [msg.location.position.end.row, msg.location.position.end.column],
        ],
      },
      excerpt: msg.excerpt,
    }));

    this.indieInstance.setAllMessages(linterMessages);
    log(`Set ${linterMessages.length} messages in linter`);
  }

  clearMessages() {
    if (!this.indieInstance) {
      return;
    }

    this.indieInstance.clearMessages();
    log("Cleared linter messages");
  }
};
