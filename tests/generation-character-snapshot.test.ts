import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudioService } from "../services/studio";
import { makeCharacter, makeRecipe } from "../core/recipe/model";

describe("generation character snapshots", () => {
  it("stores the resolved character values in the prepared recipe", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-character-snapshot-"));
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
    try {
      const character = await service.call("characters.save", {
        character: makeCharacter({
          tag: "synthetic character",
          series: "Synthetic series",
          display_name: "Synthetic character",
          age_flag: "adult",
          fixed_traits: ["short hair"],
          default_x: 0.35,
          default_y: 0.6,
        }),
      });
      const recipe = makeRecipe("Snapshot fixture", [{
        type: "cast",
        members: [{ character_id: character.id, x: 0.35, y: 0.6, traits: [], outfit: [], expression: [], uc: [], interactions: [] }],
      }]);

      const plan = await service.call("generation.prepare", { recipe, count: 1, seed: 11 });
      const cast = plan.recipe.blocks.find(block => block.type === "cast");
      expect(cast?.type).toBe("cast");
      if (cast?.type !== "cast") throw new Error("Cast block missing from generation plan");
      expect(cast.members[0]).toHaveProperty("character_snapshot", expect.objectContaining({
        tag: "synthetic character",
        series: "Synthetic series",
        display_name: "Synthetic character",
        fixed_traits: ["short hair"],
      }));
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
