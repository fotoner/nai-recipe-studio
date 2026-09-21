import { createHash } from "node:crypto";
import { StudioSqliteStore } from "./store";
import { StudioError } from "../../contracts/studio";
import { Recipe as RecipeSchema, Character as CharacterSchema, Block as BlockSchema, type Block, type Character, type Recipe } from "../../lib/schema";
import {
  WorkspaceBackupSnapshotSchema,
  WorkspaceBackupSettingsSchema,
  type WorkspaceBackupCharacter,
  type WorkspaceBackupGeneration,
  type WorkspaceBackupImage,
  type WorkspaceBackupPreset,
  type WorkspaceBackupRecipe,
  type WorkspaceBackupRecipeVersion,
  type WorkspaceBackupSettings,
  type WorkspaceBackupSnapshot,
  type WorkspaceBackupInspection,
  type WorkspaceBackupRestoreResult,
} from "../../services/workspace-backup-contract";

const json = (value: unknown) => JSON.stringify(value);
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch {
    throw new StudioError({ code: "INVALID_BACKUP_ARCHIVE", messageKey: "errors.INVALID_BACKUP_ARCHIVE" });
  }
};

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function semanticRecipe(recipe: Recipe) {
  const { id: _id, created_at: _createdAt, updated_at: _updatedAt, ...content } = recipe;
  return content;
}

function mapCharacterId(id: number, mapping: ReadonlyMap<number, number>) {
  // A deleted/missing character may still have a complete prompt snapshot.
  // Keep it addressable without accidentally linking it to a local row that
  // happens to share the imported database's integer ID.
  return mapping.get(id) ?? (id > 0 ? -id : id);
}

function remapRecipe(
  recipe: Recipe,
  characterIds: ReadonlyMap<number, number>,
  presetIds: ReadonlyMap<number, number>,
  recipeId?: number,
  sourceCharacters: ReadonlyMap<number, Character> = new Map(),
  preserveCharacterSnapshots: ReadonlySet<number> = new Set(),
): Recipe {
  const blocks = recipe.blocks.map(block => remapBlock(block, characterIds, presetIds, sourceCharacters, preserveCharacterSnapshots));
  const { id: _sourceId, ...rest } = recipe;
  return { ...rest, ...(recipeId === undefined ? {} : { id: recipeId }), blocks };
}

function remapBlock(
  block: Block,
  characterIds: ReadonlyMap<number, number>,
  presetIds: ReadonlyMap<number, number>,
  sourceCharacters: ReadonlyMap<number, Character> = new Map(),
  preserveCharacterSnapshots: ReadonlySet<number> = new Set(),
): Block {
  const value = structuredClone(block) as Block & { preset_id?: number };
  if (value.preset_id !== undefined) {
    const mapped = presetIds.get(value.preset_id);
    if (mapped === undefined) delete value.preset_id;
    else value.preset_id = mapped;
  }
  if (value.type === "cast") {
    value.members = value.members.map(member => {
      const memberId = mapCharacterId(member.character_id, characterIds);
      const importedCharacter = sourceCharacters.get(member.character_id);
      const snapshot = member.character_snapshot ?? (importedCharacter && preserveCharacterSnapshots.has(member.character_id) ? importedCharacter : undefined);
      if (!snapshot) return { ...member, character_id: memberId };
      const snapshotSourceId = snapshot.id ?? member.character_id;
      const snapshotId = mapCharacterId(snapshotSourceId, characterIds);
      return { ...member, character_id: memberId, character_snapshot: { ...snapshot, id: snapshotId } };
    });
  }
  return value;
}

function remapSettings(settings: WorkspaceBackupSettings, presetIds: ReadonlyMap<number, number>): WorkspaceBackupSettings {
  const value = structuredClone(settings);
  if (value.preset_id !== undefined) {
    const mapped = presetIds.get(value.preset_id);
    if (mapped === undefined) delete value.preset_id;
    else value.preset_id = mapped;
  }
  return value;
}

function recipeHistoryKey(
  recipe: Recipe,
  versions: Array<{ version: number; note: string; recipe: Recipe }>,
  characterIds: ReadonlyMap<number, number>,
  presetIds: ReadonlyMap<number, number>,
  sourceCharacters: ReadonlyMap<number, Character> = new Map(),
  preserveCharacterSnapshots: ReadonlySet<number> = new Set(),
) {
  const current = remapRecipe(recipe, characterIds, presetIds, undefined, sourceCharacters, preserveCharacterSnapshots);
  const history = [...versions].sort((left, right) => left.version - right.version).map(version => ({
    version: version.version,
    note: version.note,
    recipe: semanticRecipe(remapRecipe(version.recipe, characterIds, presetIds, undefined, sourceCharacters, preserveCharacterSnapshots)),
  }));
  return canonical({ current: semanticRecipe(current), history });
}

