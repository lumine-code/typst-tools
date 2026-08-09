const path = require("path");

const PACKAGE_NAME = "typst-tools";

function log(...args) {
  if (lumine.config.get(`${PACKAGE_NAME}.debug`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

/**
 * Parses Typst stderr diagnostic output into structured messages.
 *
 * Typst diagnostic format:
 *   error: message text
 *     ┌─ file.typ:3:5
 *     │
 *   3 │     bad syntax
 *     │     ^^^^^^^^^^
 */
module.exports = class OutputParser {
  constructor() {
    this.messages = [];
  }

  /**
   * Parse Typst stderr output into structured messages.
   * @param {string} stderrContent - The stderr output from typst
   * @param {string} typFilePath - Path to the main .typ file (for resolving relative paths)
   * @returns {Array} Array of message objects
   */
  parse(stderrContent, typFilePath) {
    this.messages = [];
    if (!stderrContent || !stderrContent.trim()) {
      return this.messages;
    }

    const projectPath = path.dirname(typFilePath);
    const lines = stderrContent.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      // Match level line: "error: message" or "warning: message"
      const levelMatch = lines[i].match(/^(error|warning):\s+(.+)$/);
      if (levelMatch) {
        const severity = levelMatch[1];
        const excerpt = levelMatch[2];
        let file = typFilePath;
        let line = 0;
        let column = 0;
        let endColumn = 0;
        i++;

        // Look for location line: "  ┌─ file.typ:3:5"
        if (i < lines.length) {
          const locMatch = lines[i].match(/^\s+┌─\s+(.+):(\d+):(\d+)$/);
          if (locMatch) {
            const relFile = locMatch[1].replace(/^\\\\\?\\/, "");
            file = path.isAbsolute(relFile) ? relFile : path.resolve(projectPath, relFile);
            line = parseInt(locMatch[2], 10);
            column = parseInt(locMatch[3], 10);
            i++;

            // Skip context lines, look for underline (^^^) to get span.
            // Context lines start with "│"/"·" or a gutter line number ("3 │ …").
            while (i < lines.length) {
              const trimmed = lines[i].trimStart();
              if (
                !trimmed.startsWith("│") &&
                !trimmed.startsWith("·") &&
                !/^\d+\s*│/.test(trimmed)
              ) {
                break;
              }
              const caretMatch = lines[i].match(/\^+/);
              if (caretMatch) {
                endColumn = column + caretMatch[0].length;
              }
              i++;
            }
          }
        }

        this.messages.push({
          severity,
          excerpt,
          location: {
            file: path.basename(file),
            fullPath: file,
            position: {
              start: { row: line - 1, column: column - 1 },
              end: {
                row: line - 1,
                column: endColumn > 0 ? endColumn - 1 : Number.MAX_SAFE_INTEGER,
              },
            },
          },
        });

        log(`Parsed ${severity}: ${excerpt} at ${path.basename(file)}:${line}:${column}`);
        continue;
      }
      i++;
    }

    return this.messages;
  }

  /**
   * Get statistics for parsed messages.
   * @returns {{ total: number, errors: number, warnings: number }}
   */
  getStatistics() {
    const stats = { total: this.messages.length, errors: 0, warnings: 0 };
    for (const msg of this.messages) {
      if (msg.severity === "error") stats.errors++;
      else if (msg.severity === "warning") stats.warnings++;
    }
    return stats;
  }

  /**
   * Clear all parsed messages.
   */
  clear() {
    this.messages = [];
  }
};
