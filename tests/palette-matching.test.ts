import { describe, expect, it } from "vitest";
import { createPresetMatcher, indexGenerationForPresets, matchesPreset } from "../core/palette/matching";
import type { BlockPreset, Recipe } from "../lib/schema";

const preset: BlockPreset = {
  id: 17,
  type: "scene",
  name: "Synthetic palette entry",
  block: { type: "scene", tags: ["moonlit sky", "green trees"], text: "" },
  tags: [],
  notes: "",
};

function generation(blocks: Recipe["blocks"], basePrompt = "") {
  const recipe = { name: "Synthetic recipe", tags: [], rating: 0, blocks, source: "manual", notes: "" } as Recipe;
  return indexGenerationForPresets(recipe, basePrompt);
}

describe("palette generation matching", () => {
  it("matches a preset reference or equivalent block content without requiring the id", () => {
    const matcher = createPresetMatcher(preset);
    expect(matchesPreset(generation([{ ...preset.block, preset_id: 17 }]), matcher)).toBe(true);
    expect(matchesPreset(generation([{ type: "scene", tags: ["green trees", "moonlit sky"], text: "" }]), matcher)).toBe(true);
    expect(matchesPreset(generation([{ type: "scene", tags: ["forest"], text: "" }]), matcher)).toBe(false);
  });

  it("uses every normalized preset tag as a fallback against weighted prompt tags", () => {
    const matcher = createPresetMatcher(preset);
    expect(matchesPreset(generation([{ type: "scene", tags: ["different content"], text: "" }], "1.2::MOONLIT SKY::, -0.4::green trees::"), matcher)).toBe(true);
    expect(matchesPreset(generation([{ type: "scene", tags: ["different content"], text: "" }], "1.2::moonlit sky::"), matcher)).toBe(false);
  });

  it("does not treat an empty tag preset as matching every prompt", () => {
    const emptyTagPreset: BlockPreset = {
      ...preset,
      id: 18,
      name: "Empty tag preset",
      block: { type: "scene", tags: [], text: "" },
    };
    expect(matchesPreset(generation([] , "any prompt tags"), createPresetMatcher(emptyTagPreset))).toBe(false);
  });
});
