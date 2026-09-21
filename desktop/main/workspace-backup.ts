import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { StudioError } from "../../contracts/studio";
import type { WorkspaceBackupCounts, WorkspaceBackupPreview } from "../../contracts/workspace-backup";
import type { WorkspaceBackupService } from "../../services/workspace-backup";
import { WorkspaceBackupManifestSchema, type WorkspaceBackupImage, type WorkspaceBackupManifest, type WorkspaceBackupSnapshot } from "../../services/workspace-backup-contract";
import { nativeText } from "./native-text";
import { readStoredWorkspaceArchive, writeStoredWorkspaceArchive, WorkspaceArchiveError, type WorkspaceArchiveReadResult } from "./workspace-archive";

type StagedBackup = {
  manifest: WorkspaceBackupManifest;
  archive: WorkspaceArchiveReadResult;
  archiveBytes: number;
  revision: string;
  expiresAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
type Options = {
  service: WorkspaceBackupService;
  stagingRoot: string;
  appVersion: string;
  readImage(id: number): Promise<Uint8Array>;
  language(): Promise<string>;
  dialog: {
    openFile(options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
    saveFile(options: unknown): Promise<{ canceled: boolean; filePath?: string }>;
  };
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const backupHash = (snapshot: WorkspaceBackupSnapshot, images: WorkspaceBackupImage[]) => hash(JSON.stringify({ snapshot, images }));
function fail(code: string): never { throw new StudioError({ code, messageKey: `errors.${code}` }); }
function countsFor(snapshot: WorkspaceBackupSnapshot, images: WorkspaceBackupImage[]): WorkspaceBackupCounts {
  return { recipes: snapshot.recipes.length, recipeVersions: snapshot.recipeVersions.length, characters: snapshot.characters.length, presets: snapshot.presets.length, galleryItems: snapshot.generations.length, images: images.length };
}

/** Native file paths and extracted assets stay in main; renderers receive short-lived opaque tickets. */
export class WorkspaceBackupCoordinator {
  private readonly staged = new Map<string, StagedBackup>();
  private busy = false;
  private pending: Promise<unknown> | undefined;
  constructor(private readonly options: Options) {}

  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) fail("WORKSPACE_BUSY");
    this.busy = true;
    try {
      const pending = work();
      this.pending = pending;
      return await pending;
    } catch (cause) {
      if (cause instanceof StudioError) throw cause;
      if (cause instanceof WorkspaceArchiveError) fail(cause.code);
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOSPC") fail("STORAGE_FULL");
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") fail("BACKUP_FILE_UNAVAILABLE");
      // Service errors carry a structured payload; don't replace conflict/retry guidance.
      if (cause && typeof cause === "object" && "data" in cause) throw cause;
      fail("INVALID_BACKUP_ARCHIVE");
    } finally {
      this.busy = false;
      this.pending = undefined;
    }
  }

  export() {
    return this.run(async () => {
      const text = nativeText(await this.options.language());
      const selection = await this.options.dialog.saveFile({ title: text.exportWorkspaceBackup, filters: [{ name: "NAI Recipe Studio", extensions: ["naistudio"] }], defaultPath: `NAI-Recipe-Studio-${new Date().toISOString().slice(0, 10)}.naistudio` });
      if (selection.canceled || !selection.filePath) return { saved: false };
      if (path.extname(selection.filePath).toLowerCase() !== ".naistudio") fail("INVALID_BACKUP_ARCHIVE");
      return this.options.service.withExclusive(async () => {
        const snapshot = await this.options.service.exportSnapshot();
        const images: WorkspaceBackupImage[] = [];
        for (const generation of snapshot.generations) {
          try {
            const bytes = await this.options.readImage(generation.id);
            images.push({ generationId: generation.id, path: `assets/generation-${generation.id}.png`, sha256: hash(bytes), size: bytes.byteLength });
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
          }
        }
        const manifest = WorkspaceBackupManifestSchema.parse({ format: "nai-recipe-studio-workspace", schemaVersion: 1, backupId: backupHash(snapshot, images), createdAt: new Date().toISOString(), appVersion: this.options.appVersion, snapshot, images });
        // Parsing applies canonical schema defaults before calculating the portable content ID.
        manifest.backupId = backupHash(manifest.snapshot, manifest.images);
        await writeStoredWorkspaceArchive(selection.filePath!, [
          { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
          ...images.map(image => ({ name: image.path, data: async () => {
            const bytes = await this.options.readImage(image.generationId);
            if (bytes.byteLength !== image.size || hash(bytes) !== image.sha256) fail("BACKUP_SOURCE_CHANGED");
            return bytes;
          } })),
        ]);
        return { saved: true, counts: countsFor(snapshot, images), missingFiles: snapshot.generations.length - images.length };
      });
    });
  }

  inspect(stagingId?: string): Promise<{ preview: WorkspaceBackupPreview | null }> {
    return this.run(async () => {
      if (stagingId) {
        const stage = await this.getStage(stagingId);
        const preview = await this.preview(stagingId, stage);
        this.scheduleStageExpiry(stagingId, stage);
        return { preview };
      }
      const text = nativeText(await this.options.language());
      const selection = await this.options.dialog.openFile({ title: text.importWorkspaceBackup, filters: [{ name: "NAI Recipe Studio", extensions: ["naistudio"] }], properties: ["openFile"] });
      if (selection.canceled || !selection.filePaths[0]) return { preview: null };
      const archivePath = selection.filePaths[0];
      if (path.extname(archivePath).toLowerCase() !== ".naistudio") fail("INVALID_BACKUP_ARCHIVE");
      const archiveBytes = (await stat(archivePath)).size;
      const archive = await readStoredWorkspaceArchive(archivePath, this.options.stagingRoot);
      try {
        const manifestEntry = archive.entries.find(entry => entry.name === "manifest.json");
        if (!manifestEntry) fail("INVALID_BACKUP_ARCHIVE");
        const manifest = WorkspaceBackupManifestSchema.parse(JSON.parse(await readFile(manifestEntry.path, "utf8")));
        if (manifest.backupId !== backupHash(manifest.snapshot, manifest.images)) fail("INVALID_BACKUP_ARCHIVE");
        const expectedNames = new Set(["manifest.json", ...manifest.images.map(image => image.path)]);
        if (archive.entries.length !== expectedNames.size || archive.entries.some(entry => !expectedNames.has(entry.name))) fail("INVALID_BACKUP_ARCHIVE");
        const stage: StagedBackup = { manifest, archive, archiveBytes, revision: "", expiresAt: Date.now() + 30 * 60_000 };
        for (const image of manifest.images) await this.readAsset(stage, image.generationId);
        // Keep only the most recently reviewed archive to bound staging disk usage.
        await this.clearStages();
        const id = randomUUID();
        const preview = await this.preview(id, stage);
        this.staged.set(id, stage);
        this.scheduleStageExpiry(id, stage);
        return { preview };
      } catch (cause) {
        await archive.cleanup();
        throw cause;
      }
    });
  }

  restore(stagingId: string) {
    return this.run(async () => {
      const stage = await this.getStage(stagingId);
      const result = await this.options.service.restore(stage.manifest.snapshot, {
        backupId: stage.manifest.backupId, expectedRevision: stage.revision, images: stage.manifest.images,
        readAsset: (generationId: number) => this.readAsset(stage, generationId),
      });
      this.staged.delete(stagingId);
      this.clearStageExpiry(stage);
      await stage.archive.cleanup();
      return result;
    });
  }

  private async preview(stagingId: string, stage: StagedBackup): Promise<WorkspaceBackupPreview> {
    const inspection = await this.options.service.inspect(stage.manifest.snapshot, { backupId: stage.manifest.backupId, images: stage.manifest.images });
    stage.revision = inspection.revision;
    stage.expiresAt = Date.now() + 30 * 60_000;
    return { stagingId, backupId: stage.manifest.backupId, createdAt: stage.manifest.createdAt, appVersion: stage.manifest.appVersion, archiveBytes: stage.archiveBytes, counts: inspection.counts, duplicates: inspection.duplicates, missingFiles: inspection.missingFiles, alreadyImported: inspection.alreadyImported };
  }

  private async readAsset(stage: StagedBackup, generationId: number) {
    const image = stage.manifest.images.find(item => item.generationId === generationId);
    const entry = image && stage.archive.entries.find(item => item.name === image.path);
    if (!image || !entry) fail("INVALID_BACKUP_ARCHIVE");
    const bytes = await readFile(entry.path);
    if (bytes.byteLength !== image.size || hash(bytes) !== image.sha256) fail("INVALID_BACKUP_ARCHIVE");
    return bytes;
  }

  private async getStage(id: string) {
    const stage = this.staged.get(id);
    if (!stage) fail("BACKUP_PREVIEW_EXPIRED");
    if (stage.expiresAt <= Date.now()) {
      this.staged.delete(id);
      this.clearStageExpiry(stage);
      await stage.archive.cleanup();
      fail("BACKUP_PREVIEW_EXPIRED");
    }
    return stage;
  }

  private clearStageExpiry(stage: StagedBackup) {
    if (stage.expiryTimer) clearTimeout(stage.expiryTimer);
    stage.expiryTimer = undefined;
  }

  private scheduleStageExpiry(id: string, stage: StagedBackup, delayMs = Math.max(0, stage.expiresAt - Date.now())) {
    if (this.staged.get(id) !== stage) return;
    this.clearStageExpiry(stage);
    const timer = setTimeout(() => this.expireStage(id, stage).catch(() => {
      if (this.staged.get(id) === stage) this.scheduleStageExpiry(id, stage, 1_000);
    }), delayMs);
    stage.expiryTimer = timer;
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }

  private async expireStage(id: string, stage: StagedBackup) {
    if (this.staged.get(id) !== stage) return;
    if (stage.expiresAt > Date.now()) {
      this.scheduleStageExpiry(id, stage);
      return;
    }
    if (this.busy) {
      this.scheduleStageExpiry(id, stage, 1_000);
      return;
    }
    await this.run(async () => {
      if (this.staged.get(id) !== stage) return;
      if (stage.expiresAt > Date.now()) {
        this.scheduleStageExpiry(id, stage);
        return;
      }
      await stage.archive.cleanup();
      this.staged.delete(id);
      this.clearStageExpiry(stage);
    });
  }

  private async clearStages() {
    const entries = [...this.staged.entries()];
    for (const [id, stage] of entries) {
      this.clearStageExpiry(stage);
      this.staged.delete(id);
    }
    for (const [, stage] of entries) await stage.archive.cleanup();
  }

  async close() {
    await this.pending?.catch(() => undefined);
    await this.clearStages();
  }
}
