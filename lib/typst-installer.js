const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BIN_DIR = path.join(__dirname, "..", "bin");
const REPO = "typst/typst";

/**
 * Map platform/arch to typst release asset target triple.
 * @returns {{ target: string, ext: string }}
 */
function getTargetInfo() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") {
    return { target: "x86_64-pc-windows-msvc", ext: ".zip" };
  } else if (platform === "win32" && arch === "arm64") {
    return { target: "aarch64-pc-windows-msvc", ext: ".zip" };
  } else if (platform === "linux" && arch === "x64") {
    return { target: "x86_64-unknown-linux-musl", ext: ".tar.xz" };
  } else if (platform === "linux" && arch === "arm64") {
    return { target: "aarch64-unknown-linux-musl", ext: ".tar.xz" };
  } else if (platform === "darwin" && arch === "x64") {
    return { target: "x86_64-apple-darwin", ext: ".tar.xz" };
  } else if (platform === "darwin" && arch === "arm64") {
    return { target: "aarch64-apple-darwin", ext: ".tar.xz" };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Get the release asset name for the current platform.
 * @param {string} version - Version tag (e.g., "v0.13.0")
 * @returns {string}
 */
function getAssetName() {
  const { target, ext } = getTargetInfo();
  return `typst-${target}${ext}`;
}

/**
 * Get path to the bundled binary.
 * @returns {string}
 */
function getBinPath() {
  const name = process.platform === "win32" ? "typst.exe" : "typst";
  return path.join(BIN_DIR, name);
}

/**
 * Get path to the version file.
 * @returns {string}
 */
function getVersionPath() {
  return path.join(BIN_DIR, ".version");
}

/**
 * Check if a bundled binary exists.
 * @returns {boolean}
 */
function hasBundled() {
  return fs.existsSync(getBinPath());
}

/**
 * Read the installed version, or null if not installed.
 * @returns {string|null}
 */
function getInstalledVersion() {
  try {
    return fs.readFileSync(getVersionPath(), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and return the response body as parsed JSON.
 * Follows redirects.
 * @param {string} url
 * @returns {Promise<Object>}
 */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const doRequest = (reqUrl) => {
      https
        .get(reqUrl, { headers: { "User-Agent": "typst-tools" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on("error", reject);
    };
    doRequest(url);
  });
}

/**
 * Download a file from a URL to a local path. Follows redirects.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const doRequest = (reqUrl) => {
      https
        .get(reqUrl, { headers: { "User-Agent": "typst-tools" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
          file.on("error", (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        })
        .on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
    };
    doRequest(url);
  });
}

/**
 * Fetch release info from GitHub.
 * @param {string} [tag="latest"]
 * @returns {Promise<{ tag: string, assets: Array<{ name: string, url: string }> }>}
 */
async function fetchRelease(tag = "latest") {
  const endpoint =
    tag === "latest"
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;

  const release = await fetchJSON(endpoint);

  return {
    tag: release.tag_name,
    assets: release.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
    })),
  };
}

/**
 * Extract the typst binary from the downloaded archive.
 * @param {string} archivePath - Path to the downloaded archive
 * @param {string} destDir - Destination directory for the binary
 * @returns {void}
 */
function extractBinary(archivePath, destDir) {
  const { ext } = getTargetInfo();
  const binName = process.platform === "win32" ? "typst.exe" : "typst";

  if (ext === ".zip") {
    // Windows: use PowerShell to extract
    const tempDir = path.join(destDir, "_extract_tmp");
    try {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force"`,
        { stdio: "pipe" },
      );
      // Find the binary inside the extracted directory
      const entries = fs.readdirSync(tempDir);
      for (const entry of entries) {
        const candidatePath = path.join(tempDir, entry, binName);
        if (fs.existsSync(candidatePath)) {
          fs.copyFileSync(candidatePath, path.join(destDir, binName));
          break;
        }
        // Also check top level
        const topPath = path.join(tempDir, entry);
        if (entry === binName && fs.statSync(topPath).isFile()) {
          fs.copyFileSync(topPath, path.join(destDir, binName));
          break;
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    // Unix: use tar to extract
    const tempDir = path.join(destDir, "_extract_tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      execSync(`tar xJf "${archivePath}" -C "${tempDir}"`, { stdio: "pipe" });
      // Find the binary inside the extracted directory
      const entries = fs.readdirSync(tempDir);
      for (const entry of entries) {
        const candidatePath = path.join(tempDir, entry, binName);
        if (fs.existsSync(candidatePath)) {
          fs.copyFileSync(candidatePath, path.join(destDir, binName));
          fs.chmodSync(path.join(destDir, binName), 0o755);
          break;
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // Clean up archive
  fs.unlinkSync(archivePath);
}

/**
 * Install typst binary from GitHub releases.
 * @param {string} [tag="latest"]
 * @returns {Promise<{ version: string, path: string }>}
 */
async function install(tag = "latest") {
  const release = await fetchRelease(tag);
  const assetName = getAssetName();
  const asset = release.assets.find((a) => a.name === assetName);

  if (!asset) {
    const available = release.assets
      .filter(
        (a) =>
          a.name.startsWith("typst-") && !a.name.endsWith(".sha256") && !a.name.endsWith(".sig"),
      )
      .map((a) => a.name);
    throw new Error(
      `No typst binary found for ${assetName} in ${release.tag}.\n` +
        `Available: ${available.join(", ")}`,
    );
  }

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const { ext } = getTargetInfo();
  const archivePath = path.join(BIN_DIR, `typst-download${ext}`);
  await downloadFile(asset.url, archivePath);
  extractBinary(archivePath, BIN_DIR);

  // Write version file
  fs.writeFileSync(getVersionPath(), release.tag);

  const binPath = getBinPath();
  if (!fs.existsSync(binPath)) {
    throw new Error("Binary extraction failed - typst binary not found after extraction");
  }

  return { version: release.tag, path: binPath };
}

/**
 * Remove the bundled binary.
 */
function uninstall() {
  const binPath = getBinPath();
  if (fs.existsSync(binPath)) {
    fs.unlinkSync(binPath);
  }
  const versionPath = getVersionPath();
  if (fs.existsSync(versionPath)) {
    fs.unlinkSync(versionPath);
  }
}

module.exports = {
  getAssetName,
  getBinPath,
  hasBundled,
  getInstalledVersion,
  fetchRelease,
  install,
  uninstall,
};
