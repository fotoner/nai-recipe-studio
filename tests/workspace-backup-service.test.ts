import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StudioSqliteStore } from "../adapters/sqlite/store";
import { OutputStore } from "../adapters/files/output-store";
import { compose } from "../core/recipe/compose";
import { createWorkspaceBackupService } from "../services/workspace-backup";
import type { WorkspaceBackupImage } from "../services/workspace-backup-contract";
import type { Recipe } from "../lib/schema";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function character(tag: string, notes: string) {
  return { tag, series: "Fixture series", display_name: tag, gender: "girl" as const, age_flag: "adult" as const, locked: false, fixed_traits: ["blue eyes"], default_x: 0.4, default_y: 0.5, notes };
}

function backupRecipe(characterId: number, presetId: number, name = "Portable recipe", includeCharacterSnapshot = true): Recipe {
  return {
    name, tags: ["fixture"], rating: 0, source: "manual", notes: "backup notes",
    blocks: [
      { type: "scene", preset_id: presetId, tags: ["indoors"], text: "" },
      { type: "cast", members: [{ character_id: characterId, ...(includeCharacterSnapshot ? { character_snapshot: { ...character("fixture_character", "source character"), id: characterId } } : {}), x: 0.4, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }], layout_preset: "solo", auto_leak_guard: true },
    ],
  };
}

function settings() {
  return { width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "fixed" as const, seed: 77, quality_preset: "none" as const, uc_preset: "heavy" as const };
}

function image(id: number): WorkspaceBackupImage {
  return { generationId: id, path: `assets/generation-${id}.png`, sha256: createHash("sha256").update(PNG).digest("hex"), size: PNG.length };
}

async function workspace(root: string, options: { source?: boolean; active?: () => boolean } = {}) {
  const dataDir = path.join(root, "data");
  const outputDir = path.join(root, "output");
  const store = new StudioSqliteStore(dataDir);
  const release = vi.fn();
  const readImage = async (id: number) => {
    const file = store.getGenerationFile(id);
    return new OutputStore(file.outputRoot).read(file.file);
  };
  const service = createWorkspaceBackupService({
    store,
    outputRoot: () => outputDir,
    readImage,
    hasActiveGeneration: options.active ?? (() => false),
    acquireExclusive: () => ({ release }),
  });
  return { store, service, outputDir, release };
}

async function sourceWorkspace(root: string) {
  const fixture = await workspace(root, { source: true });
  const savedCharacter = fixture.store.saveCharacter(character("fixture_character", "source character"));
  const savedPreset = fixture.store.savePreset({ type: "scene", name: "Fixture scene", block: { type: "scene", tags: ["indoors"], text: "" }, tags: ["fixture"], notes: "source preset" });
  let recipe = fixture.store.saveRecipe({ recipe: backupRecipe(savedCharacter.id, savedPreset.id) });
  recipe = fixture.store.saveRecipe({ recipe: { ...recipe, notes: "second version" }, expectedVersion: recipe.version, note: "version two" });
  const relative = await new OutputStore(fixture.outputDir).write("images/source.png", PNG, { source: "fixture metadata" });
  const generationId = fixture.store.insertGeneration({
    recipe, recipeId: recipe.id, seed: 77, width: 832, height: 1216, rating: 0, file: relative, outputRoot: fixture.outputDir,
    basePrompt: "fixture prompt", negative: "fixture negative", characters: [], settings: settings(), estimatedAnlas: 0,
  });
  fixture.store.rateGallery(generationId, { score: 4, liked: true, note: "saved rating" });
  return { ...fixture, recipe, savedCharacter, savedPreset, generationId };
}

async function targetWorkspace(root: string, active?: () => boolean) {
  const fixture = await workspace(root, { active });
  fixture.store.saveCharacter(character("unrelated_character", "filler"));
  const existingCharacter = fixture.store.saveCharacter(character("fixture_character", "target notes"));
  fixture.store.savePreset({ type: "scene", name: "Unused filler", block: { type: "scene", tags: [], text: "" }, tags: [], notes: "" });
  const existingPreset = fixture.store.savePreset({ type: "scene", name: "Fixture scene", block: { type: "scene", tags: ["target"], text: "" }, tags: [], notes: "keep target preset" });
  const existingRecipe = fixture.store.saveRecipe({ recipe: { name: "Existing", tags: [], rating: 0, blocks: [], source: "manual", notes: "keep" } });
  fixture.store.insertGeneration({ recipe: existingRecipe, recipeId: existingRecipe.id, seed: 1, width: 832, height: 1216, rating: 0, file: "missing-existing.png", outputRoot: fixture.outputDir, basePrompt: "existing", negative: "", characters: [], settings: settings(), estimatedAnlas: 0 });
  return { ...fixture, existingCharacter, existingPreset, existingRecipe };
}

