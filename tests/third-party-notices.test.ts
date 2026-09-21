import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const notices = require("../scripts/third-party-notices.cjs") as {
  NOTICE_ROOTS: string[];
  collectPackages(options: { roots: string[]; projectRoot: string }): Promise<Array<{ name: string; version: string; license: string; texts: string[] }>>;
  renderNotices(packages: Array<{ name: string; version: string; license: string; repository?: string; texts: string[] }>): string;
};

async function writePackage(root: string, relative: string, manifest: Record<string, unknown>, license?: string) {
  const directory = path.join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
  if (license) await writeFile(path.join(directory, "LICENSE"), license);
}

describe("third-party notices", () => {
  it("collects the transitive runtime closure with shipped license texts, once per package version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-notices-"));
    try {
      await writePackage(root, "node_modules/alpha", { name: "alpha", version: "1.0.0", license: "MIT", dependencies: { beta: "^2" }, peerDependencies: { ghost: "*" }, optionalDependencies: { "not-installed": "*" } }, "alpha license text");
      await writePackage(root, "node_modules/alpha/node_modules/beta", { name: "beta", version: "2.1.0", license: "ISC", dependencies: { gamma: "*" } }, "beta license text");
      await writePackage(root, "node_modules/gamma", { name: "gamma", version: "0.3.0", license: "Apache-2.0", dependencies: { alpha: "*" } });
      await writePackage(root, "node_modules/dev-only", { name: "dev-only", version: "9.0.0", license: "MIT" }, "must not appear");

      const packages = await notices.collectPackages({ roots: ["alpha", "gamma"], projectRoot: root });
      expect(packages.map(entry => `${entry.name}@${entry.version}`)).toEqual(["alpha@1.0.0", "beta@2.1.0", "gamma@0.3.0"]);
      expect(packages[1].texts).toEqual(["beta license text"]);

      const rendered = notices.renderNotices(packages);
      expect(rendered).toContain("alpha@1.0.0 (MIT)");
      expect(rendered).toContain("alpha license text");
      expect(rendered).toContain("gamma@0.3.0 (Apache-2.0)");
      expect(rendered).not.toContain("must not appear");
      expect(rendered).not.toMatch(/\/(?:Users|home|tmp)\//);

      await expect(notices.collectPackages({ roots: ["missing-root"], projectRoot: root })).rejects.toThrow(/missing-root/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("lists every third-party package imported by shipped source as a notice root", async () => {
    const sourceRoots = ["desktop", "features", "components", "lib", "core", "adapters", "services", "contracts", "i18n", "files"];
    const imported = new Set<string>();
    async function visit(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { await visit(absolute); continue; }
        if (!/\.(tsx?|css)$/.test(entry.name)) continue;
        const content = await readFile(absolute, "utf8");
        for (const match of content.matchAll(/(?:from|import|@import)\s+"([^"]+)"/g)) {
          const specifier = match[1];
          if (/^(?:\.|@\/|node:)/.test(specifier) || specifier === "electron") continue;
          imported.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
        }
      }
    }
    for (const directory of sourceRoots) await visit(path.resolve(directory));
    expect(imported.size).toBeGreaterThan(5);
    expect([...imported].filter(name => !notices.NOTICE_ROOTS.includes(name))).toEqual([]);
  });
});
