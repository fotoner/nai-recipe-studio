import { z } from "zod";
import { Recipe as RecipeSchema, Block, CastBlock, CastMember } from "@/lib/schema";
import type { Recipe } from "@/features/shared/types";

// Recovery also accepts incomplete editor state; persisted recipe saves keep the stricter schema.
const DraftRecipeSchema = RecipeSchema.extend({
  name: z.string(),
  blocks: z.array(z.union([CastBlock.extend({ members: z.array(CastMember).max(22) }), Block])),
  version: z.number().int().positive().optional(),
});

const PREFIX = "nai-recipe-studio:draft:v1:";
export type RecipeDraft = { key: string; recipe: Recipe; updatedAt: string };
export const recipeDraftKey = (id: number) => `recipe:${id}`;
export function readDraft(key: string): RecipeDraft | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw || raw.length > 2_000_000) return null;
    const value = JSON.parse(raw) as RecipeDraft;
    if (value.key !== key || typeof value.updatedAt !== "string" || !value.recipe?.blocks) return null;
    const valid = DraftRecipeSchema.safeParse(value.recipe);
    if (!valid.success) return null;
    return { key, updatedAt: value.updatedAt, recipe: valid.data };
  } catch { return null; }
}
export function writeDraft(key: string, recipe: Recipe) {
  const json = JSON.stringify({ key, recipe, updatedAt: new Date().toISOString() });
  if (json.length > 2_000_000) throw new Error("DRAFT_TOO_LARGE");
  localStorage.setItem(PREFIX + key, json);
}
export function removeDraft(key: string) { localStorage.removeItem(PREFIX + key); }
export function listDrafts(): RecipeDraft[] {
  try {
    return Object.keys(localStorage).filter(key => key.startsWith(PREFIX)).flatMap(key => {
      const draft = readDraft(key.slice(PREFIX.length));
      return draft ? [draft] : [];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch { return []; }
}
