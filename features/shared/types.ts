import type {
  Block as ContractBlock,
  BlockPreset,
  Character as ContractCharacter,
  Finding,
  GalleryItem as ContractGalleryItem,
  GenerationJob as ContractGenerationJob,
  GenerationPlan as ContractGenerationPlan,
  Recipe as ContractRecipe,
  RecipeVersion,
  StoredPreset,
  StoredRecipe,
  StudioEvent as ContractStudioEvent,
} from "@/contracts/studio";
import { i18n, normalizeLanguage } from "@/i18n";

export type Language = "system" | "ko" | "ja" | "en";
export type BlockType = "style" | "cast" | "scene" | "composition" | "outfit" | "expression_pose" | "lighting" | "motif" | "text" | "negative" | "settings" | "nsfw";
export type Block = ContractBlock;
export type Recipe = ContractRecipe & { id?: number; version?: number; created_at?: string; updated_at?: string };
export type Character = ContractCharacter;
export type Preset = StoredPreset & { description?: string };
export type GalleryItem = ContractGalleryItem;
export type LintFinding = Finding;
export type GenerationPlan = ContractGenerationPlan;
export type GenerationJob = ContractGenerationJob;
export type StudioEvent = ContractStudioEvent;
export type RecipeSummary = StoredRecipe & { latest?: GalleryItem };
export type Usage = { connected: boolean; plan?: string; percent?: number; anlas?: number; error?: string };
export type { RecipeVersion, BlockPreset };

export type Artist = Extract<Block, { type: "style" }> extends { artists: (infer T)[] } ? T : never;
export type CastMember = Extract<Block, { type: "cast" }> extends { members: (infer T)[] } ? T : never;
export type TagBlock = Extract<Block, { tags: string[] }>;

export type ViewRoute =
  | { page: "recipes" }
  | { page: "recipe"; id: number }
  | { page: "generation" }
  | { page: "gallery" }
  | { page: "palette" }
  | { page: "characters" }
  | { page: "settings" };

export const BLOCK_ORDER: BlockType[] = ["cast", "scene", "composition", "outfit", "expression_pose", "lighting", "motif", "text", "style", "nsfw", "negative", "settings"];
export const BLOCK_LABEL_KEY: Record<BlockType, string> = {
  style: "blocks.style", cast: "blocks.cast", scene: "blocks.scene", composition: "blocks.composition", outfit: "blocks.outfit",
  expression_pose: "blocks.expression", lighting: "blocks.lighting", motif: "blocks.motif", text: "blocks.text", negative: "blocks.negative", settings: "blocks.settings", nsfw: "blocks.nsfw",
};

const listBlock = (type: Exclude<BlockType, "style" | "cast" | "text" | "negative" | "settings" | "nsfw">): Block => ({ type, tags: [], text: "" });
export function newBlock(type: BlockType): Block {
  switch (type) {
    case "style": return { type, artists: [], year: "", quality: [], minus: [] };
    case "cast": return { type, members: [], layout_preset: "solo", auto_leak_guard: true };
    case "text": return { type, entries: [] };
    case "negative": return { type, base_preset: "heavy", rating: 0, extra: ["official art", "official style"] };
    case "settings": return { type, width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random", quality_preset: "none", uc_preset: "heavy" };
    case "nsfw": return { type, explicit_tags: [] };
    default: return listBlock(type);
  }
}

export function newRecipe(name = ""): Recipe {
  return { name, tags: [], rating: 0, blocks: [newBlock("scene"), newBlock("style"), newBlock("negative"), newBlock("settings")], source: "manual", notes: "" };
}

type SummaryLocale = "ko" | "ja" | "en";

function summaryLocale(value?: string): SummaryLocale {
  return normalizeLanguage(value ?? i18n.language);
}

function summaryText(locale: SummaryLocale, key: string, variables?: Record<string, number | string>): string {
  return i18n.t(key, { lng: locale, ...variables });
}

/** One-line block summary used by the editor header and the block picker. */
export function blockSummary(block: Block, language?: string): string {
  const locale = summaryLocale(language);
  if (block.type === "style") {
    return block.artists.map((artist) => `${artist.name} ${artist.weight}`).join(" · ") || summaryText(locale, "summary.noArtists");
  }
  if (block.type === "cast") {
    const countKey = locale === "en" ? (block.members.length === 1 ? "summary.memberCountOne" : "summary.memberCountMany") : "summary.memberCount";
    const count = summaryText(locale, countKey, { count: block.members.length });
    const layoutKey = `layout.${block.layout_preset}`;
    const layout = i18n.exists(layoutKey, { lng: locale }) ? summaryText(locale, layoutKey) : block.layout_preset;
    return `${count} · ${layout}`;
  }
  if (block.type === "negative") {
    const rating = summaryText(locale, "summary.rating");
    return `${rating} ${block.rating ?? 0} · ${block.base_preset} + ${block.extra.length}`;
  }
  if (block.type === "settings") {
    const stepsSuffix = summaryText(locale, "summary.stepsSuffix");
    return `${block.width}×${block.height} · ${block.steps}${stepsSuffix} · ${block.seed_policy}`;
  }
  if (block.type === "nsfw") return block.explicit_tags.join(", ") || summaryText(locale, "summary.empty");
  if (block.type === "text") {
    return block.entries.map((entry) => `${summaryText(locale, `summary.${entry.kind}`)}: ${entry.text}`).join(" · ") || summaryText(locale, "summary.noText");
  }
  return "tags" in block ? ([block.tags.join(", "), block.text].filter(Boolean).join(" / ") || summaryText(locale, "summary.empty")) : summaryText(locale, "summary.empty");
}

export function cloneRecipe(recipe: Recipe): Recipe { return JSON.parse(JSON.stringify(recipe)) as Recipe; }
export function parseRoute(hash: string): ViewRoute {
  const path = hash.split("?")[0].replace(/^#\/?/, "").replace(/\/$/, "") || "recipes";
  const [section, id] = path.split("/");
  if (section === "recipe" && id && /^\d+$/.test(id)) return { page: "recipe", id: Number(id) };
  if (section === "generate") return { page: "generation" };
  if (section === "gallery") return { page: "gallery" };
  if (section === "palette") return { page: "palette" };
  if (section === "characters") return { page: "characters" };
  if (section === "settings") return { page: "settings" };
  return { page: "recipes" };
}
export function routeHash(route: ViewRoute): string { return route.page === "recipe" ? `#/recipe/${route.id}` : route.page === "generation" ? "#/generate" : `#/${route.page}`; }
