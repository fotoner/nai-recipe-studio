import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("per-target packaging runtime", () => {
  it("uses electron-builder's app resources and numeric target architecture", async () => {
    const hook = require("../scripts/after-pack.cjs") as {
      createAfterPack(run: (options: Record<string, unknown>) => Promise<void>): (context: Record<string, unknown>) => Promise<void>;
    };
    const runBundle = vi.fn(async (_options: Record<string, unknown>) => undefined);
    const afterPack = hook.createAfterPack(runBundle);
    const root = path.join(tmpdir(), "nai-pack-fixture");
    const macOut = path.join(root, "mac-x64");
    const armMacOut = path.join(root, "mac-arm64");
    const winOut = path.join(root, "win-unpacked");
    const packager = {
      getResourcesDir: (outDir: string) => path.join(outDir, "NAI Recipe Studio.app", "Contents", "Resources"),
    };

    await afterPack({
      appOutDir: macOut,
      electronPlatformName: "darwin",
      arch: 1,
      packager,
    });
    await afterPack({
      appOutDir: armMacOut,
      electronPlatformName: "darwin",
      arch: 3,
      packager,
    });
    await afterPack({
      appOutDir: winOut,
      electronPlatformName: "win32",
      arch: 1,
      packager: {
        getResourcesDir: (outDir: string) => path.join(outDir, "resources"),
      },
    });

    expect(runBundle.mock.calls.map(([options]) => options)).toEqual([
      {
        platform: "darwin",
        arch: "x64",
        destination: path.join(macOut, "NAI Recipe Studio.app", "Contents", "Resources", "mcp"),
        helperScript: path.resolve("dist/mcp/index.cjs"),
      },
      {
        platform: "darwin",
        arch: "arm64",
        destination: path.join(armMacOut, "NAI Recipe Studio.app", "Contents", "Resources", "mcp"),
        helperScript: path.resolve("dist/mcp/index.cjs"),
      },
      {
        platform: "win32",
        arch: "x64",
        destination: path.join(winOut, "resources", "mcp"),
        helperScript: path.resolve("dist/mcp/index.cjs"),
      },
    ]);
  });

  it("reuses only an archive-hash-verified runtime and removes the previous platform executable", async () => {
    const { bundleRuntime } = require("../scripts/runtime-bundler.cjs") as {
      bundleRuntime(options: Record<string, unknown>): Promise<void>;
    };
    const root = await mkdtemp(path.join(tmpdir(), "nai-runtime-bundle-"));
    try {
      const destination = path.join(root, "resources", "mcp");
      const helperScript = path.join(root, "index.cjs");
      const darwinArchive = Buffer.from("synthetic darwin runtime archive");
      const windowsArchive = Buffer.from("synthetic windows runtime archive");
      const targetCatalog = {
        "darwin-x64": { archive: "node-v24.21.0-darwin-x64.tar.gz", sha256: sha256(darwinArchive), binary: "bin/node" },
        "win32-x64": { archive: "node-v24.21.0-win-x64.zip", sha256: sha256(windowsArchive), binary: "node.exe" },
      };
      const archives = new Map([
        ["node-v24.21.0-darwin-x64.tar.gz", darwinArchive],
        ["node-v24.21.0-win-x64.zip", windowsArchive],
      ]);
      const fetchImpl = vi.fn(async (url: string) => {
        const name = url.split("/").at(-1) ?? "";
        const bytes = archives.get(name);
        if (!bytes) throw new Error(`Unexpected runtime request: ${name}`);
        return { ok: true, arrayBuffer: async () => bytes };
      });
      const extractArchive = vi.fn(async ({ temporaryDirectory, prefix, target }: {
        temporaryDirectory: string;
        prefix: string;
        target: { binary: string };
      }) => {
        const binaryPath = path.join(temporaryDirectory, prefix, target.binary);
        await (await import("node:fs/promises")).mkdir(path.dirname(binaryPath), { recursive: true });
        await writeFile(binaryPath, `synthetic ${target.binary}`);
        await writeFile(path.join(temporaryDirectory, prefix, "LICENSE"), "synthetic node license");
      });
      const options = {
        destination,
        helperScript,
        targetCatalog,
        fetchImpl,
        extractArchive,
      };

      await writeFile(helperScript, "first helper build");
      await bundleRuntime({ ...options, platform: "darwin", arch: "x64" });
      expect(await readFile(path.join(destination, "node"), "utf8")).toContain("synthetic");
      await expect(readFile(path.join(destination, "node.exe"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await writeFile(helperScript, "updated helper build");
      await bundleRuntime({ ...options, platform: "darwin", arch: "x64" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(readFile(path.join(destination, "index.cjs"), "utf8")).resolves.toBe("updated helper build");

      const markerPath = path.join(destination, "runtime.json");
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
      expect(marker.archiveHash).toBe(targetCatalog["darwin-x64"].sha256);
      await writeFile(markerPath, JSON.stringify({ ...marker, archiveHash: "0".repeat(64) }));
      await bundleRuntime({ ...options, platform: "darwin", arch: "x64" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      await bundleRuntime({ ...options, platform: "win32", arch: "x64" });
      await expect(readFile(path.join(destination, "node"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(destination, "node.exe"), "utf8")).toContain("synthetic");
      const windowsMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
      expect(windowsMarker).toMatchObject({ target: "win32-x64", archiveHash: targetCatalog["win32-x64"].sha256 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("packages a Linux x64 runtime from the official Node archive", async () => {
    const hook = require("../scripts/after-pack.cjs") as {
      bundleOptions(context: Record<string, unknown>): Record<string, unknown>;
    };
    const { targetCatalog } = require("../scripts/runtime-bundler.cjs") as {
      targetCatalog: Record<string, { archive: string; sha256: string; binary: string }>;
    };
    const linuxOut = path.join(tmpdir(), "nai-pack-fixture", "linux-unpacked");

    expect(hook.bundleOptions({
      appOutDir: linuxOut,
      electronPlatformName: "linux",
      arch: 1,
      packager: { getResourcesDir: (outDir: string) => path.join(outDir, "resources") },
    })).toEqual({
      platform: "linux",
      arch: "x64",
      destination: path.join(linuxOut, "resources", "mcp"),
      helperScript: path.resolve("dist/mcp/index.cjs"),
    });
    expect(targetCatalog["linux-x64"]).toMatchObject({ archive: "node-v24.21.0-linux-x64.tar.gz", binary: "bin/node" });
    expect(targetCatalog["linux-x64"].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("declares Linux packages and space-free artifact names for release uploads", async () => {
    // Windows checkouts may convert line endings.
    const config = (await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
    const manifest = JSON.parse(await readFile(new URL("../desktop/release/manifest.json", import.meta.url), "utf8")) as { platforms: Record<string, string[]> };
    expect(config).toMatch(/^linux:\n(?: {2}.*\n)*? {4}- target: AppImage\n/m);
    expect(config).toMatch(/^linux:\n(?: {2}.*\n)*? {4}- target: deb\n/m);
    expect(config).toContain("artifactName: ${name}-${version}-${os}-${arch}.${ext}");
    expect(manifest.platforms.Linux).toEqual(["x64"]);
  });

  it("uses an afterPack hook instead of copying one shared host runtime into every package", async () => {
    const config = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
    expect(config).toContain("afterPack: ./scripts/after-pack.cjs");
    expect(config).not.toContain("from: runtime/mcp");
  });
});
