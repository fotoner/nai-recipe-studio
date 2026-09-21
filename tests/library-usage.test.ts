import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StudioSqliteStore } from "../adapters/sqlite";
import type { Block, Recipe } from "../lib/schema";

const member = (characterId: number) => ({
  character_id: characterId,
  x: 0.5,
  y: 0.5,
  traits: [],
  outfit: [],
  expression: [],
  uc: [],
  interactions: [],
});

function recipe(name: string, blocks: Block[]): Recipe {
  return { name, tags: [], rating: 0, blocks, source: "manual", notes: "" };
}

function cast(characterId: number): Block {
  return { type: "cast", members: [member(characterId)], layout_preset: "solo", auto_leak_guard: true };
}

function scene(tags: string[], presetId?: number): Block {
  return { type: "scene", ...(presetId ? { preset_id: presetId } : {}), tags, text: "" };
}

function insertGeneration(store: StudioSqliteStore, snapshot: Recipe, basePrompt: string, seed: number, recipeId: number | null = null, rating = 0) {
  return store.insertGeneration({
    recipe: snapshot,
    recipeId,
    seed,
    width: 512,
    height: 768,
    rating,
    file: `${seed}.png`,
    outputRoot: "/synthetic/output",
    basePrompt,
    negative: "",
    characters: [],
    settings: {},
    estimatedAnlas: 0,
  });
}

async function tempStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nai-library-usage-"));
  return { dataDir, store: new StudioSqliteStore(dataDir) };
}

