import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { readFile as nodeReadFile, writeFile as nodeWriteFile, mkdir as nodeMkdir, rename as nodeRename, copyFile as nodeCopyFile, unlink as nodeUnlink, readdir as nodeReaddir, stat as nodeStat } from "node:fs/promises";
import type { SetupStatus, SetupTarget } from "../contracts/studio";
import { PlatformError } from "../desktop/main/errors";

export type SetupFileSystem = {
  readFile: (file: string, encoding: "utf8") => Promise<string | Buffer>;
  writeFile: (file: string, data: string | Uint8Array, options?: { encoding?: "utf8"; mode?: number }) => Promise<void>;
  mkdir: (dir: string, options?: { recursive?: boolean; mode?: number }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  unlink: (file: string) => Promise<void>;
  readdir: (dir: string) => Promise<string[]>;
  stat: (file: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
};

const realFs: SetupFileSystem = {
  readFile: (file, encoding) => nodeReadFile(file, encoding),
  writeFile: (file, data, options) => nodeWriteFile(file, data, options),
  mkdir: (dir, options) => nodeMkdir(dir, options).then(() => undefined),
  rename: (from, to) => nodeRename(from, to),
  copyFile: (from, to) => nodeCopyFile(from, to),
  unlink: file => nodeUnlink(file),
  readdir: dir => nodeReaddir(dir),
  stat: async file => nodeStat(file),
};

export type SetupClient = {
  id: SetupTarget;
  available: boolean;
  /** Whether this target's configuration format is supported on this platform. */
  supported?: boolean;
  configPath: string;
  skillRoot: string | null;
  supportsSkills: boolean;
  scope: "user" | "project";
};

export type SetupOptions = {
  fs?: SetupFileSystem;
  statePath: string;
  platform: NodeJS.Platform;
  clients?: Partial<Record<SetupTarget, SetupClient>>;
  homeDir?: string;
  projectDir?: string;
  skillSource: string;
  helperPath: string;
  runtimePath?: string;
  scriptPath?: string;
  tokenPath?: string;
  tokenPathForConnection?: (connectionId: string) => string;
  endpoint?: string;
  version: string;
};

type SetupState = {
  version: 1;
  installs: Partial<Record<SetupTarget, {
    target: SetupTarget;
    configPath: string;
    configHash: string;
    managedHash: string;
    skillPath: string | null;
    files: Record<string, string>;
    version: string;
  }>>;
};

const MANAGED_MARKER = "# managed-by: nai-recipe-studio";
const SKILL_FILES = ["SKILL.md", "agents/openai.yaml", "references/recipes.md", "references/generation.md", "references/results.md"];

export function buildCodexMcpEntry(helperPath: string, tokenPath: string, endpoint = "") {
  return { command: helperPath, args: ["--endpoint", endpoint, "--token-file", tokenPath].filter(Boolean) };
}

export function mergeCodexMcpConfig(existing: string, entry: { command: string; args: string[] }) {
  const section = `[mcp_servers.nai_recipe_studio]`;
  const block = `${MANAGED_MARKER}\n${section}\ncommand = ${tomlString(entry.command)}\nargs = [${entry.args.map(tomlString).join(", ")}]\n`;
  const lines = existing ? existing.split(/\r?\n/) : [];
  const sectionStart = lines.findIndex(line => line.trim() === section);
  const start = sectionStart > 0 && lines[sectionStart - 1].trim() === MANAGED_MARKER ? sectionStart - 1 : sectionStart;
  if (start < 0) return `${existing.replace(/\s*$/, "")}${existing.trim() ? "\n\n" : ""}${block}`;
  let end = sectionStart + 1;
  while (end < lines.length && !/^\s*\[.+\]\s*$/.test(lines[end])) end++;
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  return [...before, block.replace(/\n$/, ""), ...after].join("\n").replace(/\n{3,}/g, "\n\n") + (existing.endsWith("\n") ? "\n" : "");
}

export function mergeClaudeMcpConfig(existing: Record<string, unknown>, entry: { command: string; args: string[] }) {
  const next = structuredClone(existing) as Record<string, unknown>;
  const servers = next.mcpServers && typeof next.mcpServers === "object" && !Array.isArray(next.mcpServers) ? { ...(next.mcpServers as Record<string, unknown>) } : {};
  servers["nai-recipe-studio"] = { ...entry };
  next.mcpServers = servers;
  return next;
}

export function detectSetupClients(options: { platform?: NodeJS.Platform; homeDir?: string; projectDir?: string } = {}): Record<SetupTarget, SetupClient> {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const codexRoot = path.join(home, ".codex");
  const claudeConfig = platform === "win32"
    ? path.join(options.homeDir ? path.join(home, "AppData", "Roaming") : process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return {
    codex: { id: "codex", available: true, supported: true, configPath: path.join(codexRoot, "config.toml"), skillRoot: path.join(codexRoot, "skills"), supportsSkills: true, scope: "user" },
    "claude-desktop": { id: "claude-desktop", available: platform === "darwin" || platform === "win32", supported: platform === "darwin" || platform === "win32", configPath: claudeConfig, skillRoot: null, supportsSkills: false, scope: "user" },
  };
}

export class SetupManager {
  private readonly fs: SetupFileSystem;
  private readonly clients: Record<SetupTarget, SetupClient>;
  private readonly options: SetupOptions;

  constructor(options: SetupOptions) {
    this.options = options;
    this.fs = options.fs ?? realFs;
    this.clients = { ...detectSetupClients({ platform: options.platform, homeDir: options.homeDir, projectDir: options.projectDir }), ...options.clients } as Record<SetupTarget, SetupClient>;
  }

  async inspect(target: SetupTarget): Promise<SetupStatus> {
    const client = this.client(target);
    const state = await this.state();
    const saved = state.installs[target];
    const config = await readOptional(this.fs, client.configPath);
    const entry = client.id === "codex" ? extractCodexBlock(config?.toString() ?? "") : extractClaudeEntry(config?.toString() ?? "");
    const skillPresent = client.skillRoot ? await this.hasSkill(client.skillRoot) : false;
    const configMatches = !!saved && !!config && hash(config) === saved.configHash;
    return {
      target,
      available: client.available,
      mcpInstalled: Boolean(entry) && (saved ? configMatches || hash(entry) === saved.managedHash : true),
      skillInstalled: skillPresent,
      skillSupported: client.supportsSkills,
      version: saved?.version ?? null,
      configPath: client.configPath,
      skillPath: client.skillRoot ? path.join(client.skillRoot, "recipe-studio") : null,
      ...(client.available ? {} : { messageKey: "settings.ai.clientUnavailable" }),
    };
  }

  async install(input: { client?: SetupTarget; target?: SetupTarget; scope?: "user" | "project"; connectionId?: string }) {
    const target = input.client ?? input.target;
    if (!target) throw new PlatformError("VALIDATION_FAILED", "Choose an AI client.");
    const client = this.client(target);
    if (client.supported === false) throw new PlatformError("CLIENT_UNSUPPORTED", "This AI client is not supported on this OS.");
    if (input.scope && input.scope !== client.scope) throw new PlatformError("CLIENT_UNSUPPORTED", "This setup scope is not supported by the selected client.");
    const state = await this.state();
    const previous = state.installs[target];
    const configBefore = await readOptional(this.fs, client.configPath);
    const connectionId = (input as { connectionId?: string }).connectionId;
    const tokenPath = connectionId && this.options.tokenPathForConnection ? this.options.tokenPathForConnection(connectionId) : this.options.tokenPath ?? this.options.statePath.replace(/setup-state\.json$/, "mcp.token");
    const entry = buildCodexMcpEntry(this.options.runtimePath ?? this.options.helperPath, tokenPath, this.options.endpoint ?? "");
    if (this.options.scriptPath) entry.args.unshift(this.options.scriptPath);
    const managedBefore = client.id === "codex" ? extractCodexBlock(configBefore?.toString() ?? "") : extractClaudeEntry(configBefore?.toString() ?? "");
    const merged = client.id === "codex"
      ? mergeCodexMcpConfig(configBefore?.toString() ?? "", entry)
      : JSON.stringify(mergeClaudeMcpConfig(parseJsonObject(configBefore?.toString() ?? "{}"), entry), null, 2) + "\n";
    const managedAfter = client.id === "codex" ? extractCodexBlock(merged) : extractClaudeEntry(merged);
    if (previous && managedBefore && previous.managedHash !== hash(managedBefore)) throw new PlatformError("SETUP_CONFLICT", "The installed MCP entry was changed outside the app; it was preserved.");
    if (!previous && managedBefore && hash(managedBefore) !== hash(managedAfter)) throw new PlatformError("SETUP_CONFLICT", "An existing MCP entry with this name was not created by the app; it was preserved.");
    if (client.supportsSkills && client.skillRoot) await this.checkSkillBundle(client.skillRoot, previous?.files);
    const skill = client.supportsSkills && client.skillRoot ? await this.installSkill(client.skillRoot, previous?.files) : { files: {}, changed: false, created: [], replaced: {} };
    const configChanged = !configBefore || merged !== configBefore.toString();
    try {
      if (configChanged) await this.writeConfig(client.configPath, Buffer.from(merged));
      const files = skill.files;
      state.installs[target] = { target, configPath: client.configPath, configHash: hash(Buffer.from(merged)), managedHash: hash(client.id === "codex" ? extractCodexBlock(merged) : extractClaudeEntry(merged)), skillPath: client.skillRoot ? path.join(client.skillRoot, "recipe-studio") : null, files, version: this.options.version };
      await this.writeState(state);
    } catch (error) {
      if (configChanged) {
        try {
          if (configBefore) await atomicWrite(this.fs, client.configPath, configBefore);
          else await this.fs.unlink(client.configPath);
        } catch { /* preserve the original setup error */ }
      }
      if (client.skillRoot) await this.restoreSkill(client.skillRoot, skill.created, skill.replaced, skill.files);
      throw error;
    }
    const status = await this.inspect(target);
    const complete = status.mcpInstalled && (!status.skillSupported || status.skillInstalled);
    return { ...status, ok: complete, changed: !configBefore || merged !== configBefore.toString() || skill.changed };
  }

  async remove(input: { client?: SetupTarget; target?: SetupTarget; scope?: "user" | "project" }) {
    const target = input.client ?? input.target;
    if (!target) throw new PlatformError("VALIDATION_FAILED", "Choose an AI client.");
    const client = this.client(target);
    const state = await this.state();
    const previous = state.installs[target];
    if (!previous) return { ...(await this.inspect(target)), ok: true, changed: false };
    const current = await readOptional(this.fs, client.configPath);
    if (current) {
      const currentManaged = client.id === "codex" ? extractCodexBlock(current.toString()) : extractClaudeEntry(current.toString());
      if (currentManaged && hash(currentManaged) === previous.managedHash) {
        const next = client.id === "codex" ? removeCodexBlock(current.toString()) : JSON.stringify(removeClaudeEntry(parseJsonObject(current.toString())), null, 2) + "\n";
        await this.writeConfig(client.configPath, Buffer.from(next));
      }
    }
    if (client.skillRoot && previous.files) await this.removeSkill(client.skillRoot, previous.files);
    delete state.installs[target];
    await this.writeState(state);
    return { ...(await this.inspect(target)), ok: true, changed: true };
  }

  private client(target: SetupTarget) {
    const client = this.clients[target];
    if (!client) throw new PlatformError("CLIENT_UNSUPPORTED", "The selected AI client is not supported.");
    return client;
  }

  private async state(): Promise<SetupState> {
    const raw = await readOptional(this.fs, this.options.statePath);
    if (!raw) return { version: 1, installs: {} };
    try {
      const parsed = JSON.parse(raw.toString()) as SetupState;
      return parsed.version === 1 && parsed.installs && typeof parsed.installs === "object" ? parsed : { version: 1, installs: {} };
    } catch { return { version: 1, installs: {} }; }
  }

  private async writeState(state: SetupState) {
    await atomicWrite(this.fs, this.options.statePath, Buffer.from(JSON.stringify(state, null, 2) + "\n"));
  }

  private async writeConfig(filePath: string, contents: Uint8Array) {
    const old = await readOptional(this.fs, filePath);
    if (old) {
      const backup = `${filePath}.nai-recipe-studio.bak`;
      if (!(await readOptional(this.fs, backup))) { await this.fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 }); await this.fs.copyFile(filePath, backup); }
    }
    await atomicWrite(this.fs, filePath, contents);
  }

  private async installSkill(skillRoot: string, previousFiles?: Record<string, string>) {
    const destination = path.join(skillRoot, "recipe-studio");
    const files: Record<string, string> = {};
    const created: string[] = [];
    const replaced: Record<string, Buffer> = {};
    let changed = false;
    try {
      for (const relative of SKILL_FILES) {
        const source = path.join(this.options.skillSource, relative);
        const input = await readOptional(this.fs, source);
        if (!input) continue;
        const target = path.join(destination, relative);
        const current = await readOptional(this.fs, target);
        if (current && current.toString() !== input.toString()) {
          if (!previousFiles || previousFiles[relative] !== hash(current)) throw new PlatformError("SETUP_CONFLICT", `The skill file ${relative} was changed outside the app; it was preserved.`);
          replaced[relative] = current;
          await atomicWrite(this.fs, target, input);
          changed = true;
        } else if (!current) { await atomicWrite(this.fs, target, input); created.push(relative); changed = true; }
        files[relative] = hash(input);
      }
    } catch (error) {
      await this.restoreSkill(skillRoot, created, replaced, files);
      throw error;
    }
    return { files, changed, created, replaced };
  }

  private async checkSkillBundle(skillRoot: string, previousFiles?: Record<string, string>) {
    for (const relative of SKILL_FILES) {
      const source = await readOptional(this.fs, path.join(this.options.skillSource, relative));
      if (!source) throw new PlatformError("CLIENT_UNSUPPORTED", `The bundled skill file ${relative} is unavailable.`);
      const target = await readOptional(this.fs, path.join(skillRoot, "recipe-studio", relative));
      if (target && target.toString() !== source.toString() && (!previousFiles || previousFiles[relative] !== hash(target))) throw new PlatformError("SETUP_CONFLICT", `The skill file ${relative} was changed outside the app; it was preserved.`);
    }
  }

  private async removeSkill(skillRoot: string, files: Record<string, string>) {
    const destination = path.join(skillRoot, "recipe-studio");
    for (const [relative, expected] of Object.entries(files)) {
      const target = path.join(destination, relative);
      const current = await readOptional(this.fs, target);
      if (current && hash(current) === expected) { try { await this.fs.unlink(target); } catch { /* already removed */ } }
    }
  }

  private async restoreSkill(skillRoot: string, created: string[], replaced: Record<string, Buffer>, files: Record<string, string>) {
    const destination = path.join(skillRoot, "recipe-studio");
    for (const relative of created) {
      const target = path.join(destination, relative);
      const current = await readOptional(this.fs, target);
      if (current && files[relative] && hash(current) === files[relative]) {
        try { await this.fs.unlink(target); } catch { /* already removed */ }
      }
    }
    for (const [relative, original] of Object.entries(replaced)) {
      const target = path.join(destination, relative);
      const current = await readOptional(this.fs, target);
      if (current && files[relative] && hash(current) === files[relative]) {
        try { await atomicWrite(this.fs, target, original); } catch { /* best effort rollback */ }
      }
    }
  }

  private async hasSkill(skillRoot: string) {
    return !!(await readOptional(this.fs, path.join(skillRoot, "recipe-studio", "SKILL.md")));
  }
}

function tomlString(value: string) { return JSON.stringify(value); }
function hash(value: Uint8Array | string | undefined) { return crypto.createHash("sha256").update(value ?? "").digest("hex"); }
function parseJsonObject(raw: string) { try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { throw new PlatformError("SETUP_CONFLICT", "The client configuration is not valid JSON."); } }
function extractCodexBlock(raw: string) {
  const lines = raw.split(/\r?\n/); const section = "[mcp_servers.nai_recipe_studio]"; const sectionStart = lines.findIndex(line => line.trim() === section);
  if (sectionStart < 0) return "";
  const actualStart = sectionStart > 0 && lines[sectionStart - 1].trim() === MANAGED_MARKER ? sectionStart - 1 : sectionStart; let end = sectionStart + 1;
  while (end < lines.length && !/^\s*\[.+\]\s*$/.test(lines[end])) end++;
  return lines.slice(actualStart, end).join("\n").replace(/\n+$/, "") + "\n";
}
function removeCodexBlock(raw: string) {
  const lines = raw.split(/\r?\n/); const section = "[mcp_servers.nai_recipe_studio]"; const startSection = lines.findIndex(line => line.trim() === section); if (startSection < 0) return raw;
  const start = startSection > 0 && lines[startSection - 1].trim() === MANAGED_MARKER ? startSection - 1 : startSection; let end = startSection + 1; while (end < lines.length && !/^\s*\[.+\]\s*$/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}
function extractClaudeEntry(raw: string) { try { const parsed = parseJsonObject(raw); const entry = (parsed.mcpServers as Record<string, unknown> | undefined)?.["nai-recipe-studio"]; return entry ? JSON.stringify(entry) : ""; } catch { return ""; } }
function removeClaudeEntry(value: Record<string, unknown>) {
  const next = { ...value };
  const servers = next.mcpServers && typeof next.mcpServers === "object" && !Array.isArray(next.mcpServers) ? { ...(next.mcpServers as Record<string, unknown>) } : {};
  delete servers["nai-recipe-studio"];
  if (Object.keys(servers).length) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
}
async function readOptional(fs: SetupFileSystem, file: string) { try { return Buffer.from(await fs.readFile(file, "utf8")); } catch (error) { if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null; throw error; } }
async function atomicWrite(fs: SetupFileSystem, file: string, contents: Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try { await fs.writeFile(temp, contents, { mode: 0o600 }); await fs.rename(temp, file); }
  catch (error) { try { await fs.unlink(temp); } catch { /* cleanup is best effort */ } throw error; }
}

export { realFs, SKILL_FILES, MANAGED_MARKER };
