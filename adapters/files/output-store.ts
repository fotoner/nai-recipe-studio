import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const safeRelative = (value: string) => {
  // Normalize both separators so a payload made on another OS cannot bypass
  // the traversal check when it is opened on this one.
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:(?:$|\/)/.test(portable)) throw new Error("The requested output path is outside the output directory.");
  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) throw new Error("The requested output path is outside the output directory.");
  return normalized;
};

async function assertInside(root: string, target: string) {
  const rootReal = await realpath(root);
  const targetReal = await realpath(target);
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  if (targetReal !== rootReal && !targetReal.startsWith(prefix)) throw new Error("The requested output path is outside the output directory.");
}

async function assertNoSymlink(target: string) {
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("The requested output path is outside the output directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class OutputStore {
  constructor(readonly root: string) {}

  async write(relative: string, bytes: Uint8Array, metadata?: unknown) {
    const safe = safeRelative(relative);
    const target = path.join(this.root, safe);
    await mkdir(path.dirname(target), { recursive: true });
    await assertInside(this.root, path.dirname(target));
    await assertNoSymlink(target);
    await writeFile(target, bytes);
    if (metadata !== undefined) {
      const sidecar = target.replace(/\.png$/i, ".json");
      await assertNoSymlink(sidecar);
      await writeFile(sidecar, JSON.stringify(metadata, null, 2), "utf8");
    }
    return safe;
  }

  async read(relative: string) {
    const target = path.join(this.root, safeRelative(relative));
    await assertInside(this.root, target);
    return readFile(target);
  }

  async remove(relative: string) {
    const safe = safeRelative(relative);
    const files = [path.join(this.root, safe), path.join(this.root, safe.replace(/\.png$/i, ".json"))];
    const present: string[] = [];
    for (const file of files) {
      try {
        await assertInside(this.root, file);
        const stat = await lstat(file);
        if (!stat.isFile()) throw new Error("The requested output is not a regular file.");
        present.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // A missing image is not a successful deletion: retain its DB row so the
    // gallery still points to a recoverable record instead of silently losing it.
    if (!present.includes(files[0])) return false;

    // Rename all parts first. If validation or a rename fails, the original
    // names and DB metadata remain intact. The short tombstone names are in the
    // same directory, so each rename is atomic on the target filesystem.
    const staged: Array<{ original: string; tombstone: string }> = [];
    try {
      for (const file of present) {
        const tombstone = path.join(path.dirname(file), `.nai-delete-${randomUUID()}-${path.basename(file)}`);
        await rename(file, tombstone);
        staged.push({ original: file, tombstone });
      }
      for (const item of staged) await unlink(item.tombstone);
      return true;
    } catch (error) {
      for (const item of [...staged].reverse()) {
        try { await rename(item.tombstone, item.original); } catch { /* preserve the original failure */ }
      }
      throw error;
    }
  }
}

export { safeRelative };
