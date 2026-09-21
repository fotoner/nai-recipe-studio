import type { Block, BlockPreset, Recipe } from "../../lib/schema";
import { blockKey } from "./index";

export type PresetMatcher = {
  id?: number;
  contentKey: string;
  requiredPromptTags: string[];
};

export type GenerationPresetIndex = {
  presetIds: Set<number>;
  contentKeys: Set<string>;
  promptTags: Set<string>;
};

/** Normalize a prompt token using the same NovelAI weight syntax as recipe tags. */
export function normalizePresetTag(tag: string): string {
  const value = tag.trim().toLowerCase();
  const match = /^-?\d+(?:\.\d+)?::(.*?)\s*::$/.exec(value);
  return (match ? match[1] : value).trim().toLowerCase();
}

export function promptTagSet(prompt: string): Set<string> {
  return new Set(prompt.split(",").map(normalizePresetTag).filter(Boolean));
}

export function createPresetMatcher(preset: Pick<BlockPreset, "id" | "block">): PresetMatcher {
  return {
    ...(preset.id !== undefined ? { id: preset.id } : {}),
    contentKey: blockKey(preset.block),
    requiredPromptTags: "tags" in preset.block ? preset.block.tags.map(normalizePresetTag).filter(Boolean) : [],
  };
}

export function indexGenerationForPresets(recipe: Pick<Recipe, "blocks">, basePrompt: string): GenerationPresetIndex {
  const presetIds = new Set<number>();
  const contentKeys = new Set<string>();
  for (const candidate of recipe.blocks ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const block = candidate as Block & { preset_id?: unknown };
    const presetId = block.preset_id;
    if (typeof presetId === "number" && Number.isSafeInteger(presetId) && presetId > 0) presetIds.add(presetId);
    try {
      contentKeys.add(blockKey(block));
    } catch {
      // Invalid legacy snapshot blocks do not participate in palette matching.
    }
  }
  return { presetIds, contentKeys, promptTags: promptTagSet(basePrompt) };
}

export function matchesPreset(generation: GenerationPresetIndex, preset: PresetMatcher): boolean {
  if (preset.id !== undefined && generation.presetIds.has(preset.id)) return true;
  if (generation.contentKeys.has(preset.contentKey)) return true;
  return preset.requiredPromptTags.length > 0 && preset.requiredPromptTags.every(tag => generation.promptTags.has(tag));
}
