import { describe, expect, it } from "vitest";
import { WorkspaceBackupManifestSchema } from "../services/workspace-backup-contract";

const timestamp = "2026-09-20T07:00:00.000Z";
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    format: "nai-recipe-studio-workspace",
    schemaVersion: 1,
    backupId: "a".repeat(64),
    createdAt: timestamp,
    appVersion: "0.1.0",
    snapshot: {
      schemaVersion: 1,
      recipes: [{ id: 1, version: 1, createdAt: timestamp, updatedAt: timestamp, recipe: { id: 1, name: "Fixture", tags: [], rating: 0, blocks: [], source: "manual", notes: "" } }],
      recipeVersions: [],
      characters: [],
      presets: [],
      generations: [],
    },
    images: [],
    ...overrides,
  };
}

describe("workspace backup manifest schema", () => {
  it("accepts the portable metadata shape and excludes app configuration", () => {
    expect(WorkspaceBackupManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it("rejects private settings and credentials added to the portable snapshot", () => {
    const value = manifest({ snapshot: { ...manifest().snapshot as object, settings: { apiKey: "must-not-be-exported" } } });
    expect(WorkspaceBackupManifestSchema.safeParse(value).success).toBe(false);
  });

  it("rejects unsafe or orphaned image member paths", () => {
    const base = manifest();
    const value = manifest({
      snapshot: {
        ...(base.snapshot as object),
        generations: [{
          id: 1, recipeId: null, recipe: { name: "Fixture", tags: [], rating: 0, blocks: [], source: "manual", notes: "" },
          seed: 1, width: 832, height: 1216, rating: 0, createdAt: timestamp, estimatedAnlas: 0,
          basePrompt: "", negative: "", characters: [], settings: {}, score: null, liked: false, note: "",
        }],
      },
      images: [{ generationId: 1, path: "../../outside.png", sha256: "b".repeat(64), size: 8 }],
    });
    expect(WorkspaceBackupManifestSchema.safeParse(value).success).toBe(false);
  });
});
