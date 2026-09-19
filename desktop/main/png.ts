import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlatformError } from "./errors";
import { assertPathInside } from "./paths";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

/** Remove textual/XMP/EXIF chunks that may contain prompts or local metadata. */
export function stripPngMetadata(input: Uint8Array): Buffer {
  const source = Buffer.from(input);
  if (source.length < PNG_SIGNATURE.length || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PlatformError("VALIDATION_FAILED", "The selected file is not a PNG image.");
  }
  const output: Buffer[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let sawEnd = false;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > source.length) throw new PlatformError("VALIDATION_FAILED", "The PNG file is truncated.");
    const type = source.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") sawEnd = true;
    if (!TEXT_CHUNKS.has(type)) output.push(source.subarray(offset, end));
    offset = end;
    if (sawEnd) break;
  }
  if (!sawEnd) throw new PlatformError("VALIDATION_FAILED", "The PNG file has no IEND chunk.");
  return Buffer.concat(output);
}

/** Embed only the caller-selected generation data as a UTF-8 PNG text chunk. */
export function withGenerationMetadata(input: Uint8Array, metadata: unknown): Buffer {
  const clean = stripPngMetadata(input);
  const type = Buffer.from("iTXt", "ascii");
  const data = Buffer.from(`NAI Recipe Studio\0\0\0\0\0${JSON.stringify(metadata)}`, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  // stripPngMetadata guarantees that the last 12 bytes form the IEND chunk.
  return Buffer.concat([clean.subarray(0, -12), length, crcInput, checksum, clean.subarray(-12)]);
}

export async function readSanitizedPng(filePath: string) {
  return stripPngMetadata(await readFile(filePath));
}

/** Write a sanitized image only below the app-managed output root. */
export async function writeSanitizedPng(outputRoot: string, destination: string, input: Uint8Array) {
  const target = assertPathInside(outputRoot, destination);
  const clean = stripPngMetadata(input);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, clean, { mode: 0o600 });
  await rename(temporary, target);
  return target;
}
