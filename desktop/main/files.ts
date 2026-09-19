import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlatformError } from "./errors";
import { stripPngMetadata, withGenerationMetadata } from "./png";

export type RecipeFileParser<T> = (value: unknown) => T;

function fileError(message: string, cause?: unknown) {
  return new PlatformError("VALIDATION_FAILED", message, { cause });
}

export async function importRecipeJson<T>(filePath: string, parse: RecipeFileParser<T>) {
  if (path.extname(filePath).toLowerCase() !== ".json") throw fileError("Choose a recipe JSON file.");
  let raw: string;
  try { raw = await readFile(filePath, "utf8"); } catch (cause) { throw fileError("The recipe file could not be read.", cause); }
  try { return parse(JSON.parse(raw)); } catch (cause) { throw fileError("The recipe JSON is invalid or uses an unsupported schema.", cause); }
}

export async function exportRecipeJson(filePath: string, recipe: unknown) {
  if (path.extname(filePath).toLowerCase() !== ".json") throw fileError("Choose a .json destination for the recipe.");
  const serialized = JSON.stringify(recipe, null, 2) + "\n";
  await atomicWrite(filePath, Buffer.from(serialized, "utf8"));
  return filePath;
}

export async function exportPng(filePath: string, png: Uint8Array, metadata?: unknown) {
  if (path.extname(filePath).toLowerCase() !== ".png") throw fileError("Choose a .png destination for the image.");
  await atomicWrite(filePath, metadata === undefined ? stripPngMetadata(png) : withGenerationMetadata(png, metadata));
  return filePath;
}

async function atomicWrite(filePath: string, content: Uint8Array) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, filePath);
  } catch (cause) {
    throw fileError("The export could not be written.", cause);
  }
}
