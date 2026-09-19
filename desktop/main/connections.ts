import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Connection } from "../../contracts/studio";
import { PlatformError } from "./errors";

type Stored = { version: 1; connections: Connection[] };

export class ConnectionStore {
  private loaded = false;
  private connections: Connection[] = [];

  constructor(private readonly filePath: string, private readonly tokenRoot = path.join(path.dirname(filePath), "connections")) {}

  async list() { await this.load(); return this.connections.map(value => structuredClone(value)); }

  async get(id: string) { await this.load(); return this.connections.find(value => value.id === id) ? structuredClone(this.connections.find(value => value.id === id)!) : null; }

  async create(input: { name: string; permissions: Connection["permissions"]; maxImages: number; maxAnlas: number }) {
    await this.load();
    if (!input.name.trim() || input.maxImages < 0 || input.maxAnlas < 0) throw new PlatformError("VALIDATION_FAILED");
    const value: Connection = { id: crypto.randomUUID(), name: input.name.trim(), permissions: { ...input.permissions }, maxImages: input.maxImages, maxAnlas: input.maxAnlas, created_at: new Date().toISOString() };
    this.connections.push(value);
    await this.save();
    await this.ensureToken(value.id);
    return structuredClone(value);
  }

  async revoke(id: string) {
    await this.load();
    const before = this.connections.length;
    this.connections = this.connections.filter(value => value.id !== id);
    if (this.connections.length !== before) {
      await this.save();
      try { await unlink(this.tokenPath(id)); } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
      }
    }
    return { revoked: this.connections.length !== before };
  }

  tokenPath(id: string) {
    // Hashing keeps the path safe even while the store is reading a legacy or
    // malformed id. The id itself never becomes a filesystem path component.
    const key = crypto.createHash("sha256").update(id).digest("hex");
    return path.join(this.tokenRoot, `${key}.token`);
  }

  async ensureToken(id: string) {
    const connection = await this.get(id);
    if (!connection) throw new PlatformError("PERMISSION_DENIED", "The AI connection is no longer available.");
    const file = this.tokenPath(id);
    await mkdir(this.tokenRoot, { recursive: true, mode: 0o700 });
    await chmod(this.tokenRoot, 0o700);
    try {
      const current = (await readFile(file, "utf8")).trim();
      if (/^[a-f0-9]{64}$/i.test(current)) {
        await chmod(file, 0o600);
        return file;
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
    }
    const token = crypto.randomBytes(32).toString("hex");
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, token + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
    return file;
  }

  async ensureAllTokens() {
    const connections = await this.list();
    for (const connection of connections) await this.ensureToken(connection.id);
  }

  async resolveToken(candidate: string): Promise<{ connectionId: string; scopes: string[] } | null> {
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return null;
    const connections = await this.list();
    const candidateBytes = Buffer.from(candidate, "utf8");
    for (const connection of connections) {
      try {
        const stored = (await readFile(this.tokenPath(connection.id), "utf8")).trim();
        const storedBytes = Buffer.from(stored, "utf8");
        if (storedBytes.length === candidateBytes.length && crypto.timingSafeEqual(storedBytes, candidateBytes)) {
          return { connectionId: connection.id, scopes: connectionScopes(connection) };
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
      }
    }
    return null;
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Stored;
      if (parsed.version === 1 && Array.isArray(parsed.connections)) this.connections = parsed.connections;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return;
      throw new PlatformError("VALIDATION_FAILED", "The AI connection settings are unreadable.", { cause: error });
    }
  }

  private async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, JSON.stringify({ version: 1, connections: this.connections }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.filePath);
  }
}

function connectionScopes(connection: Connection) {
  const scopes: string[] = [];
  if (connection.permissions.read) scopes.push("read");
  if (connection.permissions.write) scopes.push("write");
  if (connection.permissions.generate) scopes.push("generate");
  if (connection.permissions.images) scopes.push("images");
  return scopes;
}
