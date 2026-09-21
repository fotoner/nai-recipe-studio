import type { GalleryItem } from "../../contracts/studio";
import { SettingsBlock, type Recipe } from "../../lib/schema";

export type GenerationSeedMode = "same" | "new";
export type GenerationCharacterSnapshot = "none" | "complete" | "missing";
export type GenerationDraftFromImage = {
  recipe: Recipe;
  sourceGenerationId: number;
  seedMode: GenerationSeedMode;
  characterSnapshot: GenerationCharacterSnapshot;
};

export function recipeFromGeneration(item: GalleryItem, seedMode: GenerationSeedMode): GenerationDraftFromImage {
  const recipe = JSON.parse(JSON.stringify(item.recipe)) as Recipe & { version?: number };
  delete recipe.id;
  delete recipe.version;
  delete recipe.created_at;
  delete recipe.updated_at;
  recipe.source = `import:generation:${item.id}`;

  const existingSettings = recipe.blocks.find(block => block.type === "settings");
  const generationSettings = item.settings ?? { width: item.width, height: item.height };
  const settings = SettingsBlock.parse({
    ...(existingSettings?.type === "settings" ? existingSettings : {}),
    ...generationSettings,
    type: "settings",
  });
  if (seedMode === "same") {
    settings.seed_policy = "fixed";
    settings.seed = item.seed;
  } else {
    settings.seed_policy = "random";
    delete settings.seed;
  }
  const settingsIndex = recipe.blocks.findIndex(block => block.type === "settings");
  if (settingsIndex < 0) recipe.blocks = [...recipe.blocks, settings];
  else recipe.blocks = recipe.blocks.map((block, index) => index === settingsIndex ? settings : block);

  const cast = recipe.blocks.find(block => block.type === "cast");
  const characterSnapshot: GenerationCharacterSnapshot = !cast || cast.members.length === 0
    ? "none"
    : cast.members.every(member => Boolean(member.character_snapshot)) ? "complete" : "missing";

  return { recipe, sourceGenerationId: item.id, seedMode, characterSnapshot };
}
