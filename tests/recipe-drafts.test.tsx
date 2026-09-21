import { expect, it } from "vitest";
import { readDraft, writeDraft } from "../features/recipe-editor/drafts";
import { newRecipe } from "../features/shared/types";

it("recovers an unfinished cast block in its original position with its layout settings", () => {
  const recipe = { ...newRecipe(""), id: 8, version: 3 };
  recipe.blocks.push({ type: "cast", members: [], layout_preset: "side_by_side", auto_leak_guard: false });
  writeDraft("recipe:8", recipe);
  expect(readDraft("recipe:8")?.recipe).toEqual(recipe);
});
