import { expect, it } from "vitest";
import { compose } from "../core/recipe/compose";
import { validateRecipe } from "../core/recipe/validate";
import { makeCharacter, makeRecipe } from "../core/recipe/model";

const original = makeCharacter({ id: 1, tag: "original hero", series: "synthetic series", age_flag: "adult" });
const recipe = () => makeRecipe("Snapshot", [{ type: "cast", members: [{ character_id: 1, character_snapshot: original }] }]);
it("preserves snapshot characters through schema parsing, composition, and missing live rows", () => {
  expect(compose(recipe(), []).base_prompt).toContain("original hero");
  expect(compose(recipe(), [{ ...original, tag: "changed hero" }]).base_prompt).toContain("original hero");
  expect(validateRecipe(recipe(), []).filter(f => f.severity === "error")).toEqual([]);
});
it("retains current and snapshot minor restrictions when a frozen character is used", () => {
  const sensitive = { ...recipe(), rating: 1 };
  expect(validateRecipe(sensitive, [{ ...original, age_flag: "minor", locked: true }])).toContainEqual(expect.objectContaining({ code: "POLICY_BLOCKED" }));
  const minorSnapshot = makeRecipe("Snapshot", [{ type: "cast", members: [{ character_id: 1, character_snapshot: { ...original, age_flag: "minor" } }] }]);
  expect(validateRecipe({ ...minorSnapshot, rating: 1 }, [original])).toContainEqual(expect.objectContaining({ code: "POLICY_BLOCKED" }));
});
it("blocks a deleted character with no snapshot instead of silently omitting its prompt", () => {
  const missing = makeRecipe("Missing", [{ type: "cast", members: [{ character_id: 987 }] }]);
  expect(validateRecipe(missing, [])).toContainEqual(expect.objectContaining({ code: "MISSING_CHARACTER", severity: "error" }));
});
