import type { Block, BlockPreset, BlockType } from "../../lib/schema";

const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();

/** Stable equality for a palette block. Preset links and coordinates are metadata. */
export function blockKey(block: Block): string {
  if ("artists" in block) return JSON.stringify(["style", block.artists.map(a => [a.name.trim(), a.weight]), block.year, unique(block.quality), unique(block.minus)]);
  if ("members" in block) return JSON.stringify(["cast", block.members.map(m => [m.character_id, unique(m.outfit), unique(m.expression), unique(m.traits)]), block.layout_preset]);
  if ("extra" in block) return JSON.stringify(["negative", block.base_preset, unique(block.extra)]);
  if ("width" in block) return JSON.stringify(["settings", block.width, block.height, block.steps, block.scale, block.rescale, block.sampler, block.schedule, block.quality_preset, block.uc_preset]);
  if ("explicit_tags" in block) return JSON.stringify(["nsfw", unique(block.explicit_tags)]);
  if ("entries" in block) return JSON.stringify(["text", block.entries.map(entry => [entry.kind, entry.text.trim()])]);
  return JSON.stringify([block.type, unique(block.tags), block.text.trim()]);
}

export function stripPresetRef<T extends Block>(block: T): T {
  const { preset_id: _presetId, ...rest } = block as T & { preset_id?: number };
  void _presetId;
  return rest as T;
}

type PublicSeed = Omit<BlockPreset, "id" | "created_at" | "updated_at"> & { builtinId: string };
const tag = (builtinId: string, type: Exclude<BlockType, "style" | "cast" | "text" | "negative" | "settings" | "nsfw">, name: string, tags: string[]): PublicSeed => ({ builtinId, type, name, block: { type, tags, text: "" } as Block, tags: [], notes: "" });

/** Small, generic allowlist. It contains no private recipe/style history. */
export const PUBLIC_PALETTE: readonly PublicSeed[] = [
  { builtinId: "text-speech", type: "text", name: "Speech", block: { type: "text", entries: [{ kind: "speech", text: "Hello!" }] }, tags: ["text"], notes: "Editable text starter." },
  tag("composition-upper-body", "composition", "Upper body", ["upper body", "looking at viewer"]),
  tag("composition-full-body", "composition", "Full body", ["full body"]),
  tag("expression-smile", "expression_pose", "Smile", ["smile"]),
  tag("outfit-casual", "outfit", "Casual clothes", ["casual clothes"]),
  tag("scene-simple", "scene", "Simple background", ["simple background"]),
  tag("lighting-soft", "lighting", "Soft lighting", ["soft lighting"]),
  tag("motif-magic", "motif", "Magic", ["magic circle"]),
  { builtinId: "negative-default", type: "negative", name: "Default negative", block: { type: "negative", base_preset: "heavy", rating: 0, extra: ["official art", "official style"] }, tags: ["default"], notes: "General negative prompt starter." },
  { builtinId: "settings-default", type: "settings", name: "Default settings", block: { type: "settings", width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random", quality_preset: "none", uc_preset: "heavy" }, tags: ["default"], notes: "Neutral V5 settings." },
];

export const publicPaletteTypes = new Set(PUBLIC_PALETTE.map(item => item.type));
