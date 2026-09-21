import { z } from "zod";
import { Block as BlockSchema, Character as CharacterSchema, Recipe as RecipeSchema, type Block, type Character, type Composed, type Recipe } from "../lib/schema";

const rowId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const versionNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(1).max(128);
const portableRecipe = RecipeSchema;

export const WorkspaceBackupRecipeSchema = z.object({
  id: rowId,
  version: versionNumber,
  createdAt: timestamp,
  updatedAt: timestamp,
  recipe: portableRecipe,
}).strict();
export type WorkspaceBackupRecipe = z.infer<typeof WorkspaceBackupRecipeSchema>;

export const WorkspaceBackupRecipeVersionSchema = z.object({
  recipeId: rowId,
  version: versionNumber,
  createdAt: timestamp,
  note: z.string().max(20_000),
  recipe: portableRecipe,
}).strict();
export type WorkspaceBackupRecipeVersion = z.infer<typeof WorkspaceBackupRecipeVersionSchema>;

export const WorkspaceBackupCharacterSchema = z.object({
  id: rowId,
  createdAt: timestamp,
  deletedAt: timestamp.nullable(),
  character: CharacterSchema,
}).strict();
export type WorkspaceBackupCharacter = z.infer<typeof WorkspaceBackupCharacterSchema>;

export const WorkspaceBackupPresetSchema = z.object({
  id: rowId,
  type: z.enum(["style", "cast", "scene", "composition", "outfit", "expression_pose", "lighting", "motif", "text", "negative", "settings", "nsfw"]),
  name: z.string().min(1).max(500),
  builtinId: z.string().max(500).nullable(),
  hidden: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
  block: BlockSchema,
  tags: z.array(z.string().max(1000)).max(10_000),
  notes: z.string().max(20_000),
}).strict();
export type WorkspaceBackupPreset = z.infer<typeof WorkspaceBackupPresetSchema>;

export const WorkspaceBackupSettingsSchema = z.object({
  type: z.literal("settings").optional(),
  preset_id: z.number().int().positive().optional(),
  width: z.number().int().min(1).max(32_768).optional(),
  height: z.number().int().min(1).max(32_768).optional(),
  steps: z.number().int().min(1).max(50).optional(),
  scale: z.number().min(0).max(10).optional(),
  rescale: z.number().min(0).max(1).optional(),
  sampler: z.string().max(500).optional(),
  schedule: z.string().max(500).optional(),
  seed_policy: z.enum(["random", "fixed"]).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  quality_preset: z.enum(["none", "standard"]).optional(),
  uc_preset: z.enum(["heavy", "light", "none", "human_focus"]).optional(),
}).strict();
export type WorkspaceBackupSettings = z.infer<typeof WorkspaceBackupSettingsSchema>;

export const WorkspaceBackupGenerationSchema = z.object({
  id: rowId,
  recipeId: rowId.nullable(),
  recipe: portableRecipe,
  seed: z.number().int().min(0).max(4_294_967_295),
  width: z.number().int().positive().max(32_768),
  height: z.number().int().positive().max(32_768),
  rating: z.number().int().min(0).max(2),
  createdAt: timestamp,
  estimatedAnlas: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  basePrompt: z.string().max(2_000_000),
  negative: z.string().max(2_000_000),
  characters: z.array(z.object({ prompt: z.string().max(2_000_000), uc: z.string().max(2_000_000), x: z.number(), y: z.number() }).strict()).max(100),
  settings: WorkspaceBackupSettingsSchema,
  score: z.number().int().min(0).max(5).nullable(),
  liked: z.boolean(),
  note: z.string().max(20_000),
}).strict();
export type WorkspaceBackupGeneration = z.infer<typeof WorkspaceBackupGenerationSchema>;

