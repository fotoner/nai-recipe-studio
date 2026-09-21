import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceBackupCoordinator } from "../desktop/main/workspace-backup";
import { readStoredWorkspaceArchive, writeStoredWorkspaceArchive } from "../desktop/main/workspace-archive";
import type { WorkspaceBackupSnapshot } from "../services/workspace-backup-contract";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const counts = { recipes: 1, recipeVersions: 0, characters: 0, presets: 0, galleryItems: 0, images: 0 };
const empty = { recipes: 0, recipeVersions: 0, characters: 0, presets: 0, galleryItems: 0, images: 0 };
const snapshot: WorkspaceBackupSnapshot = {
  schemaVersion: 1,
  recipes: [{ id: 1, version: 1, createdAt: "2026-09-20", updatedAt: "2026-09-20", recipe: { id: 1, name: "Fixture", tags: [], rating: 0, blocks: [], source: "manual", notes: "" } }],
  recipeVersions: [], characters: [], presets: [], generations: [],
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nai-coordinator-")); roots.push(root);
  const target = path.join(root, "workspace.naistudio");
  const service = {
    exportSnapshot: vi.fn(() => structuredClone(snapshot)),
    inspect: vi.fn(async () => ({ revision: "revision-1", counts, duplicates: empty, missingFiles: 0, alreadyImported: false })),
    restore: vi.fn(async () => ({ restored: counts, skipped: empty, alreadyImported: false })),
    withExclusive<T,>(work: () => Promise<T>) { return work(); },
  };
  const exclusiveSpy = vi.fn();
  service.withExclusive = <T,>(work: () => Promise<T>) => { exclusiveSpy(); return work(); };
  const dialog = {
    saveFile: vi.fn(async () => ({ canceled: false, filePath: target })),
    openFile: vi.fn(async () => ({ canceled: false, filePaths: [target] })),
  };
  const coordinator = new WorkspaceBackupCoordinator({ service, dialog, stagingRoot: path.join(root, "staging"), readImage: vi.fn(), language: async () => "en", appVersion: "0.1.0" });
  return { root, target, service, dialog, coordinator, exclusiveSpy };
}

describe("workspace backup native coordinator", () => {
  it("uses native file choices, holds the export lock, and restores only its inspected ticket", async () => {
    const f = await fixture();
    await expect(f.coordinator.export()).resolves.toEqual({ saved: true, counts, missingFiles: 0 });
    expect(f.exclusiveSpy).toHaveBeenCalledOnce();
    expect(f.dialog.saveFile).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: "NAI Recipe Studio", extensions: ["naistudio"] }] }));
    const { preview } = await f.coordinator.inspect();
    expect(preview).toMatchObject({ counts, missingFiles: 0, alreadyImported: false });
    await f.coordinator.restore(preview!.stagingId);
    expect(f.service.restore).toHaveBeenCalledWith(snapshot, expect.objectContaining({ expectedRevision: "revision-1", backupId: preview!.backupId, images: [] }));
    await expect(f.coordinator.restore(preview!.stagingId)).rejects.toMatchObject({ data: { code: "BACKUP_PREVIEW_EXPIRED" } });
    expect(await readdir(path.join(f.root, "staging"))).toEqual([]);
  });

  it("does no workspace work if the native dialog is cancelled", async () => {
    const f = await fixture();
    f.dialog.saveFile.mockResolvedValue({ canceled: true, filePath: "" });
    f.dialog.openFile.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(f.coordinator.export()).resolves.toEqual({ saved: false });
    await expect(f.coordinator.inspect()).resolves.toEqual({ preview: null });
    expect(f.service.exportSnapshot).not.toHaveBeenCalled();
    expect(f.service.restore).not.toHaveBeenCalled();
  });

  it("rejects tampered manifests before presenting a preview or restoring records", async () => {
    const f = await fixture();
    await f.coordinator.export();
    const extracted = await readStoredWorkspaceArchive(f.target, path.join(f.root, "original"));
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(extracted.entries.find(entry => entry.name === "manifest.json")!.path, "utf8"));
    manifest.snapshot.recipes[0].recipe.name = "tampered";
    await writeStoredWorkspaceArchive(f.target, [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }]);
    await extracted.cleanup();
    await expect(f.coordinator.inspect()).rejects.toMatchObject({ data: { code: "INVALID_BACKUP_ARCHIVE" } });
    expect(f.service.inspect).not.toHaveBeenCalled();
    expect(f.service.restore).not.toHaveBeenCalled();
    expect(await readdir(path.join(f.root, "staging"))).toEqual([]);
  });

  it("rechecks a staged preview without a new file dialog and removes private staging on close", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.coordinator.export();
    const { preview } = await f.coordinator.inspect();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    f.service.inspect.mockResolvedValue({ revision: "revision-2", counts, duplicates: empty, missingFiles: 0, alreadyImported: false });
    const reviewed = await f.coordinator.inspect(preview!.stagingId);
    expect(reviewed.preview?.stagingId).toBe(preview!.stagingId);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await expect(f.coordinator.restore(preview!.stagingId)).resolves.toMatchObject({ restored: counts });
    expect(vi.getTimerCount()).toBe(0);
    const { preview: secondPreview } = await f.coordinator.inspect();
    expect(vi.getTimerCount()).toBe(1);
    expect(f.dialog.openFile).toHaveBeenCalledTimes(2);
    await f.coordinator.close();
    expect(vi.getTimerCount()).toBe(0);
    await expect(f.coordinator.restore(secondPreview!.stagingId)).rejects.toMatchObject({ data: { code: "BACKUP_PREVIEW_EXPIRED" } });
    expect(await readdir(path.join(f.root, "staging"))).toEqual([]);
  });

  it("expires idle staging automatically but postpones cleanup while restore is in progress", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.coordinator.export();
    const { preview } = await f.coordinator.inspect();
    expect(vi.getTimerCount()).toBe(1);
    const stagingRoot = path.join(f.root, "staging");
    expect(await readdir(stagingRoot)).not.toEqual([]);

    let finishRestore!: (value: Awaited<ReturnType<typeof f.service.restore>>) => void;
    f.service.restore.mockImplementation(() => new Promise(resolve => { finishRestore = resolve; }));
    const restoring = f.coordinator.restore(preview!.stagingId);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.service.restore).toHaveBeenCalledOnce();

    await vi.advanceTimersToNextTimerAsync();
    expect(await readdir(stagingRoot)).not.toEqual([]);
    finishRestore({ restored: counts, skipped: empty, alreadyImported: false });
    await expect(restoring).resolves.toMatchObject({ restored: counts });
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    const { preview: expired } = await f.coordinator.inspect();
    expect(await readdir(stagingRoot)).not.toEqual([]);
    await vi.advanceTimersToNextTimerAsync();
    vi.useRealTimers();
    await vi.waitFor(() => expect(f.coordinator.restore(expired!.stagingId)).rejects.toMatchObject({ data: { code: "BACKUP_PREVIEW_EXPIRED" } }));
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it("replaces the prior preview ticket and clears its expiry timer", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.coordinator.export();
    const { preview: first } = await f.coordinator.inspect();
    expect(vi.getTimerCount()).toBe(1);

    const { preview: second } = await f.coordinator.inspect();
    expect(second?.stagingId).not.toBe(first?.stagingId);
    expect(vi.getTimerCount()).toBe(1);
    await expect(f.coordinator.restore(first!.stagingId)).rejects.toMatchObject({ data: { code: "BACKUP_PREVIEW_EXPIRED" } });

    await f.coordinator.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(await readdir(path.join(f.root, "staging"))).toEqual([]);
  });
});
