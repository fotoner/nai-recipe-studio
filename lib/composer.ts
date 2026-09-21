import { resolveMemberCharacter } from "../core/recipe/characters";
/**
 * Blocks -> NovelAI V5 payload strings.
 *
 * Validated order for the public recipe format:
 *   count tag -> (solo) character tag [canon] or fixed traits [OC, no name tag] -> scene / composition / outfit / expression / lighting / motif
 *   -> nsfw explicit tags (rating >= 1 only) -> style artists -> year -> quality -> minus
 * Multi cast: the base prompt keeps only the count tag + scene/style; every member is sent as its own
 * characterPrompt (`girl`/`boy`, never `1girl`) with x,y coordinates and its own UC.
 * A trailing `Text: ...` render block is hoisted to the very end of the base prompt (V5 requirement).
 */
import type { Recipe, Character, Composed, CastMember, Block, BlockType } from "./schema";
import { SettingsBlock } from "./schema";
import { sanitizePrompt, joinTags, splitTags, artistTag, countTag, splitTextRender } from "./prompt-utils";
import { renderText, TEXT_EFFECTS } from "./text-effects";

export type Settings = ReturnType<typeof SettingsBlock.parse>;

/** NovelAI V5 Heavy undesired-content preset. */
export const UC_HEAVY =
  "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, " +
  "jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, " +
  "multiple views, logo, too many watermarks, negative space, blank page";
/** Exact V5 "Light" preset. */
export const UC_LIGHT =
  "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::";
/** Added to the negative for rating 0 recipes only. */
export const SFW_GUARDS = ["nsfw", "nude", "nipples", "cleavage"];
/** Technical negatives L15 adds when an NSFW recipe has none. */
export const NSFW_TECH_NEGATIVES = ["bad anatomy", "extra limbs", "mutated hands"];

export const TAG_BLOCKS: BlockType[] = ["scene", "composition", "outfit", "expression_pose", "lighting", "motif"];
/** Wardrobe/expression belong to each characterPrompt once the cast has 2+ members (spec 3). */
export const MEMBER_BLOCKS: BlockType[] = ["outfit", "expression_pose"];
const BASE_BLOCKS_MULTI: BlockType[] = TAG_BLOCKS.filter(t => !MEMBER_BLOCKS.includes(t));

type Of<T extends BlockType> = Extract<Block, { type: T }>;
type TagBlockValue = { tags: string[]; text: string };

export function findBlock<T extends BlockType>(recipe: Recipe, type: T): Of<T> | undefined {
  return recipe.blocks.find(b => b.type === type) as Of<T> | undefined;
}
export function findTagBlock(recipe: Recipe, type: BlockType): TagBlockValue | undefined {
  const b = recipe.blocks.find(x => x.type === type) as unknown as Partial<TagBlockValue> | undefined;
  return b ? { tags: b.tags ?? [], text: b.text ?? "" } : undefined;
}

/**
 * Fragments a tag block contributes. `text` is dropped when it is just the tags re-joined
 * (the worker writes both), otherwise it would be weighted twice.
 */
function blockFragments(recipe: Recipe, t: BlockType): string[] {
  const b = findTagBlock(recipe, t);
  if (!b) return [];
  const out = [...b.tags];
  if (b.text && joinTags(splitTags(b.text)) !== joinTags(b.tags)) out.push(b.text);
  return out;
}

export const DEFAULT_SETTINGS: Settings = SettingsBlock.parse({ type: "settings" });

export function settingsOf(recipe: Recipe): Settings {
  const b = findBlock(recipe, "settings");
  return b ? { ...DEFAULT_SETTINGS, ...b } : DEFAULT_SETTINGS;
}

/** rating is the strictest of the recipe meta and the rating·negative block. */
export function ratingOf(recipe: Recipe): number {
  return Math.max(recipe.rating ?? 0, findBlock(recipe, "negative")?.rating ?? 0);
}

export type ComposeParts = {
  members: CastMember[];
  chars: (Character | undefined)[];
  count: string;
  /** ordered base-prompt fragments, before Text: hoisting / dedupe / sanitising */
  base: string[];
  characters: { prompt: string; uc: string; x: number; y: number }[];
  negative: string[];
  settings: Settings;
  rating: number;
};

const appearanceOf = (c: Character | undefined, m: CastMember) =>
  [...(c?.fixed_traits ?? []), ...m.traits].filter(t => /\b(hair|eyes|eye)\b/i.test(t));