describe("library generation usage", () => {
  it("retains explicit snapshot matches after a preset has been deleted", async () => {
    const { dataDir, store } = await tempStore();
    try {
      const preset = store.savePreset({ type: "scene", name: "Deleted palette", block: scene(["old scene"]), tags: [], notes: "" });
      const first = insertGeneration(store, recipe("Archived snapshot", [scene(["old scene"], preset.id)]), "old scene", 81);
      const second = insertGeneration(store, recipe("Archived snapshot", [scene(["old scene"], preset.id)]), "old scene", 82);
      insertGeneration(store, recipe("Unlinked snapshot", [scene(["old scene"])]), "old scene", 83);
      store.deletePreset(preset.id);

      const page = store.listGallery({ presetIds: [preset.id], sort: "oldest", offset: 1, limit: 1 });
      expect(page.total).toBe(2);
      expect(page.items.map(item => item.id)).toEqual([second]);
      expect(store.listGallery({ presetIds: [preset.id] }).items.map(item => item.id)).toEqual([second, first]);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("counts every generation once and returns only the four newest minimal examples", async () => {
    const { dataDir, store } = await tempStore();
    try {
      const character = store.saveCharacter({
        tag: "synthetic character",
        series: "",
        display_name: "Synthetic Character",
        gender: "other",
        age_flag: "adult",
        locked: false,
        fixed_traits: [],
        default_x: 0.5,
        default_y: 0.5,
        notes: "",
      });
      const preset = store.savePreset({
        type: "scene",
        name: "Synthetic scene",
        block: { type: "scene", tags: ["moonlit sky", "green trees"], text: "" },
        tags: [],
        notes: "",
      });
      const ids: number[] = [];

      for (let index = 0; index < 201; index += 1) {
        const mode = index % 3;
        const sceneBlock = mode === 0
          ? scene(["scene linked only by id"], preset.id)
          : mode === 1
            ? scene(["green trees", "moonlit sky"])
            : scene(["unrelated scene"]);
        const snapshot = recipe("Synthetic generation", [cast(character.id), cast(character.id), sceneBlock]);
        const basePrompt = mode === 2
          ? "1.2::moonlit sky::, -0.4::GREEN TREES::"
          : "unrelated prompt";
        ids.push(insertGeneration(store, snapshot, basePrompt, index));
      }

      const characterPage = store.listCharacters({ limit: 10 });
      const listedCharacter = characterPage.items.find(item => item.id === character.id)!;
      expect(listedCharacter.generation_count).toBe(201);
      expect(listedCharacter.examples).toHaveLength(4);
      expect(listedCharacter.examples?.map(example => example.id)).toEqual(ids.slice(-4).reverse());
      expect(Object.keys(listedCharacter.examples?.[0] ?? {}).sort()).toEqual(["created_at", "id", "rating", "recipe_id", "seed", "url"]);

      const presetPage = store.listPresets({ type: "scene", limit: 10 });
      const listedPreset = presetPage.items.find(item => item.id === preset.id)!;
      expect(listedPreset.usage).toBe(201);
      expect(listedPreset.examples).toHaveLength(4);
      expect(listedPreset.examples?.map(example => example.id)).toEqual(ids.slice(-4).reverse());
      expect(Object.keys(listedPreset.examples?.[0] ?? {}).sort()).toEqual(["created_at", "id", "rating", "recipe_id", "seed", "url"]);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("matches gallery presets by id, content, and weighted prompt tags while retaining other filters", async () => {
    const { dataDir, store } = await tempStore();
    try {
      const preset = store.savePreset({
        type: "scene",
        name: "Filtered scene",
        block: { type: "scene", tags: ["moonlit sky", "green trees"], text: "" },
        tags: [],
        notes: "",
      });
      const secondPreset = store.savePreset({
        type: "scene",
        name: "Second synthetic scene",
        block: { type: "scene", tags: ["river bank"], text: "" },
        tags: [],
        notes: "",
      });
      const targetRecipe = store.saveRecipe({ recipe: recipe("Target recipe", []) });
      const otherRecipe = store.saveRecipe({ recipe: recipe("Other recipe", []) });
      const idOnly = insertGeneration(store, recipe("Target snapshot", [scene(["different content"], preset.id)]), "unrelated prompt", 101, targetRecipe.id, 0);
      const contentOnly = insertGeneration(store, recipe("Target snapshot", [scene(["green trees", "moonlit sky"])]), "unrelated prompt", 102, targetRecipe.id, 1);
      const weightedPrompt = insertGeneration(store, recipe("Target snapshot", [scene(["unrelated scene"])]), "1.2::moonlit sky::, -0.4::green trees::", 103, targetRecipe.id, 1);
      const nonmatching = insertGeneration(store, recipe("Target snapshot", [scene(["forest"])]), "forest", 104, targetRecipe.id, 1);
      const wrongRecipe = insertGeneration(store, recipe("Other snapshot", [scene(["different content"], preset.id)]), "unrelated prompt", 105, otherRecipe.id, 1);
      const tooHighRating = insertGeneration(store, recipe("Target snapshot", [scene(["different content"], preset.id)]), "unrelated prompt", 106, targetRecipe.id, 2);
      const notLiked = insertGeneration(store, recipe("Target snapshot", [scene(["different content"], preset.id)]), "unrelated prompt", 107, targetRecipe.id, 0);
      const duplicateMatch = insertGeneration(store, recipe("Target snapshot", [scene(["green trees", "moonlit sky"], preset.id)]), "1.2::moonlit sky::, green trees", 108, targetRecipe.id, 1);
      const secondPresetOnly = insertGeneration(store, recipe("Target snapshot", [scene(["river bank"], secondPreset.id)]), "unrelated prompt", 109, targetRecipe.id, 1);
      for (const id of [idOnly, contentOnly, weightedPrompt, nonmatching, wrongRecipe, tooHighRating, duplicateMatch, secondPresetOnly]) store.rateGallery(id, { liked: true });

      const page = store.listGallery({
        presetIds: [preset.id, secondPreset.id],
        recipeId: targetRecipe.id,
        ratingMax: 1,
        liked: true,
        query: "Target",
        sort: "oldest",
        limit: 2,
        offset: 1,
      });
      expect(page.total).toBe(5);
      expect(page.items.map(item => item.id)).toEqual([contentOnly, weightedPrompt]);
      expect(page.items.map(item => item.seed)).toEqual([102, 103]);
      expect(page.items.every(item => item.recipe_id === targetRecipe.id && item.liked && item.rating <= 1)).toBe(true);
      expect(page.items.some(item => item.id === idOnly || item.id === nonmatching || item.id === wrongRecipe || item.id === tooHighRating || item.id === notLiked || item.id === duplicateMatch || item.id === secondPresetOnly)).toBe(false);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
