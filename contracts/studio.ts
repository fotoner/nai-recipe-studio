import { z } from "zod";
import type { Block, BlockPreset, Character, Composed, Recipe } from "../lib/schema";

export type { Block, BlockPreset, Character, Composed, Recipe };
export const APP_NAME = "NAI Recipe Studio";
export const APP_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;
export type Language = "system" | "ko" | "ja" | "en";
export type StoredRecipe = Recipe & { id: number; version: number; created_at: string; updated_at: string; latest?: GalleryItem; generation_count?: number };
export type StoredCharacter = Character & { id: number; created_at: string };
export type StoredPreset = BlockPreset & { id: number; builtinId?: string; nameKey?: string; descriptionKey?: string; hidden?: boolean };
export type Page<T> = { items: T[]; total: number };
export type ListInput = { query?: string; limit?: number; offset?: number };
export type GalleryListInput = ListInput & { recipeId?: number; ratingMax?: number; liked?: boolean; sort?: "newest" | "oldest"; characterIds?: number[]; presetIds?: number[] };
export type Finding = { code: string; messageKey: string; params?: Record<string, string | number>; severity: "error" | "warn" | "info"; block?: string; fixable: boolean };
export type RecipeVersion = { version: number; recipe: Recipe; created_at: string; note: string };
export type AccountStatus = { tier: "opus" | "other" | "unknown"; anlas: number | null; usagePercent: number | null; checkedAt: string; active?: boolean; usageAvailable?: boolean };
export type StudioStatus = { appVersion: string; schemaVersion: number; connected: boolean; account: AccountStatus | null; dryRun: boolean; locale: string };
export type Settings = { language: Language; blurSensitive: boolean; outputDirectory: string };
export type GenerationPlan = { id: string; recipe: Recipe; count: number; seeds: number[]; estimatedAnlas: number | null; findings: Finding[]; expiresAt: string; approved: boolean; account: AccountStatus | null; connectionId?: string; connectionName?: string };
export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type GenerationJob = { id: string; planId: string; state: JobState; total: number; completed: number; generationIds: number[]; error?: StudioErrorData; created_at: string };
export type GalleryItem = { id: number; recipe_id: number | null; recipe_name: string; recipe: Recipe; seed: number; width: number; height: number; rating: number; url: string; created_at: string; estimatedAnlas: number; score: number | null; liked: boolean; note: string; base_prompt: string; negative: string; characters?: Composed["characters"]; settings?: Composed["settings"] };
export type Connection = { id: string; name: string; permissions: { read: boolean; write: boolean; generate: boolean; images: boolean }; maxImages: number; maxAnlas: number; created_at: string };
export type SetupTarget = "codex" | "claude-desktop";
export type SetupStatus = { target: SetupTarget; available: boolean; mcpInstalled: boolean; skillInstalled: boolean; skillSupported: boolean; version: string | null; configPath: string; skillPath: string | null; messageKey?: string };
export type StudioEvent = { type: "workspace.changed"; entity: "recipes" | "characters" | "presets" | "gallery"; ids?: number[] } | { type: "job.changed"; job: GenerationJob } | { type: "settings.changed"; settings: Settings } | { type: "generation.prepared"; plan: GenerationPlan };
export type StudioErrorData = { code: string; messageKey: string; params?: Record<string, string | number>; retryable?: boolean };
export class StudioError extends Error {
  constructor(public readonly data: StudioErrorData) { super(data.code); this.name = "StudioError"; }
}

