import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readStoredWorkspaceArchive, writeStoredWorkspaceArchive } from "../desktop/main/workspace-archive";

describe("workspace backup archive boundary", () => {
  it("round-trips stored PNG and manifest members into an isolated staging directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-archive-"));
    try {
      const archivePath = path.join(root, "workspace.naistudio");
      const source = new Map([
        ["manifest.json", Buffer.from('{"format":"nai-recipe-studio-workspace"}')],
        ["assets/generation-17.png", Buffer.from([137, 80, 78, 71, 0, 1, 2])],
      ]);
      await writeStoredWorkspaceArchive(archivePath, [...source].map(([name, data]) => ({ name, data })));

      const extracted = await readStoredWorkspaceArchive(archivePath, path.join(root, "staging"));
      expect(extracted.entries.map(entry => entry.name)).toEqual(["manifest.json", "assets/generation-17.png"]);
      expect(await readFile(extracted.entries[1]!.path)).toEqual(source.get("assets/generation-17.png"));
      await extracted.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal names before creating files outside the staging directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-archive-"));
    try {
      const archivePath = path.join(root, "malicious.naistudio");
      await writeStoredWorkspaceArchive(archivePath, [{ name: "assets/bbb.png", data: Buffer.from([1, 2, 3]) }]);
      const archive = await readFile(archivePath);
      const oldName = Buffer.from("assets/bbb.png");
      const traversal = Buffer.from("../foo/bar.png");
      expect(traversal.length).toBe(oldName.length);
      let offset = 0;
      while ((offset = archive.indexOf(oldName, offset)) >= 0) {
        archive.fill(traversal, offset);
        offset += traversal.length;
      }
      await writeFile(archivePath, archive);

      await expect(readStoredWorkspaceArchive(archivePath, path.join(root, "staging"))).rejects.toMatchObject({ code: "INVALID_BACKUP_ARCHIVE" });
      await expect(readFile(path.join(root, "foo", "bar.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces per-entry and archive size limits before extraction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-archive-"));
    try {
      const archivePath = path.join(root, "large.naistudio");
      await writeStoredWorkspaceArchive(archivePath, [{ name: "manifest.json", data: Buffer.from("12345") }]);

      await expect(readStoredWorkspaceArchive(archivePath, path.join(root, "staging"), { maxEntryBytes: 4 }))
        .rejects.toMatchObject({ code: "BACKUP_SIZE_LIMIT" });
      await expect(readStoredWorkspaceArchive(archivePath, path.join(root, "staging"), { maxArchiveBytes: 16 }))
        .rejects.toMatchObject({ code: "BACKUP_SIZE_LIMIT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies manifest and final archive limits while writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-archive-"));
    try {
      const archivePath = path.join(root, "too-large.naistudio");
      const manifest = Buffer.from("12345");
      await expect(writeStoredWorkspaceArchive(archivePath, [{ name: "manifest.json", data: manifest }], { maxManifestBytes: 4 }))
        .rejects.toMatchObject({ code: "BACKUP_SIZE_LIMIT" });
      await expect(writeStoredWorkspaceArchive(archivePath, [{ name: "manifest.json", data: manifest }], { maxArchiveBytes: 128 }))
        .rejects.toMatchObject({ code: "BACKUP_SIZE_LIMIT" });
      await expect(readFile(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects CRC mismatches and never returns partially extracted assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-archive-"));
    try {
      const archivePath = path.join(root, "corrupt.naistudio");
      await writeStoredWorkspaceArchive(archivePath, [{ name: "manifest.json", data: Buffer.from("original") }]);
      const archive = await readFile(archivePath);
      archive[archive.indexOf(Buffer.from("original"))] ^= 0xff;
      await writeFile(archivePath, archive);

      await expect(readStoredWorkspaceArchive(archivePath, path.join(root, "staging"))).rejects.toMatchObject({ code: "INVALID_BACKUP_ARCHIVE" });
      await expect(readdir(path.join(root, "staging"))).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
