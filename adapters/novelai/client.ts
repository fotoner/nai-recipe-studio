import { inflateRawSync } from "node:zlib";
import type { AccountStatus } from "../../contracts/studio";
import { StudioError } from "../../contracts/studio";
import type { Settings } from "../../lib/composer";
import { sanitizePrompt } from "../../lib/prompt-utils";

export const HOST = "https://image.novelai.net";
export const MODEL = "nai-diffusion-5-full";
const UC_PRESET_HINT: Record<string, number> = { none: 0, light: 1, heavy: 2, human_focus: 3 };
const timeout = 180_000;

export type CharacterPrompt = { prompt: string; uc: string; x: number; y: number };
export type NaiPayload = { input: string; model: string; action: "generate"; parameters: Record<string, unknown> };

export function buildParams(args: { prompt: string; negative: string; settings: Settings; seed: number; characters: CharacterPrompt[] }): Record<string, unknown> {
  const { prompt, negative, settings: s, seed, characters } = args;
  const charPrompts = characters.map(c => ({ prompt: c.prompt, uc: c.uc ?? "", center: { x: c.x, y: c.y }, enabled: true }));
  const charCaps = characters.map(c => ({ char_caption: c.prompt, centers: [{ x: c.x, y: c.y }] }));
  const negCaps = characters.map(c => ({ char_caption: c.uc ?? "", centers: [{ x: c.x, y: c.y }] }));
  return {
    params_version: 4, width: s.width, height: s.height, scale: s.scale, sampler: s.sampler, steps: s.steps, n_samples: 1,
    ucPresetId: s.uc_preset, qualityPresetId: s.quality_preset, autoSmea: false, dynamic_thresholding: false,
    controlnet_strength: 1, legacy: false, add_original_image: true, cfg_rescale: s.rescale, legacy_v3_extend: false,
    use_coords: true, legacy_uc: false, normalize_reference_strength_multiple: true, inpaintImg2ImgStrength: 1,
    seed, characterPrompts: charPrompts, straight_alpha: true, tag_hint_qt: s.quality_preset === "standard" ? 1 : 0,
    tag_hint_uc_preset: UC_PRESET_HINT[s.uc_preset] ?? 2,
    v4_prompt: { caption: { base_caption: prompt, char_captions: charCaps }, use_coords: true, use_order: true },
    v4_negative_prompt: { caption: { base_caption: negative, char_captions: negCaps }, legacy_uc: false },
    negative_prompt: negative, deliberate_euler_ancestral_bug: false, prefer_brownian: true, noise_schedule: s.schedule, image_format: "png",
  };
}

function multipart(payload: NaiPayload) {
  const boundary = `----nairecipestudio${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"; filename="blob"\r\nContent-Type: application/json\r\n\r\n`);
  const body = Buffer.from(JSON.stringify(payload));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, body, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function extractPng(body: Buffer, contentType = ""): Buffer {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (body.subarray(0, 8).equals(pngMagic)) return validatePng(body);
  if (body.subarray(0, 4).toString("latin1") !== "PK\x03\x04" && !contentType.includes("zip")) throw new Error("The NovelAI response was not a PNG or ZIP archive.");
  let eocd = -1;
  for (let i = body.length - 22; i >= 0; i--) if (body.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("The NovelAI response ZIP was incomplete.");
  const count = body.readUInt16LE(eocd + 10);
  if (count > 256) throw new Error("Too many response ZIP entries.");
  let cursor = body.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > body.length) throw new Error("Truncated ZIP directory.");
    if (body.readUInt32LE(cursor) !== 0x02014b50) throw new Error("The NovelAI response ZIP was invalid.");
    const method = body.readUInt16LE(cursor + 10);
    const uncompressedSize = body.readUInt32LE(cursor + 24);
    const size = body.readUInt32LE(cursor + 20);
    const nameLength = body.readUInt16LE(cursor + 28);
    const extraLength = body.readUInt16LE(cursor + 30);
    const commentLength = body.readUInt16LE(cursor + 32);
    const local = body.readUInt32LE(cursor + 42);
    const name = body.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (local + 30 > body.length || body.readUInt32LE(local) !== 0x04034b50) throw new Error("Invalid ZIP local entry.");
    const localName = body.readUInt16LE(local + 26);
    const localExtra = body.readUInt16LE(local + 28);
    const data = body.subarray(local + 30 + localName + localExtra, local + 30 + localName + localExtra + size);
    if (data.length !== size || uncompressedSize > MAX_IMAGE_BYTES) throw new Error("Invalid ZIP image size.");
    if (name.toLowerCase().endsWith(".png")) {
      if (body.readUInt16LE(cursor + 8) & 1) throw new Error("Encrypted images are unsupported.");
      if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression.");
      const decoded = method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_IMAGE_BYTES }) : Buffer.from(data);
      if (!decoded.subarray(0, 8).equals(pngMagic)) throw new Error("ZIP entry is not a PNG.");
      return validatePng(decoded);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("The NovelAI response ZIP contained no image.");
}

