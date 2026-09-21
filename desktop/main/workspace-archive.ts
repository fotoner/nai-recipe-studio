import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const UTF8_FLAG = 0x0800;
const ZIP32_MAX = 0xffffffff;
const DEFAULT_LIMITS = {
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 20_000,
  maxManifestBytes: 64 * 1024 * 1024,
};

export type WorkspaceArchiveErrorCode = "INVALID_BACKUP_ARCHIVE" | "BACKUP_SIZE_LIMIT";
export class WorkspaceArchiveError extends Error {
  constructor(readonly code: WorkspaceArchiveErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceArchiveError";
  }
}

export type WorkspaceArchiveEntry = { name: string; path: string };
export type WorkspaceArchiveReadResult = {
  root: string;
  entries: WorkspaceArchiveEntry[];
  cleanup(): Promise<void>;
};
export type WorkspaceArchiveReadLimits = Partial<typeof DEFAULT_LIMITS>;
export type WorkspaceArchiveWriteLimits = Partial<typeof DEFAULT_LIMITS>;
export type WorkspaceArchiveWriteEntry = { name: string; data: Uint8Array | (() => Promise<Uint8Array>) };

type CentralEntry = {
  name: string;
  nameBytes: Buffer;
  crc: number;
  size: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function invalid(message = "The selected file is not a supported workspace backup."): never {
  throw new WorkspaceArchiveError("INVALID_BACKUP_ARCHIVE", message);
}

function sizeLimit(message = "The workspace backup exceeds the supported size limit."): never {
  throw new WorkspaceArchiveError("BACKUP_SIZE_LIMIT", message);
}

function assertMemberName(name: string) {
  if (!name || Buffer.byteLength(name, "utf8") > 1024 || name.startsWith("/") || name.includes("\\") || name.includes(":") || [...name].some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f;
  })) invalid("The workspace backup contains an unsafe archive path.");
  const parts = name.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) invalid("The workspace backup contains an unsafe archive path.");
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) invalid("The workspace backup contains an unsupported archive path.");
}

function crcUpdate(state: number, bytes: Uint8Array) {
  let value = state;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  return value;
}

function crc32(bytes: Uint8Array) {
  return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

function createLocalHeader(nameBytes: Buffer, data: Uint8Array) {
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(ZIP_LOCAL, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8); // PNGs are already compressed; only the stored method is supported.
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12); // 1980-01-01, the ZIP epoch.
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.byteLength, 18);
  header.writeUInt32LE(data.byteLength, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  nameBytes.copy(header, 30);
  return header;
}

function createCentralHeader(nameBytes: Buffer, data: Uint8Array, localOffset: number) {
  const header = Buffer.alloc(46 + nameBytes.length);
  header.writeUInt32LE(ZIP_CENTRAL, 0);
  header.writeUInt16LE(20, 4); // DOS/Windows creator version.
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.byteLength, 20);
  header.writeUInt32LE(data.byteLength, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  nameBytes.copy(header, 46);
  return header;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (!result.bytesWritten) throw new Error("Could not write the workspace backup archive.");
    offset += result.bytesWritten;
  }
}

/** Writes an uncompressed ZIP32 archive. PNGs are already compressed, and refusing compressed input keeps import limits exact. */
export async function writeStoredWorkspaceArchive(targetPath: string, entries: readonly WorkspaceArchiveWriteEntry[], options: WorkspaceArchiveWriteLimits = {}) {
  const limits = effectiveLimits(options);
  if (!entries.length || entries.length > limits.maxEntries) sizeLimit("The workspace backup has an unsupported number of files.");
  const names = new Set<string>();
  for (const entry of entries) {
    assertMemberName(entry.name);
    if (names.has(entry.name)) invalid("The workspace backup contains duplicate archive paths.");
    names.add(entry.name);
  }

  const absoluteTarget = path.resolve(targetPath);
  const parent = path.dirname(absoluteTarget);
  const temporaryPath = path.join(parent, `.${path.basename(absoluteTarget)}.tmp-${randomUUID()}`);
  const central: Buffer[] = [];
  let file: FileHandle | undefined;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    let offset = 0;
    let expandedBytes = 0;
    for (const entry of entries) {
      const sourceData = typeof entry.data === "function" ? await entry.data() : entry.data;
      if (!(sourceData instanceof Uint8Array)) invalid("A workspace backup entry was not binary data.");
      const entryLimit = entry.name === "manifest.json" ? limits.maxManifestBytes : limits.maxEntryBytes;
      if (sourceData.byteLength > entryLimit) sizeLimit();
      expandedBytes += sourceData.byteLength;
      if (expandedBytes > limits.maxExpandedBytes) sizeLimit();
      const data = Buffer.from(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength);
      const nameBytes = Buffer.from(entry.name, "utf8");
      if (offset + 30 + nameBytes.length + data.byteLength > ZIP32_MAX) sizeLimit();
      if (offset + 30 + nameBytes.length + data.byteLength > limits.maxArchiveBytes) sizeLimit();
      const local = createLocalHeader(nameBytes, data);
      await writeAll(file, local, offset);
      offset += local.length;
      await writeAll(file, data, offset);
      central.push(createCentralHeader(nameBytes, data, offset - local.length));
      offset += data.length;
    }
    const directoryOffset = offset;
    const directorySize = central.reduce((sum, header) => sum + header.length, 0);
    if (directoryOffset + directorySize + 22 > ZIP32_MAX || directoryOffset + directorySize + 22 > limits.maxArchiveBytes) sizeLimit();
    for (const header of central) { await writeAll(file, header, offset); offset += header.length; }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(ZIP_END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryOffset, 16);
    end.writeUInt16LE(0, 20);
    await writeAll(file, end, offset);
    offset += end.length;
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, absoluteTarget);
    return { archiveBytes: offset };
  } catch (cause) {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
}

