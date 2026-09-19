import { Block as BlockSchema, Character as CharacterSchema, Recipe as RecipeSchema, type Character, type Recipe } from "../../lib/schema";

/** Parse a recipe at the service boundary while keeping the stored object JSON-safe. */
export function parseRecipe(value: unknown): Recipe {
  return RecipeSchema.parse(value);
}

export function parseCharacter(value: unknown): Character {
  return CharacterSchema.parse(value);
}

/** Neutral recipe factory for the distributed app. It contains no private style profile. */
export function makeRecipe(name = "", blocks: unknown[] = []): Recipe {
  return RecipeSchema.parse({
    name,
    tags: [],
    rating: 0,
    blocks: blocks.map(block => BlockSchema.parse(block)),
    source: "manual",
    notes: "",
  });
}

export function makeCharacter(input: Partial<Character> & Pick<Character, "tag">): Character {
  return CharacterSchema.parse({
    series: "",
    display_name: "",
    gender: "girl",
    age_flag: "unknown",
    locked: false,
    fixed_traits: [],
    default_x: 0.5,
    default_y: 0.5,
    notes: "",
    ...input,
  });
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
