/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module */

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const VERSION = "24.21.0";
const TARGETS = Object.freeze({
  "darwin-arm64": { archive: `node-v${VERSION}-darwin-arm64.tar.gz`, sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057", binary: "bin/node" },
  "darwin-x64": { archive: `node-v${VERSION}-darwin-x64.tar.gz`, sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097", binary: "bin/node" },
  "win32-x64": { archive: `node-v${VERSION}-win-x64.zip`, sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541", binary: "node.exe" },
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractNodeArchive({ archivePath, temporaryDirectory, prefix, target }) {
  execFileSync("tar", ["-xf", archivePath, "-C", temporaryDirectory, `${prefix}/${target.binary}`, `${prefix}/LICENSE`], { stdio: "inherit" });
}

async function removeStaleExecutable(destination, executable) {
  const staleName = executable === "node.exe" ? "node" : "node.exe";
  await rm(path.join(destination, staleName), { force: true });
}

async function installHelperScript(destination, helperScript) {
  const helper = await readFile(helperScript);
  await writeFile(path.join(destination, "index.cjs"), helper);
}

/**
 * Installs the official Node binary and MCP helper at a package-specific path.
 * fetchImpl, extractArchive, and targetCatalog are injectable for offline tests.
 */
async function bundleRuntime(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const destination = path.resolve(options.destination || "runtime/mcp");
  const helperScript = path.resolve(options.helperScript || "dist/mcp/index.cjs");
  const targetCatalog = options.targetCatalog || TARGETS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const extractArchive = options.extractArchive || extractNodeArchive;
  const log = options.log || console.log;
  const key = `${platform}-${arch}`;
  const target = targetCatalog[key];
  if (!target) throw new Error(`Unsupported runtime target: ${key}`);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required to download the MCP runtime.");

  const executableName = platform === "win32" ? "node.exe" : "node";
  const executablePath = path.join(destination, executableName);
  const markerPath = path.join(destination, "runtime.json");
  let cached = false;
  try {
    const [markerText, executableBytes] = await Promise.all([readFile(markerPath, "utf8"), readFile(executablePath)]);
    const previous = JSON.parse(markerText);
    cached = previous.version === VERSION
      && previous.target === key
      && previous.archiveHash === target.sha256
      && previous.binaryHash === digest(executableBytes);
  } catch { /* first build or incomplete / invalid cache */ }

  await mkdir(destination, { recursive: true });
  if (cached) {
    await removeStaleExecutable(destination, executableName);
    await installHelperScript(destination, helperScript);
    log(`MCP runtime ready: Node ${VERSION}, ${key}, verified official binary.`);
    return { version: VERSION, target: key, binaryHash: (JSON.parse(await readFile(markerPath, "utf8"))).binaryHash, cached: true };
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "nai-node-"));
  try {
    const url = `https://nodejs.org/dist/v${VERSION}/${target.archive}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
    const archiveBytes = Buffer.from(await response.arrayBuffer());
    if (digest(archiveBytes) !== target.sha256) throw new Error("Runtime checksum mismatch");

    const archivePath = path.join(temporaryDirectory, target.archive);
    await writeFile(archivePath, archiveBytes);
    const prefix = target.archive.replace(/\.tar\.gz$|\.zip$/, "");
    await extractArchive({ archivePath, temporaryDirectory, prefix, target, platform, arch });
    const extractedBinary = path.join(temporaryDirectory, prefix, target.binary);
    const extractedLicense = path.join(temporaryDirectory, prefix, "LICENSE");
    await readFile(extractedBinary);
    await readFile(extractedLicense);

    await Promise.all([
      rm(path.join(destination, "node"), { force: true }),
      rm(path.join(destination, "node.exe"), { force: true }),
      rm(markerPath, { force: true }),
      rm(path.join(destination, "NODE-LICENSE"), { force: true }),
    ]);
    await copyFile(extractedBinary, executablePath);
    await copyFile(extractedLicense, path.join(destination, "NODE-LICENSE"));
    if (platform !== "win32") await chmod(executablePath, 0o755);
    const binaryHash = digest(await readFile(executablePath));
    await installHelperScript(destination, helperScript);
    await writeFile(markerPath, `${JSON.stringify({ version: VERSION, target: key, archiveHash: target.sha256, binaryHash }, null, 2)}\n`);
    log(`MCP runtime ready: Node ${VERSION}, ${key}, verified official binary.`);
    return { version: VERSION, target: key, binaryHash, cached: false };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = { bundleRuntime, targetCatalog: TARGETS };
