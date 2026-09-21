import { describe, expect, it } from "vitest";
import type { GalleryItem } from "../contracts/studio";
import { SettingsBlock, type Character, type Recipe } from "../lib/schema";
import { newRecipe } from "../features/shared/types";
import { recipeFromGeneration } from "../core/recipe/from-generation";

function recipeSnapshot(): Recipe {
  const recipe = newRecipe("Generation snapshot");
  return {
    ...recipe,
    id: 29,
    created_at: "2026-09-20T10:00:00.000Z",
    updated_at: "2026-09-20T10:00:00.000Z",
    blocks: recipe.blocks.map(block => block.type === "settings" ? { ...block, width: 768, height: 1024, seed_policy: "fixed", seed: 7 } : block),
  };
}

function generationItem(recipe = recipeSnapshot(), seed = 947, settings = SettingsBlock.parse({
  type: "settings", width: 1024, height: 1024, steps: 24, scale: 4, rescale: 0.2, sampler: "k_euler_ancestral", schedule: "karras",
  seed_policy: "random", quality_preset: "none", uc_preset: "heavy",
})): GalleryItem {
  return {
    id: 74, recipe_id: recipe.id ?? null, recipe_name: recipe.name, recipe, seed, width: settings.width, height: settings.height,
    rating: recipe.rating, url: "file:///synthetic/generated.png", created_at: "2026-09-20T10:00:00.000Z", estimatedAnlas: 0,
    score: null, liked: false, note: "", base_prompt: "synthetic prompt", negative: "synthetic negative", characters: [], settings,
  };
}

describe("recipe drafts from generation snapshots", () => {
  it("uses the generation-time recipe and actual settings with the same seed without changing the source", () => {
    const source = recipeSnapshot();
    const generation = generationItem(source);

    const draft = recipeFromGeneration(generation, "same");

    expect(draft).toMatchObject({ sourceGenerationId: 74, seedMode: "same", characterSnapshot: "none" });
    expect(draft.recipe).not.toBe(source);
    expect(draft.recipe.id).toBeUndefined();
    expect(draft.recipe.created_at).toBeUndefined();
    expect(draft.recipe.updated_at).toBeUndefined();
    expect(draft.recipe.name).toBe("Generation snapshot");
    expect(draft.recipe.source).toBe("import:generation:74");
    expect(draft.recipe.blocks.find(block => block.type === "scene")).toEqual(source.blocks.find(block => block.type === "scene"));
    expect(draft.recipe.blocks.find(block => block.type === "settings")).toMatchObject({ type: "settings", width: 1024, height: 1024, steps: 24, seed_policy: "fixed", seed: 947 });
    expect(source.id).toBe(29);
    expect(source.blocks.find(block => block.type === "settings")).toMatchObject({ type: "settings", width: 768, seed_policy: "fixed", seed: 7 });
  });

  it("clears a fixed seed and returns to random policy when continuing with a new seed", () => {
    const generation = generationItem(recipeSnapshot(), 947, SettingsBlock.parse({
      type: "settings", width: 960, height: 1280, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras",
      seed_policy: "fixed", seed: 101, quality_preset: "none", uc_preset: "heavy",
    }));

    const draft = recipeFromGeneration(generation, "new");
    const settings = draft.recipe.blocks.find(block => block.type === "settings");

    expect(draft.seedMode).toBe("new");
    expect(settings).toMatchObject({ type: "settings", width: 960, height: 1280, steps: 28, seed_policy: "random" });
    expect(settings?.type === "settings" && "seed" in settings).toBe(false);
  });

  it("uses image pixel dimensions when a legacy generation has no settings snapshot", () => {
    const generation = { ...generationItem(recipeSnapshot()), settings: undefined, width: 1024, height: 768 };

    const draft = recipeFromGeneration(generation, "new");

    expect(draft.recipe.blocks.find(block => block.type === "settings")).toMatchObject({ type: "settings", width: 1024, height: 768, steps: 28 });
  });

  it("keeps legacy cast IDs and reports when no generation-time character snapshot exists", () => {
    const source = recipeSnapshot();
    const member = { character_id: 21, x: 0.25, y: 0.6, traits: ["blue eyes"], outfit: [], expression: [], uc: [], interactions: [] };
    const recipe: Recipe = { ...source, blocks: [{ type: "cast", members: [member], layout_preset: "solo", auto_leak_guard: true }, ...source.blocks] };
    const generation = { ...generationItem(recipe), characters: [{ prompt: "girl, snapshot-only prompt", uc: "snapshot-only uc", x: 0.25, y: 0.6 }] };

    const draft = recipeFromGeneration(generation, "same");
    const cast = draft.recipe.blocks.find(block => block.type === "cast");

    expect(draft.characterSnapshot).toBe("missing");
    expect(cast?.type === "cast" ? cast.members : []).toEqual([member]);
    expect(draft.recipe.blocks.find(block => block.type === "settings")).toMatchObject({ type: "settings", seed_policy: "fixed", seed: 947 });
  });

  it("preserves embedded character snapshots without consulting the image prompt", () => {
    const character: Character = {
      id: 21, tag: "historical_character_tag", series: "snapshot series", display_name: "Historical character", gender: "girl", age_flag: "adult", locked: false,
      fixed_traits: ["long hair"], default_x: 0.25, default_y: 0.6, notes: "snapshot note",
    };
    const source = recipeSnapshot();
    const member = { character_id: 21, character_snapshot: character, x: 0.25, y: 0.6, traits: ["blue eyes"], outfit: [], expression: [], uc: [], interactions: [] };
    const recipe: Recipe = { ...source, blocks: [{ type: "cast", members: [member], layout_preset: "solo", auto_leak_guard: true }, ...source.blocks] };
    const generation = { ...generationItem(recipe), characters: [{ prompt: "untrusted prompt data", uc: "untrusted negative data", x: 0.25, y: 0.6 }] };

    const draft = recipeFromGeneration(generation, "same");
    const cast = draft.recipe.blocks.find(block => block.type === "cast");

    expect(draft.characterSnapshot).toBe("complete");
    expect(cast?.type === "cast" ? cast.members[0]?.character_snapshot : undefined).toEqual(character);
  });
});
