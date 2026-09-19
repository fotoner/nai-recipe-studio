/**
 * Recipe Studio data model. Single source of truth for blocks, recipes, cast, generations.
 * Rules that matter for the public recipe format:
 *  - base prompt order: count tag → (solo) character tag → scene/composition/outfit/expression/lighting/motif → style artists → year/quality → minus
 *  - multi-character: base has only the count tag + scene + style; each member goes to characterPrompts with x,y in 0..1
 *  - NSFW rating >= 1 cannot combine with canonical or registered minors (policy.ts, lint L14, not auto-fixable)
 */
import { z } from "zod";
import { migrateLegacyBlocks } from "./rating-migrate";
import { renderText, TEXT_RENDER_LIMIT } from "./text-effects";

export const AgeFlag = z.enum(["adult", "minor", "unknown"]);
export type AgeFlag = z.infer<typeof AgeFlag>;

export const Character = z.object({
  id: z.number().int().optional(),
  tag: z.string().min(1), // NovelAI-compatible character tag
  series: z.string().default(""), // Optional source series for a canonical tag
  display_name: z.string().default(""),
  gender: z.enum(["girl", "boy", "other"]).default("girl"),
  age_flag: AgeFlag.default("unknown"),
  locked: z.boolean().default(false), // canonical minor: generation restrictions persist across age edits
  fixed_traits: z.array(z.string()).default([]), // hair/eyes/etc for OCs (NOT sent for canon characters, lint L03)
  default_x: z.number().min(0).max(1).default(0.5),
  default_y: z.number().min(0).max(1).default(0.5),
  notes: z.string().default(""),
});
export type Character = z.infer<typeof Character>;

export const Artist = z.object({ name: z.string().min(1), weight: z.number().min(0).max(3).default(1) });
export type Artist = z.infer<typeof Artist>;

export const BlockType = z.enum([
  "style", "cast", "scene", "composition", "outfit", "expression_pose", "lighting", "motif", "text", "negative", "settings", "nsfw",
]);
export type BlockType = z.infer<typeof BlockType>;

/** Optional link back to the block_presets row a block was taken from (usage tracking, "prompt from preset" badges). */
export const PresetRef = { preset_id: z.number().int().optional() };

export const StyleBlock = z.object({
  type: z.literal("style"),
  ...PresetRef,
  artists: z.array(Artist).default([]),
  // The distributed app starts neutral. Style recommendations are kept outside
  // this schema's defaults.
  year: z.string().default(""),
  quality: z.array(z.string()).default([]),
  minus: z.array(z.string()).default([]),
});

export const CastMember = z.object({
  character_id: z.number().int(),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
  traits: z.array(z.string()).default([]),
  outfit: z.array(z.string()).default([]),
  expression: z.array(z.string()).default([]),
  uc: z.array(z.string()).default([]),
  interactions: z.array(z.string()).default([]), // e.g. "source#hug", "target#hug", "mutual#hug"
});
export type CastMember = z.infer<typeof CastMember>;

export const CastBlock = z.object({
  type: z.literal("cast"),
  ...PresetRef,
  members: z.array(CastMember).min(1).max(22),
  layout_preset: z.enum(["solo", "side_by_side", "front_back", "over_shoulder_pair", "circle", "custom"]).default("solo"),
  auto_leak_guard: z.boolean().default(true), // add other members' hair/eye colours to each member's uc
});

export const TagListBlock = <T extends BlockType>(t: T) => z.object({ type: z.literal(t), ...PresetRef, tags: z.array(z.string()).default([]), text: z.string().default("") });
export const SceneBlock = TagListBlock("scene");
export const CompositionBlock = TagListBlock("composition");
export const OutfitBlock = TagListBlock("outfit");
export const ExpressionBlock = TagListBlock("expression_pose");
export const LightingBlock = TagListBlock("lighting");
export const MotifBlock = TagListBlock("motif");

export const TextEntry = z.object({
  kind: z.enum(["speech", "sound", "motion"]),
  text: z.string().default(""),
});
export type TextEntry = z.infer<typeof TextEntry>;
export const TextBlock = z.object({
  type: z.literal("text"),
  ...PresetRef,
  entries: z.array(TextEntry).default([]),
}).refine(block => renderText(block.entries).length <= TEXT_RENDER_LIMIT, {
  message: "말풍선·효과음 문구는 줄바꿈을 포함해 750자 이내로 줄여 주세요.", path: ["entries"],
});
export type TextBlock = z.infer<typeof TextBlock>;

