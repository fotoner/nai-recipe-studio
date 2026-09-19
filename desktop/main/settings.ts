import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlatformError } from "./errors";

export const SUPPORTED_LANGUAGES = ["system", "ko", "ja", "en"] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export type AppSettings = {
  version: 1;
  language: AppLanguage;
  blurSensitiveImages: boolean;
  outputDirectory: string | null;
  window: { width: number; height: number; x?: number; y?: number; maximized?: boolean };
  ai: { enabled: boolean; clients: string[]; scopes: Array<"read" | "write" | "generate">; maxAnlas: number | null; maxCount: number | null };
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  language: "system",
  blurSensitiveImages: true,
  outputDirectory: null,
  window: { width: 1280, height: 840 },
  ai: { enabled: false, clients: [], scopes: ["read", "write"], maxAnlas: 0, maxCount: 1 },
};

export function parseAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") throw new PlatformError("VALIDATION_FAILED", "Invalid app settings.");
  const raw = value as Record<string, unknown>;
  const language = raw.language;
  if (!SUPPORTED_LANGUAGES.includes(language as AppLanguage)) throw new PlatformError("VALIDATION_FAILED", "Unsupported app language.");
  const imageBlur = raw.blurSensitiveImages;
  if (typeof imageBlur !== "boolean") throw new PlatformError("VALIDATION_FAILED", "Invalid image display setting.");
  const window = raw.window;
  if (!window || typeof window !== "object") throw new PlatformError("VALIDATION_FAILED", "Invalid window setting.");
  const w = window as Record<string, unknown>;
  if (!Number.isInteger(w.width) || !Number.isInteger(w.height) || Number(w.width) < 640 || Number(w.height) < 480) throw new PlatformError("VALIDATION_FAILED", "Invalid window size.");
  const ai = raw.ai;
  if (!ai || typeof ai !== "object") throw new PlatformError("VALIDATION_FAILED", "Invalid AI connection setting.");
  const aiRaw = ai as Record<string, unknown>;
  const scopes = aiRaw.scopes;
  if (!Array.isArray(scopes) || scopes.some(scope => scope !== "read" && scope !== "write" && scope !== "generate")) throw new PlatformError("VALIDATION_FAILED", "Invalid AI connection scope.");
  const maxAnlas = aiRaw.maxAnlas;
  const maxCount = aiRaw.maxCount;
  if (maxAnlas !== null && (!Number.isFinite(maxAnlas) || Number(maxAnlas) < 0) || maxCount !== null && (!Number.isInteger(maxCount) || Number(maxCount) < 0)) throw new PlatformError("VALIDATION_FAILED", "Invalid AI connection budget.");
  return {
    version: 1,
    language: language as AppLanguage,
    blurSensitiveImages: imageBlur,
    outputDirectory: typeof raw.outputDirectory === "string" ? raw.outputDirectory : null,
    window: {
      width: Number(w.width), height: Number(w.height),
      ...(Number.isInteger(w.x) ? { x: Number(w.x) } : {}),
      ...(Number.isInteger(w.y) ? { y: Number(w.y) } : {}),
      ...(typeof w.maximized === "boolean" ? { maximized: w.maximized } : {}),
    },
    ai: {
      enabled: Boolean(aiRaw.enabled),
      clients: Array.isArray(aiRaw.clients) ? aiRaw.clients.filter((client): client is string => typeof client === "string") : [],
      scopes: [...scopes] as Array<"read" | "write" | "generate">,
      maxAnlas: maxAnlas === null ? null : Number(maxAnlas),
      maxCount: maxCount === null ? null : Number(maxCount),
    },
  };
}

export class SettingsStore {
  private current: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async get(): Promise<AppSettings> {
    await this.load();
    return structuredClone(this.current);
  }

  async update(patch: Partial<AppSettings> & { ai?: Partial<AppSettings["ai"]>; window?: Partial<AppSettings["window"]> }) {
    await this.load();
    const next = parseAppSettings({
      ...this.current,
      ...patch,
      window: { ...this.current.window, ...(patch.window ?? {}) },
      ai: { ...this.current.ai, ...(patch.ai ?? {}) },
    });
    this.current = next;
    await this.save();
    return structuredClone(next);
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      this.current = parseAppSettings(parsed);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        await this.save();
        return;
      }
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("VALIDATION_FAILED", "The app settings file is invalid.", { cause: error });
    }
  }

  private async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify(this.current, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
