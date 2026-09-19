import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Pin the official Node release and checksums together. Never package the host's
// Node executable: Homebrew and other installations may require external dylibs.
const version = "24.21.0";
const targets = {
  "darwin-arm64": { archive: `node-v${version}-darwin-arm64.tar.gz`, sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057", binary: "bin/node" },
  "darwin-x64": { archive: `node-v${version}-darwin-x64.tar.gz`, sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097", binary: "bin/node" },
  "win32-x64": { archive: `node-v${version}-win-x64.zip`, sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541", binary: "node.exe" },
};
const platform = process.env.NAI_BUILD_PLATFORM ?? process.platform;
const arch = process.env.NAI_BUILD_ARCH ?? process.arch;
const key = `${platform}-${arch}`;
const target = targets[key];
if (!target) throw new Error(`Unsupported runtime target: ${key}`);

const destination = path.resolve("runtime/mcp");
const marker = path.join(destination, "runtime.json");
const executable = path.join(destination, platform === "win32" ? "node.exe" : "node");
let cached = false;
try {
  const previous = JSON.parse(await readFile(marker, "utf8"));
  const bytes = await readFile(executable);
  cached = previous.version === version && previous.target === key && previous.binaryHash === createHash("sha256").update(bytes).digest("hex");
} catch { /* first build or incomplete cache */ }

if (!cached) {
  const temporary = await mkdtemp(path.join(tmpdir(), "nai-node-"));
  try {
    const response = await fetch(`https://nodejs.org/dist/v${version}/${target.archive}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== target.sha256) throw new Error("Runtime checksum mismatch");
    const archivePath = path.join(temporary, target.archive);
    await writeFile(archivePath, bytes);
    const prefix = target.archive.replace(/\.tar\.gz$|\.zip$/, "");
    execFileSync("tar", ["-xf", archivePath, "-C", temporary, `${prefix}/${target.binary}`, `${prefix}/LICENSE`], { stdio: "inherit" });
    await mkdir(destination, { recursive: true });
    await copyFile(path.join(temporary, prefix, target.binary), executable);
    await copyFile(path.join(temporary, prefix, "LICENSE"), path.join(destination, "NODE-LICENSE"));
    if (platform !== "win32") await chmod(executable, 0o755);
    const binaryHash = createHash("sha256").update(await readFile(executable)).digest("hex");
    await writeFile(marker, JSON.stringify({ version, target: key, archiveHash: target.sha256, binaryHash }, null, 2) + "\n");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

await copyFile(path.resolve("dist/mcp/index.cjs"), path.join(destination, "index.cjs"));
console.log(`MCP runtime ready: Node ${version}, ${key}, verified official binary.`);
