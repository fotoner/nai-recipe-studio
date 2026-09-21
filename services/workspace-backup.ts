import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { StudioError } from "../contracts/studio";
import { WorkspaceBackupSnapshotSchema, WorkspaceBackupImageSchema, type WorkspaceBackupImage, type WorkspaceBackupInspection, type WorkspaceBackupRestoreResult, type WorkspaceBackupSnapshot } from "./workspace-backup-contract";
import { OutputStore, safeRelative } from "../adapters/files/output-store";
import { SqliteWorkspaceBackupAdapter } from "../adapters/sqlite/workspace-backup";
import type { StudioSqliteStore } from "../adapters/sqlite/store";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export class WorkspaceBackupStalePreviewError extends StudioError {
  constructor() {
    super({ code: "BACKUP_PREVIEW_STALE", messageKey: "errors.BACKUP_PREVIEW_STALE", retryable: true });
    this.name = "WorkspaceBackupStalePreviewError";
  }
}

type WorkspaceBackupLock = { release(): void };
export type WorkspaceBackupServiceOptions = {
  store: StudioSqliteStore;
  outputRoot: () => string;
  readImage: (generationId: number) => Promise<Uint8Array | null>;
  hasActiveGeneration: () => boolean;
  acquireExclusive: () => WorkspaceBackupLock;
};

function fail(code: string, messageKey: string, retryable = false): never {
  throw new StudioError({ code, messageKey, retryable });
}

function isMissingImage(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: unknown }).code === "ENOENT";
}

function digest(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function isPng(data: Uint8Array) {
  return data.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

function validateBackupId(backupId: string) {
  if (!/^[a-f0-9]{64}$/.test(backupId)) fail("INVALID_BACKUP_ARCHIVE", "errors.INVALID_BACKUP_ARCHIVE");
}

function parseSnapshot(value: unknown): WorkspaceBackupSnapshot {
  const parsed = WorkspaceBackupSnapshotSchema.safeParse(value);
  if (!parsed.success) fail("INVALID_BACKUP_ARCHIVE", "errors.INVALID_BACKUP_ARCHIVE");
  return parsed.data;
}

function parseImages(value: unknown): WorkspaceBackupImage[] {
  const parsed = WorkspaceBackupImageSchema.array().max(19_999).safeParse(value);
  if (!parsed.success) fail("INVALID_BACKUP_ARCHIVE", "errors.INVALID_BACKUP_ARCHIVE");
  const ids = new Set<number>();
  for (const image of parsed.data) {
    if (ids.has(image.generationId)) fail("INVALID_BACKUP_ARCHIVE", "errors.INVALID_BACKUP_ARCHIVE");
    ids.add(image.generationId);
  }
  return parsed.data;
}

export function createWorkspaceBackupService(options: WorkspaceBackupServiceOptions) {
  const adapter = new SqliteWorkspaceBackupAdapter(options.store);

  async function withExclusive<T>(work: () => Promise<T>): Promise<T> {
    const lock = options.acquireExclusive();
    try {
      if (options.hasActiveGeneration()) fail("WORKSPACE_BUSY", "errors.WORKSPACE_BUSY", true);
      return await work();
    } finally {
      lock.release();
    }
  }

  async function readWorkspaceImageHashes(): Promise<Map<number, string | null>> {
    const hashes = new Map<number, string | null>();
    for (const id of adapter.listGenerationIds()) {
      try {
        const bytes = await options.readImage(id);
        hashes.set(id, bytes ? digest(bytes) : null);
      } catch (cause) {
        if (isMissingImage(cause)) { hashes.set(id, null); continue; }
        throw cause;
      }
    }
    return hashes;
  }

  async function inspect(value: unknown, input: { backupId: string; images: WorkspaceBackupImage[] }): Promise<WorkspaceBackupInspection> {
    if (options.hasActiveGeneration()) fail("WORKSPACE_BUSY", "errors.WORKSPACE_BUSY", true);
    const snapshot = parseSnapshot(value);
    const images = parseImages(input.images);
    validateBackupId(input.backupId);
    const generationIds = new Set(snapshot.generations.map(generation => generation.id));
    if (images.some(image => !generationIds.has(image.generationId))) fail("INVALID_BACKUP_ARCHIVE", "errors.INVALID_BACKUP_ARCHIVE");
    const imageHashes = await readWorkspaceImageHashes();
    return adapter.analyze(snapshot, input.backupId, images, imageHashes).inspection;
  }

  async function restore(value: unknown, input: {
    backupId: string;
    expectedRevision: string;
    images: WorkspaceBackupImage[];
    readAsset: (sourceGenerationId: number) => Promise<Uint8Array | null>;
  }): Promise<WorkspaceBackupRestoreResult> {
    return withExclusive(async () => {
      const snapshot = parseSnapshot(value);
      const images = parseImages(input.images);
      validateBackupId(input.backupId);
      if (!/^[a-f0-9]{64}$/.test(input.expectedRevision)) fail("INVALID_BACKUP_ARCHIVE", "errors.INVALID_BACKUP_ARCHIVE");
      const generationIds = new Set(snapshot.generations.map(generation => generation.id));
      if (images.some(image => !generationIds.has(image.generationId))) fail("INVALID_BACKUP_ARCHIVE", "errors.INVALID_BACKUP_ARCHIVE");

      const imageHashes = await readWorkspaceImageHashes();
      const analysis = adapter.analyze(snapshot, input.backupId, images, imageHashes);
      if (analysis.inspection.revision !== input.expectedRevision) throw new WorkspaceBackupStalePreviewError();
      if (analysis.inspection.alreadyImported) {
        return {
          alreadyImported: true,
          restored: { recipes: 0, recipeVersions: 0, characters: 0, presets: 0, galleryItems: 0, images: 0 },
          skipped: analysis.inspection.counts,
        };
      }

      const targetRoot = path.resolve(options.outputRoot());
      const output = new OutputStore(targetRoot);
      const importDirectoryName = randomUUID();
      const importDirectory = path.join(targetRoot, "images", "workspace-imports", importDirectoryName);
      const imageFiles = new Map<number, string>();
      let committed = false;
      try {
        for (const image of images) {
          if (analysis.duplicateGenerationIds.has(image.generationId)) continue;
          const bytes = await input.readAsset(image.generationId).catch(cause => {
            if (isMissingImage(cause)) fail("BACKUP_FILE_UNAVAILABLE", "errors.BACKUP_FILE_UNAVAILABLE");
            throw cause;
          });
          if (!bytes || bytes.byteLength !== image.size || digest(bytes) !== image.sha256 || !isPng(bytes)) {
            fail("BACKUP_SOURCE_CHANGED", "errors.BACKUP_SOURCE_CHANGED");
          }
          const relative = path.posix.join("images", "workspace-imports", importDirectoryName, `generation-${image.generationId}.png`);
          const safe = safeRelative(relative);
          await output.write(safe, bytes);
          imageFiles.set(image.generationId, safe);
        }

        const result = adapter.restore(snapshot, input.backupId, analysis, imageFiles, targetRoot);
        committed = !result.alreadyImported;
        return result;
      } finally {
        if (!committed) await rm(importDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  return {
    withExclusive,
    exportSnapshot() { return adapter.exportSnapshot(); },
    inspect,
    restore,
  };
}

export type WorkspaceBackupService = ReturnType<typeof createWorkspaceBackupService>;