/** Everything the composer would emit, still as separate fragments (the linter works on this). */
export function composeParts(recipe: Recipe, characters: Character[]): ComposeParts {
  const cast = findBlock(recipe, "cast");
  const members = cast?.members ?? [];
  const byId = new Map(characters.map(c => [c.id ?? -1, c]));
  const chars = members.map(m => resolveMemberCharacter(m, byId.get(m.character_id)));
  const rating = ratingOf(recipe);
  const settings = settingsOf(recipe);
  const style = findBlock(recipe, "style");
  const nsfw = findBlock(recipe, "nsfw");
  const neg = findBlock(recipe, "negative");
  const count = countTag(members.map((_, i) => chars[i]?.gender ?? "girl"));

  const base: string[] = [];
  if (count) base.push(count);

  const solo = members.length === 1;
  if (solo) {
    const c = chars[0];
    const m = members[0];
    // canon characters: the danbooru tag only (appearance tags break recognition, L03).
    // OCs (no series): the model does not know the name, so the tag is a noise token; send the fixed traits instead.
    if (c && c.series !== "") base.push(c.tag);
    if (c && c.series === "") base.push(...c.fixed_traits);
    base.push(...m.traits, ...m.outfit, ...m.expression);
  }

  for (const t of solo ? TAG_BLOCKS : BASE_BLOCKS_MULTI) base.push(...blockFragments(recipe, t));

  const textEntries = (findBlock(recipe, "text")?.entries ?? []).filter(entry => entry.text.trim());
  const textPosition = base.length;

  if (rating >= 1 && nsfw) base.push(...nsfw.explicit_tags);

  if (style) {
    base.push(...style.artists.map(a => artistTag(a)));
    if (style.year) base.push(style.year);
    base.push(...style.quality, ...style.minus);
  }
  if (textEntries.length) {
    const existingCount = hoistText(base).text.flatMap(t => t.slice("Text:".length).trim().split(/\n\s*\n/)).filter(Boolean).length;
    base.splice(textPosition, 0, "text", ...textEntries.map((entry, i) =>
      `Text fragment ${existingCount + i + 1} appears ${TEXT_EFFECTS[entry.kind].instruction}.`));
    base.push(`Text: ${renderText(textEntries)}`);
  }

  const characterPrompts: ComposeParts["characters"] = [];
  if (!solo) {
    const shared = MEMBER_BLOCKS.flatMap(t => blockFragments(recipe, t));
    const guard = cast?.auto_leak_guard ?? true;
    const appearance = members.map((m, i) => appearanceOf(chars[i], m));
    const anyAppearance = appearance.some(a => a.length > 0);
    members.forEach((m, i) => {
      const c = chars[i];
      const prompt: string[] = [c?.gender ?? "girl"];
      if (c && c.series !== "") prompt.push(c.tag);
      if (c && c.series === "") prompt.push(...c.fixed_traits);
      prompt.push(...m.traits, ...m.outfit, ...m.expression, ...shared, ...m.interactions);
      const leak = guard && anyAppearance ? appearance.filter((_, j) => j !== i).flat() : [];
      characterPrompts.push({
        prompt: sanitizePrompt(joinTags(prompt)),
        uc: sanitizePrompt(joinTags([...m.uc, ...leak])),
        x: m.x,
        y: m.y,
      });
    });
  }

  const negative: string[] = [];
  const preset = neg?.base_preset ?? "heavy";
  if (preset === "heavy") negative.push(UC_HEAVY);
  else if (preset === "light") negative.push(UC_LIGHT);
  negative.push(...(neg?.extra ?? []));
  if (rating < 1) negative.push(...SFW_GUARDS); // rating >= 1: the block's own extra carries the censor/anatomy negatives

  return { members, chars, count, base, characters: characterPrompts, negative, settings, rating };
}

/** Move every `Text: ...` render block to the very end of the base prompt. */
function hoistText(parts: string[]): { kept: string[]; text: string[] } {
  const kept: string[] = [];
  const text: string[] = [];
  for (const p of parts) {
    const { head, text: t } = splitTextRender(p);
    if (t) { if (head) kept.push(head); text.push(t); } else kept.push(p);
  }
  return { kept, text };
}

/** Blocks -> what actually goes to the NAI API. */
export function compose(recipe: Recipe, characters: Character[]): Composed {
  const p = composeParts(recipe, characters);
  const { kept, text } = hoistText(p.base);
  const joined = joinTags(kept);
  const rendered = text.map(t => t.slice("Text:".length).trim()).filter(Boolean).join("\n\n");
  const base_prompt = sanitizePrompt(rendered ? `${joined}, Text: ${rendered}`.replace(/^,\s*/, "") : joined);
  return {
    base_prompt,
    negative: sanitizePrompt(joinTags(p.negative)),
    characters: p.characters,
    settings: p.settings,
    rating: p.rating,
  };
}

/** Human-readable preview for the recipe tab. */
export function previewText(c: Composed): string {
  const lines = [`BASE`, c.base_prompt];
  c.characters.forEach((ch, i) => {
    lines.push("", `CHARACTER ${i + 1}  (x ${ch.x.toFixed(2)}, y ${ch.y.toFixed(2)})`, ch.prompt);
    if (ch.uc) lines.push(`UC: ${ch.uc}`);
  });
  lines.push("", "NEGATIVE", c.negative);
  const s = c.settings;
  lines.push(
    "",
    "SETTINGS",
    `${s.width}x${s.height} · ${s.steps} steps · scale ${s.scale} · rescale ${s.rescale} · ${s.sampler}/${s.schedule} · uc ${s.uc_preset} · quality ${s.quality_preset} · rating ${c.rating}`,
  );
  return lines.join("\n");
}

export { splitTags, countTag };
