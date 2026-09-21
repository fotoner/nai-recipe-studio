import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlatformError } from "./errors";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  /** Linux only. "basic_text" means no keyring is available and the key is hardcoded. */
  getSelectedStorageBackend?(): string;
}

type CredentialEnvelope = { version: 1; values: Record<string, string> };

/**
 * A small safeStorage-backed credential store. The file contains only
 * ciphertext; when OS protection is unavailable the caller must keep the
 * credential for the current process instead of silently writing plaintext.
 */
export class CredentialStore {
  private readonly memory = new Map<string, string>();
  private loaded = false;

  constructor(private readonly filePath: string, private readonly safeStorage: SafeStorageLike) {}

  async get(name: string): Promise<string | null> {
    await this.load();
    if (this.memory.has(name)) return this.memory.get(name)!;
    const envelope = await this.readEnvelope();
    const encrypted = envelope.values[name];
    if (!encrypted) return null;
    try {
      const value = this.safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      return value;
    } catch (cause) {
      throw new PlatformError("CREDENTIAL_PROTECTION_UNAVAILABLE", "Saved credentials could not be decrypted.", { cause });
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (!name || !value) throw new PlatformError("VALIDATION_FAILED", "A credential name and value are required.");
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new PlatformError("CREDENTIAL_PROTECTION_UNAVAILABLE", "OS credential protection is unavailable; the token was not saved.", {
        action: "use-this-token-for-the-current-session-only",
      });
    }
    await this.load();
    const envelope = await this.readEnvelope();
    envelope.values[name] = this.safeStorage.encryptString(value).toString("base64");
    await this.writeEnvelope(envelope);
    this.memory.delete(name);
  }

  async clear(name: string): Promise<void> {
    await this.load();
    const envelope = await this.readEnvelope();
    delete envelope.values[name];
    this.memory.delete(name);
    await this.writeEnvelope(envelope);
  }

  /** Keep a token only in memory when the user chooses a session-only connection. */
  setEphemeral(name: string, value: string) {
    if (!name || !value) throw new PlatformError("VALIDATION_FAILED", "A credential name and value are required.");
    this.memory.set(name, value);
  }

  forgetEphemeral(name: string) {
    this.memory.delete(name);
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  private async readEnvelope(): Promise<CredentialEnvelope> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { values?: unknown }).values !== "object") {
        throw new Error("invalid credential envelope");
      }
      return { version: 1, values: { ...((parsed as { values: Record<string, string> }).values) } };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return { version: 1, values: {} };
      }
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("CREDENTIAL_PROTECTION_UNAVAILABLE", "The credential store is unreadable.", { cause: error });
    }
  }

  private async writeEnvelope(envelope: CredentialEnvelope) {
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify(envelope) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
