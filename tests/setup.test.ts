import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SetupManager,
  buildCodexMcpEntry,
  mergeClaudeMcpConfig,
  mergeCodexMcpConfig,
  type SetupFileSystem,
} from "../services/setup";

function memoryFs(): SetupFileSystem & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async readFile(file) {
      const value = files.get(file);
      if (!value) {
        const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        throw error;
      }
      return Buffer.from(value);
    },
    async writeFile(file, data) { files.set(file, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data)); },
    async mkdir() {},
    async rename(from, to) {
      const value = files.get(from);
      if (!value) throw new Error("missing temp file");
      files.set(to, value);
      files.delete(from);
    },
    async copyFile(from, to) {
      const value = files.get(from);
      if (!value) throw new Error("missing source file");
      files.set(to, Buffer.from(value));
    },
    async unlink(file) { files.delete(file); },
    async readdir(dir) {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      return [...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split(path.sep)[0]);
    },
    async stat(file) {
      if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isFile: () => true, isDirectory: () => false };
    },
  };
}

describe("AI client setup", () => {
  it("merges a Codex MCP entry without changing unrelated settings", () => {
    const existing = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["--x"]\n`;
    const merged = mergeCodexMcpConfig(existing, buildCodexMcpEntry("/Applications/NAI Recipe Studio.app/Contents/Resources/mcp.js", "/tmp/token"));
    expect(merged).toContain('model = "gpt-5"');
    expect(merged).toContain("[mcp_servers.other]");
    expect(merged).toContain("[mcp_servers.nai_recipe_studio]");
    expect(merged).toContain("--token-file");
    expect(merged).not.toContain("novelai");
    const again = mergeCodexMcpConfig(merged, buildCodexMcpEntry("/Applications/NAI Recipe Studio.app/Contents/Resources/mcp.js", "/tmp/token"));
    expect(again.replace(/\n+$/, "")).toBe(merged.replace(/\n+$/, ""));
  });

  it("merges Claude JSON while preserving unrelated MCP servers", () => {
    const existing = { mcpServers: { other: { command: "other", args: [] } }, theme: "dark" };
    const result = mergeClaudeMcpConfig(existing, { command: "/app/mcp", args: ["--token-file", "/tmp/token"] });
    expect(result.theme).toBe("dark");
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ command: "other", args: [] });
    expect(servers["nai-recipe-studio"]).toEqual({ command: "/app/mcp", args: ["--token-file", "/tmp/token"] });
  });

  it("installs, re-runs idempotently, and removes only app-owned setup files", async () => {
    const fs = memoryFs();
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-setup-"));
    const configPath = path.join(root, "codex.toml");
    const statePath = path.join(root, "state.json");
    const skillSource = path.join(root, "bundle");
    const skillRoot = path.join(root, "skills");
    const toBytes = (value: string) => Buffer.from(value);
    fs.files.set(configPath, toBytes('model = "gpt-5"\n'));
    fs.files.set(path.join(skillSource, "SKILL.md"), toBytes("# NAI Recipe Studio\n"));
    for (const relative of ["references/recipes.md", "references/generation.md", "references/results.md", "agents/openai.yaml"]) fs.files.set(path.join(skillSource, relative), toBytes(relative));

    const manager = new SetupManager({ fs, statePath, platform: "darwin", clients: {
      codex: { id: "codex", configPath, skillRoot, supportsSkills: true, scope: "user", available: true },
    }, skillSource, helperPath: "/app/mcp-helper", version: "0.1.0" });
    const first = await manager.install({ client: "codex", scope: "user" });
    expect(first.ok).toBe(true);
    const before = fs.files.get(configPath)?.toString() ?? "";
    expect(before).toContain("nai_recipe_studio");
    expect(fs.files.has(path.join(skillRoot, "recipe-studio", "SKILL.md"))).toBe(true);
    const second = await manager.install({ client: "codex", scope: "user" });
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    const removed = await manager.remove({ client: "codex", scope: "user" });
    expect(removed.ok).toBe(true);
    expect(fs.files.has(path.join(skillRoot, "recipe-studio", "SKILL.md"))).toBe(false);
    // The setup fixture still owns the unrelated model setting.
    expect(fs.files.get(configPath)?.toString()).toContain('model = "gpt-5"');
  });

  it("removes the last Claude MCP entry without leaving an empty server map", async () => {
    const fs = memoryFs();
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-claude-setup-"));
    const configPath = path.join(root, "claude.json");
    const statePath = path.join(root, "state.json");
    const skillSource = path.join(root, "bundle");
    fs.files.set(configPath, Buffer.from(JSON.stringify({ theme: "dark" })));
    const manager = new SetupManager({ fs, statePath, platform: "darwin", clients: {
      "claude-desktop": { id: "claude-desktop", configPath, skillRoot: null, supportsSkills: false, scope: "user", available: true },
    }, skillSource, helperPath: "/app/mcp-helper", version: "0.1.0" });

    await manager.install({ client: "claude-desktop", scope: "user" });
    await manager.remove({ client: "claude-desktop", scope: "user" });
    const result = JSON.parse(fs.files.get(configPath)!.toString()) as Record<string, unknown>;
    expect(result.theme).toBe("dark");
    expect(result).not.toHaveProperty("mcpServers");
  });

  it("does not overwrite an existing unmanaged Claude entry when no state exists", async () => {
    const fs = memoryFs();
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-claude-conflict-"));
    const configPath = path.join(root, "claude.json");
    const statePath = path.join(root, "state.json");
    const skillSource = path.join(root, "bundle");
    const original = JSON.stringify({ mcpServers: { "nai-recipe-studio": { command: "/user-owned", args: ["--keep"] } } });
    fs.files.set(configPath, Buffer.from(original));
    const manager = new SetupManager({ fs, statePath, platform: "darwin", clients: {
      "claude-desktop": { id: "claude-desktop", configPath, skillRoot: null, supportsSkills: false, scope: "user", available: true },
    }, skillSource, helperPath: "/app/mcp-helper", version: "0.1.0" });

    await expect(manager.install({ client: "claude-desktop", scope: "user" })).rejects.toMatchObject({ code: "SETUP_CONFLICT" });
    expect(fs.files.get(configPath)?.toString()).toBe(original);
    expect(fs.files.has(statePath)).toBe(false);
  });

  it("updates skill files previously managed by the app and preserves later user edits", async () => {
    const fs = memoryFs();
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-skill-update-"));
    const configPath = path.join(root, "codex.toml");
    const statePath = path.join(root, "state.json");
    const skillSource = path.join(root, "bundle");
    const skillRoot = path.join(root, "skills");
    const sourceFiles = ["SKILL.md", "agents/openai.yaml", "references/recipes.md", "references/generation.md", "references/results.md"];
    for (const relative of sourceFiles) fs.files.set(path.join(skillSource, relative), Buffer.from(`v1:${relative}`));
    const managerOptions = { fs, statePath, platform: "darwin" as const, clients: {
      codex: { id: "codex" as const, configPath, skillRoot, supportsSkills: true, scope: "user" as const, available: true },
    }, skillSource, helperPath: "/app/mcp-helper", version: "0.1.0" };
    const manager = new SetupManager(managerOptions);
    await manager.install({ client: "codex", scope: "user" });

    fs.files.set(path.join(skillSource, "SKILL.md"), Buffer.from("v2:SKILL.md"));
    await manager.install({ client: "codex", scope: "user" });
    expect(fs.files.get(path.join(skillRoot, "recipe-studio", "SKILL.md"))?.toString()).toBe("v2:SKILL.md");

    fs.files.set(path.join(skillRoot, "recipe-studio", "SKILL.md"), Buffer.from("user edit"));
    fs.files.set(path.join(skillSource, "SKILL.md"), Buffer.from("v3:SKILL.md"));
    await expect(manager.install({ client: "codex", scope: "user" })).rejects.toMatchObject({ code: "SETUP_CONFLICT" });
    expect(fs.files.get(path.join(skillRoot, "recipe-studio", "SKILL.md"))?.toString()).toBe("user edit");
  });
});