function effectiveLimits(options: WorkspaceArchiveReadLimits) {
  return { ...DEFAULT_LIMITS, ...options };
}

async function readExactly(handle: FileHandle, length: number, position: number) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) invalid();
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) invalid("The workspace backup archive is truncated.");
    offset += result.bytesRead;
  }
  return buffer;
}

function findEndRecord(tail: Buffer, tailOffset: number, fileSize: number) {
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== ZIP_END) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== tail.length) continue;
    if (tailOffset + offset + 22 + commentLength !== fileSize) continue;
    return { offset: tailOffset + offset, header: tail.subarray(offset, offset + 22) };
  }
  return invalid("The workspace backup is missing a valid ZIP directory.");
}

async function parseDirectory(handle: FileHandle, fileSize: number, limits: ReturnType<typeof effectiveLimits>) {
  const tailLength = Math.min(fileSize, 22 + 0xffff);
  const tailOffset = fileSize - tailLength;
  const tail = await readExactly(handle, tailLength, tailOffset);
  const end = findEndRecord(tail, tailOffset, fileSize);
  const disk = end.header.readUInt16LE(4);
  const directoryDisk = end.header.readUInt16LE(6);
  const diskEntries = end.header.readUInt16LE(8);
  const entryCount = end.header.readUInt16LE(10);
  const directorySize = end.header.readUInt32LE(12);
  const directoryOffset = end.header.readUInt32LE(16);
  if (disk || directoryDisk || diskEntries !== entryCount || entryCount === 0xffff || directorySize === ZIP32_MAX || directoryOffset === ZIP32_MAX) invalid("Multi-part or ZIP64 backups are not supported.");
  if (!entryCount || entryCount > limits.maxEntries) sizeLimit("The workspace backup has an unsupported number of files.");
  if (directoryOffset + directorySize !== end.offset || directorySize > 64 * 1024 * 1024) invalid("The workspace backup ZIP directory is inconsistent.");

  const directory = await readExactly(handle, directorySize, directoryOffset);
  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let cursor = 0;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== ZIP_CENTRAL) invalid("The workspace backup ZIP directory is malformed.");
    const madeBy = directory.readUInt16LE(cursor + 4);
    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const crc = directory.readUInt32LE(cursor + 16);
    const compressedSize = directory.readUInt32LE(cursor + 20);
    const size = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const diskStart = directory.readUInt16LE(cursor + 34);
    const externalAttributes = directory.readUInt32LE(cursor + 38);
    const localOffset = directory.readUInt32LE(cursor + 42);
    const endOffset = cursor + 46 + nameLength + extraLength + commentLength;
    if (endOffset > directory.length) invalid("The workspace backup ZIP directory is truncated.");
    if (flags !== 0 && flags !== UTF8_FLAG || method !== 0 || compressedSize !== size || size === ZIP32_MAX || compressedSize === ZIP32_MAX || localOffset === ZIP32_MAX || extraLength !== 0 || commentLength !== 0 || diskStart !== 0) invalid("The workspace backup uses unsupported ZIP features.");
    // ZIP-created symlinks and directory entries are never needed by this format.
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0xf000;
    if (fileType && fileType !== 0x8000 || externalAttributes & 0x10) invalid("The workspace backup contains a non-file entry.");
    if (size > limits.maxEntryBytes) sizeLimit();
    totalSize += size;
    if (totalSize > limits.maxExpandedBytes) sizeLimit();
    const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameLength);
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); } catch { return invalid("The workspace backup contains an invalid file name."); }
    assertMemberName(name);
    if (names.has(name)) invalid("The workspace backup contains duplicate archive paths.");
    names.add(name);
    if ((name === "manifest.json" && size > limits.maxManifestBytes) || (name !== "manifest.json" && name.startsWith("assets/") && size > limits.maxEntryBytes)) sizeLimit();
    entries.push({ name, nameBytes: Buffer.from(nameBytes), crc, size, localOffset, dataOffset: 0, dataEnd: 0 });
    cursor = endOffset;
    void madeBy;
  }
  if (cursor !== directory.length) invalid("The workspace backup ZIP directory has trailing data.");

  for (const entry of entries) {
    if (entry.localOffset + 30 > directoryOffset) invalid("The workspace backup has an invalid local file offset.");
    const header = await readExactly(handle, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== ZIP_LOCAL) invalid("The workspace backup local file header is malformed.");
    const flags = header.readUInt16LE(6);
    const method = header.readUInt16LE(8);
    const crc = header.readUInt32LE(14);
    const compressedSize = header.readUInt32LE(18);
    const size = header.readUInt32LE(22);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    if (flags !== 0 && flags !== UTF8_FLAG || method !== 0 || crc !== entry.crc || compressedSize !== entry.size || size !== entry.size || extraLength !== 0 || nameLength !== entry.nameBytes.length) invalid("The workspace backup local and central ZIP headers disagree.");
    const nameBytes = await readExactly(handle, nameLength, entry.localOffset + 30);
    if (!nameBytes.equals(entry.nameBytes)) invalid("The workspace backup local and central file names disagree.");
    entry.dataOffset = entry.localOffset + 30 + nameLength;
    entry.dataEnd = entry.dataOffset + entry.size;
    if (entry.dataEnd > directoryOffset) invalid("The workspace backup file data overlaps its ZIP directory.");
  }
  const ranges = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  let nextOffset = 0;
  for (const entry of ranges) {
    if (entry.localOffset !== nextOffset) invalid("The workspace backup contains overlapping or unreferenced ZIP data.");
    nextOffset = entry.dataEnd;
  }
  if (nextOffset !== directoryOffset) invalid("The workspace backup contains unreferenced ZIP data.");
  return entries;
}

