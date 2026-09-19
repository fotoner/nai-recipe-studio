import { describe, expect, it } from "vitest";
import { compose } from "../core/recipe/compose";
import { validateAndFix, validateRecipe } from "../core/recipe/validate";
import { quoteGeneration } from "../core/generation/cost";
import { makeRecipe, makeCharacter } from "../core/recipe/model";

describe("public recipe core", () => {
  it("keeps the proven prompt order while accepting a neutral recipe", () => {
    const character = makeCharacter({ id: 1, tag: "sample hero", series: "sample series", age_flag: "adult" });
    const recipe = makeRecipe("Example", [
      { type: "cast", members: [{ character_id: 1, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }] },
      { type: "scene", tags: ["indoors"], text: "" },
      { type: "style", artists: [], year: "", quality: [], minus: [] },
      { type: "negative", base_preset: "heavy", rating: 0, extra: ["official art", "official style"] },
      { type: "settings", width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "fixed", seed: 4, quality_preset: "none", uc_preset: "heavy" },
    ]);

    const result = compose(recipe, [character]);
    expect(result.base_prompt).toMatch(/^solo, sample hero, indoors/);
    expect(result.negative).toContain("official art");
    expect(result.settings.seed).toBe(4);
  });

  it("does not expose private style advice as a public validation result", () => {
    const recipe = makeRecipe("Example", [
      { type: "style", artists: [{ name: "artist", weight: 2 }], year: "year 2026", quality: [], minus: [] },
      { type: "negative", base_preset: "heavy", rating: 0, extra: [] },
    ]);
    const findings = validateRecipe(recipe, []);
    expect(findings.some(f => ["L06", "L07", "L08", "L09", "L20"].includes(f.code))).toBe(false);
    expect(findings.every(f => f.messageKey.length > 0)).toBe(true);
  });

  it("does not advertise unsupported syntax or count mismatches as auto-fixable", () => {
    const recipe = makeRecipe("Example", [
      { type: "cast", members: [
        { character_id: 1, x: 0.25, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] },
        { character_id: 2, x: 0.75, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] },
      ], layout_preset: "side_by_side", auto_leak_guard: true },
      { type: "scene", tags: ["solo", "#if private"], text: "" },
    ]);
    const findings = validateRecipe(recipe, []);
    expect(findings.find(f => f.code === "UNSUPPORTED_SYNTAX")).toMatchObject({ fixable: false });
    expect(findings.find(f => f.code === "COUNT_MISMATCH")).toMatchObject({ fixable: false });
  });

  it("sanitizes only block prompt fields and preserves recipe metadata and IDs", () => {
    const recipe = {
      ...makeRecipe("name123::", [{
        type: "scene" as const,
        preset_id: 9,
        tags: ["scene123::"],
        text: "description123::",
      }]),
      id: 7,
      tags: ["metadata123::"],
      source: "source123::",
      notes: "notes123::",
    };
    const result = validateAndFix(recipe, [], ["PROMPT_SYNTAX"]);
    expect(result.applied).toEqual(["PROMPT_SYNTAX"]);
    expect(result.recipe).toMatchObject({ id: 7, name: "name123::", tags: ["metadata123::"], source: "source123::", notes: "notes123::" });
    expect(result.recipe.blocks[0]).toMatchObject({ type: "scene", preset_id: 9, tags: ["scene123 ::"], text: "description123 ::" });
  });

  it.each([
    { genders: ["boy", "boy"] as const, tags: ["2boys"] },
    { genders: ["girl", "boy"] as const, tags: ["1girl", "1boy"] },
  ])("checks count tags against the selected characters' genders: $tags", ({ genders, tags }) => {
    const characters = genders.map((gender, index) => makeCharacter({ id: index + 1, tag: `sample character ${index + 1}`, gender, age_flag: "adult" }));
    const recipe = makeRecipe("Two characters", [
      { type: "cast", members: characters.map(character => ({ character_id: character.id!, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] })) },
      { type: "scene", tags, text: "" },
    ]);
    expect(validateRecipe(recipe, characters).filter(item => item.code === "COUNT_MISMATCH")).toEqual([]);
  });
});

describe("generation cost core", () => {
  it("never treats an unverified account as free", () => {
    const settings = { width: 832, height: 1216, steps: 28 };
    expect(quoteGeneration(settings, 1, null)).toMatchObject({ estimatedAnlas: null, isFree: false, verified: false });
  });

  it("uses verified subscription information for a free-window quote", () => {
    const settings = { width: 832, height: 1216, steps: 28 };
    expect(quoteGeneration(settings, 2, { tier: "opus", anlas: 0, usagePercent: 20, checkedAt: "2026-09-20T00:00:00.000Z" }))
      .toMatchObject({ estimatedAnlas: 0, isFree: true, verified: true });
  });
});