function validatePng(bytes: Buffer): Buffer {
  if (bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(8) !== 13) throw new Error("Invalid PNG header.");
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated PNG chunk.");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || !hasImageData) throw new Error("Invalid PNG end chunk.");
      return bytes.subarray(0, end);
    }
    offset = end;
  }
  throw new Error("Incomplete PNG image.");
}

function hasNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function failure(code: string, retryable = false): StudioError { return new StudioError({ code, messageKey: `errors.${code}`, retryable }); }

export async function fetchAccount(token: string, fetchImpl: typeof fetch = fetch): Promise<AccountStatus> {
  try {
    const response = await fetchImpl(`${HOST}/user/subscription`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? "NOT_CONNECTED" : "ACCOUNT_UNAVAILABLE", true);
    const body = object(await response.json());
    const usage = object(body.usage);
    const training = object(body.trainingStepsLeft);
    const checkedAt = new Date().toISOString();
    if (!hasNumber(training.fixedTrainingStepsLeft) || !hasNumber(training.purchasedTrainingSteps) || typeof body.active !== "boolean") {
      return { tier: "unknown", anlas: null, usagePercent: null, checkedAt };
    }
    // The official subscription schema uses a numeric tier. Descriptive strings
    // elsewhere in the response must never grant a subscription capability.
    const tier = body.tier === 3 ? "opus" : body.tier === 0 || body.tier === 1 || body.tier === 2 ? "other" : "unknown";
    return {
      tier, active: body.active, anlas: training.fixedTrainingStepsLeft + training.purchasedTrainingSteps,
      usagePercent: hasNumber(usage.percent) ? usage.percent : null,
      usageAvailable: usage.isNegative === false && hasNumber(usage.percent) && usage.percent > 0,
      checkedAt,
    };
  } catch (cause) {
    if (cause instanceof StudioError) throw cause;
    throw failure("ACCOUNT_UNAVAILABLE", true);
  }
}

export async function generateImage(input: { token: string; prompt: string; negative: string; settings: Settings; seed: number; characters: CharacterPrompt[]; fetchImpl?: typeof fetch }): Promise<{ png: Buffer; payload: NaiPayload }> {
  const payload: NaiPayload = { input: sanitizePrompt(input.prompt), model: MODEL, action: "generate", parameters: buildParams({ prompt: sanitizePrompt(input.prompt), negative: sanitizePrompt(input.negative), settings: input.settings, seed: input.seed, characters: input.characters.map(character => ({ ...character, prompt: sanitizePrompt(character.prompt), uc: sanitizePrompt(character.uc) })) }) };
  const { body, contentType } = multipart(payload);
  try {
    const response = await (input.fetchImpl ?? fetch)(`${HOST}/ai/generate-image`, { method: "POST", headers: { Authorization: `Bearer ${input.token}`, "Content-Type": contentType, "User-Agent": "nai-recipe-studio/0.1" }, body: body as unknown as BodyInit, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw failure("NOT_CONNECTED");
      if (response.status === 429) throw failure("RATE_LIMITED");
      throw failure(response.status >= 500 ? "RESULT_UNKNOWN" : "GENERATION_REJECTED");
    }
    const bytes = await readBoundedImage(response);
    return { png: extractPng(bytes, response.headers.get("content-type") ?? ""), payload };
  } catch (cause) {
    if (cause instanceof StudioError) throw cause;
    // A request may have been accepted even when its response cannot be read.
    // Never retry or expose raw provider/network messages (they may contain data).
    throw failure("RESULT_UNKNOWN");
  }
}

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
async function readBoundedImage(response: Response): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES || !response.body) {
    await response.body?.cancel();
    throw failure("RESULT_UNKNOWN");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw failure("RESULT_UNKNOWN"); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}