function emptyCounts() {
  return { recipes: 0, recipeVersions: 0, characters: 0, presets: 0, galleryItems: 0, images: 0 };
}

export type WorkspaceBackupAnalysis = {
  inspection: WorkspaceBackupInspection;
  characterIds: Map<number, number>;
  presetIds: Map<number, number>;
  recipeIds: Map<number, number>;
  duplicateCharacterIds: Set<number>;
  duplicatePresetIds: Set<number>;
  duplicateRecipeIds: Set<number>;
  duplicateGenerationIds: Set<number>;
  imageGenerationIds: Set<number>;
  sourceCharacters: Map<number, Character>;
  preserveCharacterSnapshots: Set<number>;
};

export type WorkspaceBackupFileMap = ReadonlyMap<number, string>;

/** Portable data and additive merge operations over the existing Studio schema. */
export class SqliteWorkspaceBackupAdapter {
  constructor(private readonly store: StudioSqliteStore) {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_backup_imports (
      backup_id TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    )`);
  }

  exportSnapshot(): WorkspaceBackupSnapshot {
    const db = this.store.db;
    const recipes = (db.prepare("SELECT * FROM recipes ORDER BY id").all() as Record<string, unknown>[]).map(row => {
      const recipe = RecipeSchema.parse({
        id: Number(row.id), name: String(row.name), tags: parseJson(row.tags, [] as string[]), rating: Number(row.rating),
        blocks: parseJson(row.blocks, [] as unknown[]), source: String(row.source), notes: String(row.notes),
        created_at: String(row.created_at), updated_at: String(row.updated_at),
      });
      return { id: Number(row.id), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), recipe } satisfies WorkspaceBackupRecipe;
    });
    const recipeVersions = (db.prepare("SELECT recipe_id, version, recipe, note, created_at FROM recipe_versions ORDER BY recipe_id, version").all() as Record<string, unknown>[]).map(row => ({
      recipeId: Number(row.recipe_id), version: Number(row.version), createdAt: String(row.created_at), note: String(row.note ?? ""),
      recipe: RecipeSchema.parse(parseJson(row.recipe, {})),
    } satisfies WorkspaceBackupRecipeVersion));
    const characters = (db.prepare("SELECT * FROM characters ORDER BY id").all() as Record<string, unknown>[]).map(row => {
      const character = CharacterSchema.parse({
        id: Number(row.id), tag: String(row.tag), series: String(row.series), display_name: String(row.display_name), gender: row.gender,
        age_flag: row.age_flag, locked: !!row.locked, fixed_traits: parseJson(row.fixed_traits, [] as string[]),
        default_x: Number(row.default_x), default_y: Number(row.default_y), notes: String(row.notes),
      });
      return { id: Number(row.id), createdAt: String(row.created_at), deletedAt: row.deleted_at == null ? null : String(row.deleted_at), character } satisfies WorkspaceBackupCharacter;
    });
    const presets = (db.prepare("SELECT * FROM presets ORDER BY id").all() as Record<string, unknown>[]).map(row => ({
      id: Number(row.id), type: String(row.type) as WorkspaceBackupPreset["type"], name: String(row.name), builtinId: row.builtin_id == null ? null : String(row.builtin_id),
      hidden: !!row.hidden, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      block: BlockSchema.parse(parseJson(row.block, {})), tags: parseJson(row.tags, [] as string[]), notes: String(row.notes),
    } satisfies WorkspaceBackupPreset));
    const generations = (db.prepare(`SELECT g.*, rt.score, rt.liked, rt.note
      FROM generations g LEFT JOIN ratings rt ON rt.generation_id=g.id ORDER BY g.id`).all() as Record<string, unknown>[]).map(row => ({
      id: Number(row.id), recipeId: row.recipe_id == null ? null : Number(row.recipe_id),
      recipe: RecipeSchema.parse(parseJson(row.recipe, {})), seed: Number(row.seed), width: Number(row.width), height: Number(row.height), rating: Number(row.rating),
      createdAt: String(row.created_at), estimatedAnlas: Number(row.estimated_anlas), basePrompt: String(row.base_prompt), negative: String(row.negative),
      characters: parseJson(row.characters, [] as WorkspaceBackupGeneration["characters"]),
      settings: parseBackupSettings(row.settings),
      score: row.score == null ? null : Number(row.score), liked: !!row.liked, note: String(row.note ?? ""),
    } satisfies WorkspaceBackupGeneration));

    return WorkspaceBackupSnapshotSchema.parse({ schemaVersion: 1, recipes, recipeVersions, characters, presets, generations });
  }

  listGenerationIds() {
    return (this.store.db.prepare("SELECT id FROM generations ORDER BY id").all() as Array<{ id: number }>).map(row => Number(row.id));
  }

  revision(imageHashes: ReadonlyMap<number, string | null>) {
    const imported = (this.store.db.prepare("SELECT backup_id FROM workspace_backup_imports ORDER BY backup_id").all() as Array<{ backup_id: string }>).map(row => row.backup_id);
    const hashes = [...imageHashes.entries()].sort(([left], [right]) => left - right).map(([id, hash]) => [id, hash]);
    return sha256(canonical({ workspace: this.exportSnapshot(), imported, imageHashes: hashes }));
  }

  alreadyImported(backupId: string) {
    return !!this.store.db.prepare("SELECT 1 FROM workspace_backup_imports WHERE backup_id=?").get(backupId);
  }

  analyze(snapshot: WorkspaceBackupSnapshot, backupId: string, images: WorkspaceBackupImage[], imageHashes: ReadonlyMap<number, string | null>): WorkspaceBackupAnalysis {
    const normalizedSnapshot = WorkspaceBackupSnapshotSchema.parse(snapshot);
    const db = this.store.db;
    const targetCharacters = db.prepare("SELECT * FROM characters ORDER BY id DESC").all() as Record<string, unknown>[];
    const activeCharacterByTag = new Map<string, Record<string, unknown>>();
    const deletedCharacterByTag = new Map<string, Record<string, unknown>>();
    for (const row of targetCharacters) {
      const target = row.deleted_at == null ? activeCharacterByTag : deletedCharacterByTag;
      const tag = String(row.tag);
      if (!target.has(tag)) target.set(tag, row);
    }
    const characterIds = new Map<number, number>();
    const duplicateCharacterIds = new Set<number>();
    const sourceCharacters = new Map(normalizedSnapshot.characters.map(record => [record.id, record.character]));
    const preserveCharacterSnapshots = new Set<number>();
    for (const character of normalizedSnapshot.characters) {
      const targetRow = activeCharacterByTag.get(character.character.tag)
        ?? (character.deletedAt !== null ? deletedCharacterByTag.get(character.character.tag) : undefined);
      if (targetRow) {
        const targetCharacter = characterFromDbRow(targetRow);
        characterIds.set(character.id, Number(targetRow.id));
        duplicateCharacterIds.add(character.id);
        if (characterKey(character.character) !== characterKey(targetCharacter)) preserveCharacterSnapshots.add(character.id);
      }
    }

    const targetPresets = db.prepare("SELECT id, type, name, builtin_id FROM presets ORDER BY id").all() as Array<{ id: number; type: string; name: string; builtin_id: string | null }>;
    const presetIds = new Map<number, number>();
    const duplicatePresetIds = new Set<number>();
    for (const preset of normalizedSnapshot.presets) {
      const target = (preset.builtinId ? targetPresets.find(row => row.builtin_id === preset.builtinId) : undefined)
        ?? targetPresets.find(row => row.type === preset.type && row.name === preset.name);
      if (target) { presetIds.set(preset.id, Number(target.id)); duplicatePresetIds.add(preset.id); }
    }

    const sourceVersionsByRecipe = versionsByRecipe(normalizedSnapshot.recipeVersions);
    const targetRecipes = (db.prepare("SELECT * FROM recipes ORDER BY id").all() as Record<string, unknown>[]).map(row => ({ row, recipe: recipeFromDbRow(row) }));
    const targetCharacterIds = new Map(targetCharacters.map(row => [Number(row.id), Number(row.id)]));
    const targetPresetIds = new Map(targetPresets.map(row => [Number(row.id), Number(row.id)]));
    const targetVersions = versionsByRecipe((db.prepare("SELECT recipe_id, version, recipe, note, created_at FROM recipe_versions ORDER BY recipe_id, version").all() as Record<string, unknown>[]).map(row => ({
      recipeId: Number(row.recipe_id), version: Number(row.version), createdAt: String(row.created_at), note: String(row.note ?? ""), recipe: RecipeSchema.parse(parseJson(row.recipe, {})),
    })));
    const recipeIds = new Map<number, number>();
    const duplicateRecipeIds = new Set<number>();
    for (const recipe of normalizedSnapshot.recipes) {
      const sourceKey = recipeHistoryKey(recipe.recipe, sourceVersionsByRecipe.get(recipe.id) ?? [], characterIds, presetIds, sourceCharacters, preserveCharacterSnapshots);
      const target = targetRecipes.find(candidate => recipeHistoryKey(candidate.recipe, targetVersions.get(Number(candidate.row.id)) ?? [], targetCharacterIds, targetPresetIds) === sourceKey);
      if (target) { recipeIds.set(recipe.id, Number(target.row.id)); duplicateRecipeIds.add(recipe.id); }
    }

    const imageByGeneration = new Map(images.map(image => [image.generationId, image]));
    const targetGallery = (db.prepare(`SELECT g.*, rt.score, rt.liked, rt.note
      FROM generations g LEFT JOIN ratings rt ON rt.generation_id=g.id ORDER BY g.id`).all() as Record<string, unknown>[]).map(row => ({
      id: Number(row.id), recipeId: row.recipe_id == null ? null : Number(row.recipe_id), recipe: RecipeSchema.parse(parseJson(row.recipe, {})),
      seed: Number(row.seed), width: Number(row.width), height: Number(row.height), rating: Number(row.rating), createdAt: String(row.created_at),
      estimatedAnlas: Number(row.estimated_anlas), basePrompt: String(row.base_prompt), negative: String(row.negative),
      characters: parseJson(row.characters, [] as WorkspaceBackupGeneration["characters"]),
      settings: parseBackupSettings(row.settings),
      score: row.score == null ? null : Number(row.score), liked: !!row.liked, note: String(row.note ?? ""),
      imageHash: imageHashes.get(Number(row.id)) ?? null,
    }));
    const duplicateGenerationIds = new Set<number>();
    for (const generation of normalizedSnapshot.generations) {
      // A new imported recipe needs its own gallery relationship. An orphan or
      // another recipe's image cannot stand in for that relationship.
      if (generation.recipeId !== null && !recipeIds.has(generation.recipeId)) continue;
      const mappedRecipeId = generation.recipeId === null ? null : recipeIds.get(generation.recipeId) ?? null;
      const sourceImageHash = imageByGeneration.get(generation.id)?.sha256;
      const semanticKey = gallerySemanticKey(generation, remapRecipe(generation.recipe, characterIds, presetIds, mappedRecipeId ?? undefined), mappedRecipeId, presetIds);
      const isDuplicate = targetGallery.some(target => {
        if (gallerySemanticKey(target, target.recipe, target.recipeId, targetPresetIds) !== semanticKey) return false;
        return sourceImageHash === undefined || target.imageHash === sourceImageHash;
      });
      if (isDuplicate) duplicateGenerationIds.add(generation.id);
    }

    const counts = {
      recipes: normalizedSnapshot.recipes.length,
      recipeVersions: normalizedSnapshot.recipeVersions.length,
      characters: normalizedSnapshot.characters.length,
      presets: normalizedSnapshot.presets.length,
      galleryItems: normalizedSnapshot.generations.length,
      images: images.length,
    };
    const duplicates = {
      recipes: duplicateRecipeIds.size,
      recipeVersions: normalizedSnapshot.recipeVersions.filter(version => duplicateRecipeIds.has(version.recipeId)).length,
      characters: duplicateCharacterIds.size,
      presets: duplicatePresetIds.size,
      galleryItems: duplicateGenerationIds.size,
      images: images.filter(image => [...imageHashes.values()].includes(image.sha256)).length,
    };
    const inspection: WorkspaceBackupInspection = {
      revision: this.revision(imageHashes), counts, duplicates,
      missingFiles: normalizedSnapshot.generations.filter(generation => !imageByGeneration.has(generation.id)).length,
      alreadyImported: this.alreadyImported(backupId),
    };
    return {
      inspection, characterIds, presetIds, recipeIds, duplicateCharacterIds, duplicatePresetIds,
      duplicateRecipeIds, duplicateGenerationIds, imageGenerationIds: new Set(imageByGeneration.keys()),
      sourceCharacters, preserveCharacterSnapshots,
    };
  }

  restore(snapshot: WorkspaceBackupSnapshot, backupId: string, analysis: WorkspaceBackupAnalysis, imageFiles: WorkspaceBackupFileMap, outputRoot: string): WorkspaceBackupRestoreResult {
    const db = this.store.db;
    const restored = emptyCounts();
    const skipped = emptyCounts();
    const characterIds = new Map(analysis.characterIds);
    const presetIds = new Map(analysis.presetIds);
    const recipeIds = new Map(analysis.recipeIds);
    const stamp = new Date().toISOString();

    const transaction = db.transaction(() => {
      if (this.alreadyImported(backupId)) return { alreadyImported: true, restored, skipped: analysis.inspection.counts };

      for (const record of snapshot.characters) {
        if (analysis.duplicateCharacterIds.has(record.id)) { skipped.characters += 1; continue; }
        const char = record.character;
        const historicalLocked = !!(db.prepare("SELECT locked FROM characters WHERE tag=? ORDER BY id DESC LIMIT 1").get(char.tag) as { locked?: number } | undefined)?.locked;
        const result = db.prepare(`INSERT INTO characters (tag, series, display_name, gender, age_flag, locked, fixed_traits, default_x, default_y, notes, created_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(char.tag, char.series, char.display_name, char.gender, char.age_flag, char.locked || historicalLocked ? 1 : 0, json(char.fixed_traits), char.default_x, char.default_y, char.notes, record.createdAt, record.deletedAt);
        characterIds.set(record.id, Number(result.lastInsertRowid));
        restored.characters += 1;
      }

      for (const record of snapshot.presets) {
        if (analysis.duplicatePresetIds.has(record.id)) { skipped.presets += 1; continue; }
        const result = db.prepare(`INSERT INTO presets (type, name, builtin_id, hidden, block, tags, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.type, record.name, record.builtinId, record.hidden ? 1 : 0, json(record.block), json(record.tags), record.notes, record.createdAt, record.updatedAt);
        presetIds.set(record.id, Number(result.lastInsertRowid));
        restored.presets += 1;
      }

      for (const record of snapshot.presets) {
        if (analysis.duplicatePresetIds.has(record.id)) continue;
        const presetId = presetIds.get(record.id);
        if (presetId === undefined) continue;
        const block = remapBlock(record.block, characterIds, presetIds, analysis.sourceCharacters, analysis.preserveCharacterSnapshots);
        db.prepare("UPDATE presets SET block=? WHERE id=?").run(json(block), presetId);
      }

      const snapshotVersions = versionsByRecipe(snapshot.recipeVersions);
      for (const record of snapshot.recipes) {
        if (analysis.duplicateRecipeIds.has(record.id)) { skipped.recipes += 1; skipped.recipeVersions += snapshotVersions.get(record.id)?.length ?? 0; continue; }
        const recipe = remapRecipe(record.recipe, characterIds, presetIds, undefined, analysis.sourceCharacters, analysis.preserveCharacterSnapshots);
        const result = db.prepare(`INSERT INTO recipes (name, tags, rating, blocks, source, notes, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(recipe.name, json(recipe.tags), recipe.rating, json(recipe.blocks), recipe.source, recipe.notes, record.version, record.createdAt, record.updatedAt);
        const recipeId = Number(result.lastInsertRowid);
        recipeIds.set(record.id, recipeId);
        for (const version of snapshotVersions.get(record.id) ?? []) {
          const versionRecipe = remapRecipe(version.recipe, characterIds, presetIds, recipeId, analysis.sourceCharacters, analysis.preserveCharacterSnapshots);
          const payload = { ...versionRecipe, id: recipeId, version: version.version, created_at: version.recipe.created_at ?? record.createdAt, updated_at: version.recipe.updated_at ?? version.createdAt };
          db.prepare("INSERT INTO recipe_versions (recipe_id, version, recipe, note, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(recipeId, version.version, json(payload), version.note, version.createdAt);
          restored.recipeVersions += 1;
        }
        restored.recipes += 1;
      }

      for (const generation of snapshot.generations) {
        if (analysis.duplicateGenerationIds.has(generation.id)) {
          skipped.galleryItems += 1;
          if (analysis.imageGenerationIds.has(generation.id)) skipped.images += 1;
          continue;
        }
        const recipeId = generation.recipeId === null ? null : recipeIds.get(generation.recipeId) ?? null;
        const recipe = remapRecipe(generation.recipe, characterIds, presetIds, recipeId ?? undefined);
        const settings = remapSettings(generation.settings, presetIds);
        const file = imageFiles.get(generation.id) ?? `images/missing-imports/${backupId.slice(0, 16)}/generation-${generation.id}.png`;
        const result = db.prepare(`INSERT INTO generations (recipe_id, recipe, seed, width, height, rating, file, base_prompt, negative, characters, settings, estimated_anlas, output_root, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(recipeId, json(recipe), generation.seed, generation.width, generation.height, generation.rating, file, generation.basePrompt, generation.negative, json(generation.characters), json(settings), generation.estimatedAnlas, outputRoot, generation.createdAt);
        const generationId = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO ratings (generation_id, score, liked, note) VALUES (?, ?, ?, ?)")
          .run(generationId, generation.score, generation.liked ? 1 : 0, generation.note);
        restored.galleryItems += 1;
        if (imageFiles.has(generation.id)) restored.images += 1;
      }

      db.prepare("INSERT INTO workspace_backup_imports (backup_id, imported_at) VALUES (?, ?)").run(backupId, stamp);
      return { alreadyImported: false, restored, skipped };
    });
    return transaction() as WorkspaceBackupRestoreResult;
  }
}

function recipeFromDbRow(row: Record<string, unknown>): Recipe {
  return RecipeSchema.parse({
    id: Number(row.id), name: String(row.name), tags: parseJson(row.tags, [] as string[]), rating: Number(row.rating),
    blocks: parseJson(row.blocks, [] as unknown[]), source: String(row.source), notes: String(row.notes),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  });
}

function characterFromDbRow(row: Record<string, unknown>): Character {
  return CharacterSchema.parse({
    id: Number(row.id), tag: String(row.tag), series: String(row.series), display_name: String(row.display_name), gender: row.gender,
    age_flag: row.age_flag, locked: !!row.locked, fixed_traits: parseJson(row.fixed_traits, [] as string[]),
    default_x: Number(row.default_x), default_y: Number(row.default_y), notes: String(row.notes),
  });
}

function characterKey(character: Character) {
  const { id: _id, ...content } = character;
  return canonical(content);
}

function parseBackupSettings(value: unknown): WorkspaceBackupSettings {
  // Older generation rows can omit the discriminator and optional fields.
  // The strict workspace schema keeps only the known generation settings.
  const source = typeof value === "string" ? parseJson<Record<string, unknown>>(value, {}) : value;
  const candidate = source && typeof source === "object" ? { ...(source as Record<string, unknown>) } : {};
  if (candidate.type === undefined) delete candidate.type;
  return WorkspaceBackupSettingsSchema.parse(candidate);
}

function versionsByRecipe(versions: WorkspaceBackupRecipeVersion[]): Map<number, Array<{ version: number; note: string; recipe: Recipe; createdAt: string }>> {
  const grouped = new Map<number, Array<{ version: number; note: string; recipe: Recipe; createdAt: string }>>();
  for (const version of versions) {
    const group = grouped.get(version.recipeId) ?? [];
    group.push({ version: version.version, note: version.note, recipe: version.recipe, createdAt: version.createdAt });
    grouped.set(version.recipeId, group);
  }
  return grouped;
}

function gallerySemanticKey(
  generation: WorkspaceBackupGeneration | Record<string, unknown>,
  recipe: Recipe,
  recipeId: number | null,
  presetIds: ReadonlyMap<number, number>,
) {
  const source = generation as WorkspaceBackupGeneration & Record<string, unknown>;
  const settings = "settings" in source ? remapSettings(source.settings as WorkspaceBackupSettings, presetIds) : undefined;
  return canonical({
    recipeId,
    recipe: semanticRecipe(recipe),
    seed: source.seed,
    width: source.width,
    height: source.height,
    rating: source.rating,
    createdAt: source.createdAt ?? source.created_at,
    estimatedAnlas: source.estimatedAnlas ?? source.estimated_anlas,
    basePrompt: source.basePrompt ?? source.base_prompt,
    negative: source.negative,
    characters: source.characters,
    settings,
    score: source.score ?? null,
    liked: !!source.liked,
    note: source.note ?? "",
  });
}

export type { Character, Recipe };