export const WorkspaceBackupSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  recipes: z.array(WorkspaceBackupRecipeSchema).max(100_000),
  recipeVersions: z.array(WorkspaceBackupRecipeVersionSchema).max(500_000),
  characters: z.array(WorkspaceBackupCharacterSchema).max(100_000),
  presets: z.array(WorkspaceBackupPresetSchema).max(100_000),
  generations: z.array(WorkspaceBackupGenerationSchema).max(100_000),
}).strict().superRefine((snapshot, context) => {
  const duplicateId = <T extends { id: number }>(records: T[], path: string) => {
    const seen = new Set<number>();
    records.forEach((record, index) => {
      if (seen.has(record.id)) context.addIssue({ code: "custom", path: [path, index, "id"], message: "Duplicate source record ID." });
      seen.add(record.id);
    });
  };
  duplicateId(snapshot.recipes, "recipes");
  duplicateId(snapshot.characters, "characters");
  duplicateId(snapshot.presets, "presets");
  duplicateId(snapshot.generations, "generations");

  const recipeIds = new Set(snapshot.recipes.map(record => record.id));
  const recipeVersions = new Set<string>();
  snapshot.recipeVersions.forEach((record, index) => {
    if (!recipeIds.has(record.recipeId)) context.addIssue({ code: "custom", path: ["recipeVersions", index, "recipeId"], message: "Recipe version references a missing recipe." });
    const key = `${record.recipeId}:${record.version}`;
    if (recipeVersions.has(key)) context.addIssue({ code: "custom", path: ["recipeVersions", index], message: "Duplicate recipe version." });
    recipeVersions.add(key);
  });
  snapshot.generations.forEach((record, index) => {
    if (record.recipeId !== null && !recipeIds.has(record.recipeId)) context.addIssue({ code: "custom", path: ["generations", index, "recipeId"], message: "Generation references a missing recipe." });
  });

  const activeTags = new Set<string>();
  snapshot.characters.forEach((record, index) => {
    if (record.deletedAt !== null) return;
    if (activeTags.has(record.character.tag)) context.addIssue({ code: "custom", path: ["characters", index, "character", "tag"], message: "Duplicate active character tag." });
    activeTags.add(record.character.tag);
  });
  const presetNames = new Set<string>();
  snapshot.presets.forEach((record, index) => {
    const key = `${record.type}\u0000${record.name}`;
    if (presetNames.has(key)) context.addIssue({ code: "custom", path: ["presets", index], message: "Duplicate preset type and name." });
    presetNames.add(key);
  });
});
export type WorkspaceBackupSnapshot = z.infer<typeof WorkspaceBackupSnapshotSchema>;

export const WorkspaceBackupImageSchema = z.object({
  generationId: rowId,
  path: z.string().regex(/^assets\/generation-[1-9][0-9]*\.png$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(256 * 1024 * 1024),
}).strict();
export type WorkspaceBackupImage = z.infer<typeof WorkspaceBackupImageSchema>;

export const WorkspaceBackupManifestSchema = z.object({
  format: z.literal("nai-recipe-studio-workspace"),
  schemaVersion: z.literal(1),
  backupId: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: timestamp,
  appVersion: z.string().min(1).max(100),
  snapshot: WorkspaceBackupSnapshotSchema,
  images: z.array(WorkspaceBackupImageSchema).max(19_999),
}).strict().superRefine((manifest, context) => {
  const generationIds = new Set(manifest.snapshot.generations.map(item => item.id));
  const included = new Set<number>();
  const paths = new Set<string>();
  manifest.images.forEach((image, index) => {
    if (!generationIds.has(image.generationId)) context.addIssue({ code: "custom", path: ["images", index, "generationId"], message: "Image references a missing generation." });
    if (included.has(image.generationId)) context.addIssue({ code: "custom", path: ["images", index, "generationId"], message: "Duplicate generation image reference." });
    if (image.path !== `assets/generation-${image.generationId}.png`) context.addIssue({ code: "custom", path: ["images", index, "path"], message: "Image path does not match its generation ID." });
    if (paths.has(image.path)) context.addIssue({ code: "custom", path: ["images", index, "path"], message: "Duplicate image archive path." });
    included.add(image.generationId); paths.add(image.path);
  });
});
export type WorkspaceBackupManifest = z.infer<typeof WorkspaceBackupManifestSchema>;

export type WorkspaceBackupInspection = {
  revision: string;
  counts: { recipes: number; recipeVersions: number; characters: number; presets: number; galleryItems: number; images: number };
  duplicates: { recipes: number; recipeVersions: number; characters: number; presets: number; galleryItems: number; images: number };
  missingFiles: number;
  alreadyImported: boolean;
};

export type WorkspaceBackupRestoreResult = {
  restored: { recipes: number; recipeVersions: number; characters: number; presets: number; galleryItems: number; images: number };
  skipped: { recipes: number; recipeVersions: number; characters: number; presets: number; galleryItems: number; images: number };
  alreadyImported: boolean;
};

// Keep these imports as compile-time checks that the portable nested payloads
// remain aligned with the live Studio data model.
export type { Block, Character, Composed, Recipe };