async function copyAndCheck(handle: FileHandle, entry: CentralEntry, targetPath: string) {
  const destination = await open(targetPath, "wx", 0o600);
  let state = 0xffffffff;
  try {
    let offset = 0;
    const chunkSize = 1024 * 1024;
    while (offset < entry.size) {
      const length = Math.min(chunkSize, entry.size - offset);
      const chunk = await readExactly(handle, length, entry.dataOffset + offset);
      state = crcUpdate(state, chunk);
      await writeAll(destination, chunk, offset);
      offset += length;
    }
    await destination.sync();
  } finally {
    await destination.close();
  }
  if (((state ^ 0xffffffff) >>> 0) !== entry.crc) invalid("A workspace backup file failed its integrity check.");
}

/** Validates ZIP32 structure before extracting into a fresh private directory. */
export async function readStoredWorkspaceArchive(archivePath: string, stagingRoot: string, options: WorkspaceArchiveReadLimits = {}): Promise<WorkspaceArchiveReadResult> {
  const limits = effectiveLimits(options);
  let archive: FileHandle | undefined;
  let stageRoot: string | undefined;
  try {
    archive = await open(archivePath, "r");
    const stat = await archive.stat();
    if (!stat.isFile()) invalid();
    if (stat.size > limits.maxArchiveBytes) sizeLimit();
    const entries = await parseDirectory(archive, stat.size, limits);
    const rootCandidate = path.resolve(stagingRoot);
    await mkdir(rootCandidate, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(rootCandidate);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) invalid("The workspace backup staging directory is not safe.");
    const stagingRealPath = await realpath(rootCandidate);
    stageRoot = await mkdtemp(path.join(stagingRealPath, "workspace-restore-"));
    const extracted: WorkspaceArchiveEntry[] = [];
    for (const entry of entries) {
      const outputPath = path.join(stageRoot, ...entry.name.split("/"));
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      await copyAndCheck(archive, entry, outputPath);
      extracted.push({ name: entry.name, path: outputPath });
    }
    await archive.close();
    archive = undefined;
    const safeRoot = stageRoot;
    return { root: safeRoot, entries: extracted, cleanup: () => rm(safeRoot, { recursive: true, force: true }) };
  } catch (cause) {
    await archive?.close().catch(() => undefined);
    if (stageRoot) await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof WorkspaceArchiveError) throw cause;
    throw cause;
  }
}