export interface StudioCommands {
  "status.read": { input: Record<string, never>; output: StudioStatus };
  "recipes.list": { input: ListInput; output: Page<StoredRecipe> };
  "recipes.get": { input: { id: number }; output: StoredRecipe };
  "recipes.save": { input: { recipe: Recipe; expectedVersion?: number; note?: string }; output: StoredRecipe };
  "recipes.duplicate": { input: { id: number; name: string }; output: StoredRecipe };
  "recipes.delete": { input: { id: number }; output: { deleted: boolean } };
  "recipes.versions": { input: { id: number }; output: RecipeVersion[] };
  "characters.list": { input: ListInput; output: Page<StoredCharacter> };
  "characters.save": { input: { character: Character }; output: StoredCharacter };
  "characters.delete": { input: { id: number }; output: { deleted: boolean } };
  "presets.list": { input: ListInput & { type?: string; includeHidden?: boolean }; output: Page<StoredPreset> };
  "presets.save": { input: { preset: BlockPreset }; output: StoredPreset };
  "presets.delete": { input: { id: number }; output: { deleted: boolean } };
  "recipe.compose": { input: { recipe: Recipe }; output: Composed };
  "recipe.validate": { input: { recipe: Recipe; fixes?: string[] }; output: { findings: Finding[]; recipe: Recipe; applied: string[] } };
  "generation.prepare": { input: { recipe: Recipe; count: number; seed?: number }; output: GenerationPlan };
  "generation.pending": { input: Record<string, never>; output: GenerationPlan[] };
  "generation.approve": { input: { planId: string }; output: GenerationPlan };
  "generation.start": { input: { planId: string; requestId: string }; output: GenerationJob };
  "generation.status": { input: { id: string }; output: GenerationJob };
  "generation.list": { input: Record<string, never>; output: GenerationJob[] };
  "generation.cancel": { input: { id: string }; output: GenerationJob };
  "gallery.list": { input: GalleryListInput; output: Page<GalleryItem> };
  "gallery.get": { input: { id: number }; output: GalleryItem };
  "gallery.rate": { input: { id: number; score?: number | null; liked?: boolean; note?: string }; output: GalleryItem };
  "gallery.delete": { input: { id: number }; output: { deleted: boolean } };
  "gallery.export": { input: { id: number; includeMetadata?: boolean }; output: { saved: boolean } };
  "settings.get": { input: Record<string, never>; output: Settings };
  "settings.update": { input: Partial<Settings>; output: Settings };
  "credentials.set": { input: { token: string }; output: { connected: boolean } };
  "credentials.clear": { input: Record<string, never>; output: { connected: boolean } };
  "credentials.test": { input: Record<string, never>; output: StudioStatus };
  "files.importRecipe": { input: Record<string, never>; output: { recipe: Recipe | null; warnings: string[] } };
  "files.exportRecipe": { input: { recipe: Recipe }; output: { saved: boolean } };
  "files.chooseOutput": { input: Record<string, never>; output: { path: string | null } };
  "files.openOutput": { input: Record<string, never>; output: { opened: boolean } };
  "help.open": { input: { page: "novelai" | "token" }; output: { opened: boolean } };
  "ai.connections.list": { input: Record<string, never>; output: Connection[] };
  "ai.connections.create": { input: { name: string; permissions: Connection["permissions"]; maxImages: number; maxAnlas: number }; output: Connection };
  "ai.connections.revoke": { input: { id: string }; output: { revoked: boolean } };
  "setup.inspect": { input: { target: SetupTarget }; output: SetupStatus };
  "setup.install": { input: { target: SetupTarget; connectionId: string }; output: SetupStatus };
  "setup.uninstall": { input: { target: SetupTarget }; output: SetupStatus };
}
export type Command = keyof StudioCommands;
export type CommandInput<K extends Command> = StudioCommands[K]["input"];
export type CommandOutput<K extends Command> = StudioCommands[K]["output"];
export interface StudioClient {
  call<K extends Command>(command: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  subscribe(listener: (event: StudioEvent) => void): () => void;
}
export type CallContext = { source: "ui" | "mcp"; connection?: Connection };

const empty = z.object({}).strict();
const id = z.object({ id: z.number().int().positive() }).strict();
const jobId = z.object({ id: z.string().min(1).max(200) }).strict();
const list = z.object({ query: z.string().max(500).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }).strict();
const payload = z.custom<Recipe>(value => !!value && typeof value === "object" && !Array.isArray(value));
const target = z.enum(["codex", "claude-desktop"]);
const permission = z.object({ read: z.boolean(), write: z.boolean(), generate: z.boolean(), images: z.boolean() }).strict();
export const commandInputSchemas: Record<Command, z.ZodType> = {
  "status.read": empty,
  "recipes.list": list,
  "recipes.get": id,
  "recipes.save": z.object({ recipe: payload, expectedVersion: z.number().int().positive().optional(), note: z.string().max(2000).optional() }).strict(),
  "recipes.duplicate": id.extend({ name: z.string().min(1).max(200) }),
  "recipes.delete": id,
  "recipes.versions": id,
  "characters.list": list,
  "characters.save": z.object({ character: z.object({}).passthrough() }).strict(),
  "characters.delete": id,
  "presets.list": list.extend({ type: z.string().optional(), includeHidden: z.boolean().optional() }),
  "presets.save": z.object({ preset: z.object({}).passthrough() }).strict(),
  "presets.delete": id,
  "recipe.compose": z.object({ recipe: payload }).strict(),
  "recipe.validate": z.object({ recipe: payload, fixes: z.array(z.string()).max(100).optional() }).strict(),
  "generation.prepare": z.object({ recipe: payload, count: z.number().int().min(1).max(200), seed: z.number().int().min(0).max(4294967295).optional() }).strict(),
  "generation.pending": empty,
  "generation.approve": z.object({ planId: z.string().min(1).max(200) }).strict(),
  "generation.start": z.object({ planId: z.string().min(1).max(200), requestId: z.string().min(1).max(200) }).strict(),
  "generation.status": jobId,
  "generation.list": empty,
  "generation.cancel": jobId,
  "gallery.list": list.extend({ recipeId: z.number().int().positive().optional(), ratingMax: z.number().int().min(0).max(2).optional(), liked: z.boolean().optional(), sort: z.enum(["newest", "oldest"]).optional(), characterIds: z.array(z.number().int().positive()).max(100).optional(), presetIds: z.array(z.number().int().positive()).max(100).optional() }),
  "gallery.get": id,
  "gallery.rate": id.extend({ score: z.number().int().min(0).max(5).nullable().optional(), liked: z.boolean().optional(), note: z.string().max(10000).optional() }),
  "gallery.delete": id,
  "gallery.export": id.extend({ includeMetadata: z.boolean().optional() }),
  "settings.get": empty,
  "settings.update": z.object({ language: z.enum(["system", "ko", "ja", "en"]).optional(), blurSensitive: z.boolean().optional(), outputDirectory: z.string().min(1).optional() }).strict(),
  "credentials.set": z.object({ token: z.string().trim().min(1).max(10000) }).strict(),
  "credentials.clear": empty,
  "credentials.test": empty,
  "files.importRecipe": empty,
  "files.exportRecipe": z.object({ recipe: payload }).strict(),
  "files.chooseOutput": empty,
  "files.openOutput": empty,
  "help.open": z.object({ page: z.enum(["novelai", "token"]) }).strict(),
  "ai.connections.list": empty,
  "ai.connections.create": z.object({ name: z.string().min(1).max(100), permissions: permission, maxImages: z.number().int().min(0).max(200), maxAnlas: z.number().int().min(0).max(100000) }).strict(),
  "ai.connections.revoke": jobId,
  "setup.inspect": z.object({ target }).strict(),
  "setup.install": z.object({ target, connectionId: z.string().min(1).max(200) }).strict(),
  "setup.uninstall": z.object({ target }).strict(),
};

export function parseCommandInput<K extends Command>(command: K, input: unknown): CommandInput<K> {
  if (!Object.hasOwn(commandInputSchemas, command)) throw new StudioError({ code: "UNKNOWN_COMMAND", messageKey: "errors.UNKNOWN_COMMAND" });
  const schema = commandInputSchemas[command];
  if (!schema) throw new StudioError({ code: "UNKNOWN_COMMAND", messageKey: "errors.UNKNOWN_COMMAND" });
  const result = schema.safeParse(input);
  if (!result.success) throw new StudioError({ code: "VALIDATION_FAILED", messageKey: "errors.VALIDATION_FAILED" });
  return result.data as CommandInput<K>;
}