async function makeSnapshot(source: Awaited<ReturnType<typeof sourceWorkspace>>) {
  return source.service.exportSnapshot();
}

describe("workspace backup merge service", () => {
  it("exports only portable workspace records and leaves settings, connections, file paths, and secrets out", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-service-"));
    try {
      const source = await sourceWorkspace(root);
      const snapshot = await makeSnapshot(source);
      expect(snapshot).toMatchObject({ schemaVersion: 1, recipes: [{ recipe: { name: "Portable recipe", id: source.recipe.id } }], generations: [{ id: source.generationId, score: 4, liked: true, note: "saved rating" }] });
      expect(snapshot.recipeVersions).toHaveLength(2);
      expect(JSON.stringify(snapshot)).not.toContain(source.outputDir);
      expect(snapshot).not.toHaveProperty("appSettings");
      expect(snapshot).not.toHaveProperty("connections");
      expect(snapshot).not.toHaveProperty("settings");
      expect(JSON.stringify(snapshot)).not.toContain("connections");
      expect(JSON.stringify(snapshot)).not.toContain("token");
      expect(JSON.stringify(snapshot)).not.toContain("source.png");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects malformed persisted JSON instead of exporting fallback-empty workspace data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-corrupt-json-"));
    try {
      const source = await sourceWorkspace(root);
      const db = source.store.db;
      const select = db.prepare("SELECT blocks FROM recipes WHERE id=?").get(source.recipe.id) as { blocks: string };
      db.prepare("UPDATE recipes SET blocks=? WHERE id=?").run("{malformed-json", source.recipe.id);
      let failure: unknown;
      try { source.service.exportSnapshot(); } catch (cause) { failure = cause; }
      expect(failure).toMatchObject({ data: { code: "INVALID_BACKUP_ARCHIVE" } });
      db.prepare("UPDATE recipes SET blocks=? WHERE id=?").run(select.blocks, source.recipe.id);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("merges with remapped relationships, preserves target conflicts, and records the same archive only once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-service-"));
    try {
      const source = await sourceWorkspace(path.join(root, "source"));
      const target = await targetWorkspace(path.join(root, "target"));
      const snapshot = await makeSnapshot(source);
      const archiveId = "a".repeat(64);
      const images = [image(source.generationId)];
      const preview = await target.service.inspect(snapshot, { backupId: archiveId, images });
      expect(preview).toMatchObject({ alreadyImported: false, missingFiles: 0, duplicates: { characters: 1 } });
      expect(preview.duplicates.presets).toBeGreaterThan(0);

      const result = await target.service.restore(snapshot, { backupId: archiveId, expectedRevision: preview.revision, images, readAsset: async () => PNG });
      expect(result).toMatchObject({ alreadyImported: false, restored: { recipes: 1, recipeVersions: 2, characters: 0, presets: 0, galleryItems: 1, images: 1 }, skipped: { characters: 1, presets: expect.any(Number), images: 0 } });
      expect(result.skipped.presets).toBeGreaterThan(0);
      const imported = target.store.getRecipe(2);
      const importedCast = imported.blocks.find(block => block.type === "cast");
      expect(importedCast?.type === "cast" && importedCast.members[0]).toMatchObject({ character_id: target.existingCharacter.id, character_snapshot: { id: target.existingCharacter.id } });
      const importedScene = imported.blocks.find(block => block.type === "scene");
      expect(importedScene?.type === "scene" && importedScene.preset_id).toBe(target.existingPreset.id);
      expect(target.store.getCharacter(target.existingCharacter.id).notes).toBe("target notes");
      expect(target.store.getPreset(target.existingPreset.id).notes).toBe("keep target preset");
      expect(target.store.listRecipeVersions(imported.id)).toHaveLength(2);
      expect(target.store.getGallery(2)).toMatchObject({ recipe_id: imported.id, score: 4, liked: true, note: "saved rating", recipe: expect.objectContaining({ name: "Portable recipe" }) });
      const importedFile = target.store.getGenerationFile(2);
      await expect(readFile(path.join(importedFile.outputRoot, importedFile.file))).resolves.toEqual(PNG);

      const secondPreview = await target.service.inspect(snapshot, { backupId: archiveId, images });
      expect(secondPreview.alreadyImported).toBe(true);
      const countsBefore = target.store.listGallery({ limit: 200 }).total;
      const repeated = await target.service.restore(snapshot, { backupId: archiveId, expectedRevision: secondPreview.revision, images, readAsset: async () => PNG });
      expect(repeated.alreadyImported).toBe(true);
      expect(target.store.listGallery({ limit: 200 }).total).toBe(countsBefore);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not map an active imported character to a matching soft-deleted local character", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-deleted-character-"));
    try {
      const source = await sourceWorkspace(path.join(root, "source"));
      const target = await workspace(path.join(root, "target"));
      const oldCharacter = target.store.saveCharacter(character("fixture_character", "old deleted character"));
      target.store.deleteCharacter(oldCharacter.id);
      const snapshot = await makeSnapshot(source);
      const images = [image(source.generationId)];
      const preview = await target.service.inspect(snapshot, { backupId: "e".repeat(64), images });

      expect(preview.duplicates.characters).toBe(0);
      const result = await target.service.restore(snapshot, { backupId: "e".repeat(64), expectedRevision: preview.revision, images, readAsset: async () => PNG });
      expect(result.restored.characters).toBe(1);
      const activeCharacters = target.store.listCharacters({ limit: 100 }).items;
      expect(activeCharacters).toHaveLength(1);
      expect(activeCharacters[0]).toMatchObject({ tag: "fixture_character", notes: "source character" });
      const importedRecipe = target.store.getRecipe(1);
      const cast = importedRecipe.blocks.find(block => block.type === "cast");
      expect(cast?.type === "cast" && cast.members[0]?.character_id).toBe(activeCharacters[0]?.id);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recognizes a recipe as duplicate only when its mapped version history also matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-recipe-history-"));
    try {
      const source = await sourceWorkspace(path.join(root, "source"));
      const target = await workspace(path.join(root, "target"));
      const targetCharacter = target.store.saveCharacter(character("fixture_character", "source character"));
      const targetPreset = target.store.savePreset({ type: "scene", name: "Fixture scene", block: { type: "scene", tags: ["indoors"], text: "" }, tags: ["fixture"], notes: "target scene" });
      let targetRecipe = target.store.saveRecipe({ recipe: backupRecipe(targetCharacter.id, targetPreset.id) });
      targetRecipe = target.store.saveRecipe({ recipe: { ...targetRecipe, notes: "second version" }, expectedVersion: targetRecipe.version, note: "version two" });
      const snapshot = await makeSnapshot(source);
      const images = [image(source.generationId)];
      const preview = await target.service.inspect(snapshot, { backupId: "f".repeat(64), images });

      expect(preview.duplicates.recipes).toBe(1);
      expect(preview.duplicates.recipeVersions).toBe(2);
      const result = await target.service.restore(snapshot, { backupId: "f".repeat(64), expectedRevision: preview.revision, images, readAsset: async () => PNG });
      expect(result.skipped).toMatchObject({ recipes: 1, recipeVersions: 2 });
      expect(target.store.listRecipes({ limit: 100 }).total).toBe(1);
      expect(target.store.listRecipeVersions(targetRecipe.id)).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("remaps preset references that point forward to a later preset record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-forward-preset-"));
    try {
      const source = await workspace(path.join(root, "source"));
      const target = await workspace(path.join(root, "target"));
      const timestamp = new Date().toISOString();
      const insert = source.store.db.prepare(`INSERT INTO presets (id, type, name, builtin_id, hidden, block, tags, notes, created_at, updated_at)
        VALUES (?, 'scene', ?, NULL, 0, ?, '[]', '', ?, ?)`);
      insert.run(1000, "Forward parent", JSON.stringify({ type: "scene", preset_id: 1001, tags: ["parent"], text: "" }), timestamp, timestamp);
      insert.run(1001, "Forward child", JSON.stringify({ type: "scene", tags: ["child"], text: "" }), timestamp, timestamp);
      const snapshot = await source.service.exportSnapshot();
      const preview = await target.service.inspect(snapshot, { backupId: "1".repeat(64), images: [] });

      const result = await target.service.restore(snapshot, { backupId: "1".repeat(64), expectedRevision: preview.revision, images: [], readAsset: async () => null });
      expect(result.restored.presets).toBe(2);
      const presets = target.store.listPresets({ query: "Forward", limit: 10 }).items;
      const parent = presets.find(preset => preset.name === "Forward parent");
      const child = presets.find(preset => preset.name === "Forward child");
      expect(parent?.block).toMatchObject({ preset_id: child?.id });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("freezes the imported source character when a same-tag local character has different prompt traits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-character-snapshot-"));
    try {
      const source = await workspace(path.join(root, "source"));
      const sourceCharacter = source.store.saveCharacter(character("shared_character", "source notes"));
      const sourcePreset = source.store.savePreset({ type: "scene", name: "Snapshot scene", block: { type: "scene", tags: ["indoors"], text: "" }, tags: [], notes: "" });
      const sourceRecipe = source.store.saveRecipe({ recipe: backupRecipe(sourceCharacter.id, sourcePreset.id, "Snapshot recipe", false) });
      const sourcePrompt = compose(sourceRecipe, [sourceCharacter]).base_prompt;
      const snapshot = await source.service.exportSnapshot();

      const target = await workspace(path.join(root, "target"));
      target.store.saveCharacter({ ...character("shared_character", "target notes"), series: "", fixed_traits: ["red hair"] });
      const preview = await target.service.inspect(snapshot, { backupId: "2".repeat(64), images: [] });
      await target.service.restore(snapshot, { backupId: "2".repeat(64), expectedRevision: preview.revision, images: [], readAsset: async () => null });

      const imported = target.store.getRecipe(1);
      const localCharacter = target.store.getCharacter(1);
      expect(compose(imported, [localCharacter]).base_prompt).toBe(sourcePrompt);
      const cast = imported.blocks.find(block => block.type === "cast");
      expect(cast?.type === "cast" && cast.members[0]?.character_snapshot).toMatchObject({ id: localCharacter.id, fixed_traits: ["blue eyes"] });
      expect(target.store.getCharacter(localCharacter.id).fixed_traits).toEqual(["red hair"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not deduplicate an orphan gallery row when the incoming linked recipe is still new", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-pending-recipe-link-"));
    try {
      const source = await sourceWorkspace(path.join(root, "source"));
      const target = await workspace(path.join(root, "target"));
      target.store.saveCharacter(character("fixture_character", "source character"));
      target.store.savePreset({ type: "scene", name: "Fixture scene", block: { type: "scene", tags: ["indoors"], text: "" }, tags: ["fixture"], notes: "source preset" });

      const sourceItem = source.store.getGallery(source.generationId);
      const file = await new OutputStore(target.outputDir).write("images/orphan.png", PNG);
      const orphanId = target.store.insertGeneration({
        recipe: source.recipe, recipeId: null, seed: sourceItem.seed, width: sourceItem.width, height: sourceItem.height, rating: sourceItem.rating,
        file, outputRoot: target.outputDir, basePrompt: sourceItem.base_prompt, negative: sourceItem.negative,
        characters: sourceItem.characters ?? [], settings: sourceItem.settings ?? settings(), estimatedAnlas: sourceItem.estimatedAnlas,
      });
      target.store.db.prepare("UPDATE generations SET created_at=? WHERE id=?").run(sourceItem.created_at, orphanId);
      target.store.rateGallery(orphanId, { score: sourceItem.score, liked: sourceItem.liked, note: sourceItem.note });

      const snapshot = await makeSnapshot(source);
      const images = [image(source.generationId)];
      const preview = await target.service.inspect(snapshot, { backupId: "3".repeat(64), images });

      expect(preview.duplicates.galleryItems).toBe(0);
      await target.service.restore(snapshot, { backupId: "3".repeat(64), expectedRevision: preview.revision, images, readAsset: async () => PNG });
      const imported = target.store.getGallery(orphanId + 1);
      expect(imported.recipe_id).not.toBeNull();
      expect(imported.recipe_id).toBe(target.store.getRecipe(1).id);
      expect(target.store.listGallery({ limit: 10 }).total).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not synthesize generation-time character snapshots during restore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-legacy-generation-snapshot-"));
    try {
      const source = await workspace(path.join(root, "source"));
      const sourceCharacter = source.store.saveCharacter(character("legacy_character", "source notes"));
      const sourcePreset = source.store.savePreset({ type: "scene", name: "Legacy scene", block: { type: "scene", tags: ["indoors"], text: "" }, tags: [], notes: "" });
      const recipe = source.store.saveRecipe({ recipe: backupRecipe(sourceCharacter.id, sourcePreset.id, "Legacy recipe", false) });
      source.store.insertGeneration({
        recipe, recipeId: recipe.id, seed: 12, width: 832, height: 1216, rating: 0, file: "missing-legacy.png", outputRoot: source.outputDir,
        basePrompt: "source prompt", negative: "source negative", characters: [], settings: settings(), estimatedAnlas: 0,
      });
      const snapshot = await source.service.exportSnapshot();

      const target = await workspace(path.join(root, "target"));
      target.store.saveCharacter({ ...character("legacy_character", "target notes"), series: "", fixed_traits: ["red hair"] });
      target.store.savePreset({ type: "scene", name: "Legacy scene", block: { type: "scene", tags: ["indoors"], text: "" }, tags: [], notes: "" });
      const preview = await target.service.inspect(snapshot, { backupId: "4".repeat(64), images: [] });
      await target.service.restore(snapshot, { backupId: "4".repeat(64), expectedRevision: preview.revision, images: [], readAsset: async () => null });

      const importedRecipe = target.store.getRecipe(1);
      const importedGallery = target.store.getGallery(1);
      const recipeCast = importedRecipe.blocks.find(block => block.type === "cast");
      const galleryCast = importedGallery.recipe.blocks.find(block => block.type === "cast");
      expect(recipeCast?.type === "cast" && recipeCast.members[0]?.character_snapshot).toBeTruthy();
      expect(galleryCast?.type === "cast" && galleryCast.members[0]?.character_snapshot).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a stale preview after the target workspace changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-service-"));
    try {
      const source = await sourceWorkspace(path.join(root, "source"));
      const target = await targetWorkspace(path.join(root, "target"));
      const snapshot = await makeSnapshot(source);
      const images = [image(source.generationId)];
      const preview = await target.service.inspect(snapshot, { backupId: "b".repeat(64), images });
      target.store.saveRecipe({ recipe: { name: "Changed after preview", tags: [], rating: 0, blocks: [], source: "manual", notes: "" } });

      await expect(target.service.restore(snapshot, { backupId: "b".repeat(64), expectedRevision: preview.revision, images, readAsset: async () => PNG }))
        .rejects.toMatchObject({ data: { code: "BACKUP_PREVIEW_STALE" } });
      expect(target.store.listRecipes({ limit: 100 }).items.map(item => item.name)).toContain("Changed after preview");
      expect(target.store.listRecipes({ limit: 100 }).items.map(item => item.name)).not.toContain("Portable recipe");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rolls back database rows and copied image files when the database transaction fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-service-"));
    try {
      const source = await sourceWorkspace(path.join(root, "source"));
      const target = await targetWorkspace(path.join(root, "target"));
      const snapshot = await makeSnapshot(source);
      const images = [image(source.generationId)];
      const preview = await target.service.inspect(snapshot, { backupId: "c".repeat(64), images });
      target.store.db.exec("CREATE TRIGGER reject_backup_generation BEFORE INSERT ON generations BEGIN SELECT RAISE(FAIL, 'fixture rollback'); END;");
      const before = { recipes: target.store.listRecipes({ limit: 100 }).total, gallery: target.store.listGallery({ limit: 100 }).total };

      await expect(target.service.restore(snapshot, { backupId: "c".repeat(64), expectedRevision: preview.revision, images, readAsset: async () => PNG })).rejects.toThrow("fixture rollback");
      expect(target.store.listRecipes({ limit: 100 }).total).toBe(before.recipes);
      expect(target.store.listGallery({ limit: 100 }).total).toBe(before.gallery);
      expect(await readdir(path.join(target.outputDir, "images", "workspace-imports")).catch(() => [])).toEqual([]);
      const retry = await target.service.inspect(snapshot, { backupId: "c".repeat(64), images });
      expect(retry.alreadyImported).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a restore while generation work is active and always releases its exclusive lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-backup-service-"));
    try {
      const source = await sourceWorkspace(path.join(root, "source"));
      let active = false;
      const target = await targetWorkspace(path.join(root, "target"), () => active);
      const snapshot = await makeSnapshot(source);
      const images = [image(source.generationId)];
      const preview = await target.service.inspect(snapshot, { backupId: "d".repeat(64), images });
      active = true;

      await expect(target.service.restore(snapshot, { backupId: "d".repeat(64), expectedRevision: preview.revision, images, readAsset: async () => PNG }))
        .rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });
      expect(target.release).toHaveBeenCalledTimes(1);
      expect(target.store.listRecipes({ limit: 100 }).items.map(item => item.name)).not.toContain("Portable recipe");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