export const NegativeBlock = z.object({
  type: z.literal("negative"),
  ...PresetRef,
  base_preset: z.enum(["heavy", "light", "none"]).default("heavy"),
  /** 0 all-ages, 1 sensitive, 2 explicit. Rating >= 1 drops the SFW guards and needs an all-adult cast (policy.ts). */
  rating: z.number().int().min(0).max(2).optional(), // absent = 0
  extra: z.array(z.string()).default(["official art", "official style"]),
});

export const SettingsBlock = z.object({
  type: z.literal("settings"),
  ...PresetRef,
  width: z.number().int().default(832),
  height: z.number().int().default(1216),
  steps: z.number().int().min(1).max(50).default(28),
  scale: z.number().min(0).max(10).default(5.0),
  rescale: z.number().min(0).max(1).default(0.3),
  sampler: z.string().default("k_euler_ancestral"),
  schedule: z.string().default("karras"),
  seed_policy: z.enum(["random", "fixed"]).default("random"),
  seed: z.number().int().optional(),
  quality_preset: z.enum(["none", "standard"]).default("none"),
  uc_preset: z.enum(["heavy", "light", "none", "human_focus"]).default("heavy"),
});

export const NsfwBlock = z.object({
  type: z.literal("nsfw"),
  ...PresetRef,
  /** explicit content (acts etc.). Enters the prompt only at rating >= 1; the rating itself lives in the negative block. */
  explicit_tags: z.array(z.string()).default([]),
});

export const Block = z.discriminatedUnion("type", [
  StyleBlock, CastBlock, SceneBlock, CompositionBlock, OutfitBlock, ExpressionBlock, LightingBlock, MotifBlock, TextBlock, NegativeBlock, SettingsBlock, NsfwBlock,
]);
export type Block = z.infer<typeof Block>;

/** A reusable block kept in the palette (block_presets). `block.type` must equal `type`. */
export const BlockPreset = z.object({
  id: z.number().int().optional(),
  type: BlockType,
  name: z.string().min(1),
  block: Block,
  tags: z.array(z.string()).default([]),
  notes: z.string().default(""),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type BlockPreset = z.infer<typeof BlockPreset>;

export const Recipe = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  rating: z.number().int().min(0).max(2).default(0),
  blocks: z.preprocess(migrateLegacyBlocks, z.array(Block)), // ordered; legacy nsfw{rating,required_negatives} is folded into the negative block
  source: z.string().default("manual"),
  notes: z.string().default(""),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type Recipe = z.infer<typeof Recipe>;

/** Output of composer.compose(): what actually goes to the NAI API. */
export type Composed = {
  base_prompt: string;
  negative: string;
  characters: { prompt: string; uc: string; x: number; y: number }[];
  settings: z.infer<typeof SettingsBlock>;
  rating: number;
};

export type LintSeverity = "error" | "warn" | "info";
export type LintFinding = {
  rule: string; // L01..L23
  severity: LintSeverity;
  message: string;
  block?: BlockType;
  fixable: boolean;
};

export const Generation = z.object({
  id: z.number().int().optional(),
  recipe_id: z.number().int().nullable(),
  recipe_snapshot: z.string(), // JSON of Recipe at generation time
  base_prompt: z.string(),
  negative: z.string(),
  characters_json: z.string(),
  seed: z.number().int(),
  settings_json: z.string(),
  rating: z.number().int(),
  file: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  anlas_cost: z.number().int().default(0),
  created_at: z.string().optional(),
});
export type Generation = z.infer<typeof Generation>;

export const CANONICAL_ORDER: BlockType[] = [
  "cast", "scene", "composition", "outfit", "expression_pose", "lighting", "motif", "text", "style", "nsfw", "negative", "settings",
];

/** Tags that can never be combined with rating >= 1 regardless of any user setting. */
export const MINOR_CODED_TAGS = ["loli", "shota", "child", "toddler", "toddlercon", "kindergarten", "baby", "infant", "aged down"];
