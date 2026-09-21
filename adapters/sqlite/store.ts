import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AccountStatus, Composed, GenerationExample, GenerationJob, GenerationPlan, GalleryItem, GalleryListInput, Page, RecipeVersion, StoredCharacter, StoredPreset, StoredRecipe } from "../../contracts/studio";
import type { BlockPreset, Character, Recipe } from "../../lib/schema";
import type { RecipeProposal, RecipeProposalChange } from "../../contracts/proposals";
import { PUBLIC_PALETTE } from "../../core/palette";
import { createPresetMatcher, indexGenerationForPresets, matchesPreset } from "../../core/palette/matching";

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" && value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const now = () => new Date().toISOString();

export class SqliteConflictError extends Error {
  constructor(message = "The stored version changed.") { super(message); this.name = "SqliteConflictError"; }
}

export class SqliteNotFoundError extends Error {
  constructor(message = "The requested item was not found.") { super(message); this.name = "SqliteNotFoundError"; }
}

export class SqliteSchemaError extends Error {
  constructor(message = "The workspace database schema is not supported by this app.") { super(message); this.name = "SqliteSchemaError"; }
}

export const SQLITE_SCHEMA_VERSION = 2;

export type StoredGeneration = {
  id: number;
  recipe_id: number | null;
  recipe_name: string;
  recipe: Recipe;
  seed: number;
  width: number;
  height: number;
  rating: number;
  file: string;
  output_root: string;
  created_at: string;
  estimatedAnlas: number;
  score: number | null;
  liked: boolean;
  note: string;
  base_prompt: string;
  negative: string;
  characters: unknown[];
  settings: Record<string, unknown> | null;
};

export type StoredPlanRow = GenerationPlan & { composed: Record<string, unknown>; created_at: string };

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT NOT NULL,
  rating INTEGER NOT NULL,
  blocks TEXT NOT NULL,
  source TEXT NOT NULL,
  notes TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_versions (
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  recipe TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, version)
);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY,
  tag TEXT NOT NULL,
  series TEXT NOT NULL,
  display_name TEXT NOT NULL,
  gender TEXT NOT NULL,
  age_flag TEXT NOT NULL,
  locked INTEGER NOT NULL,
  fixed_traits TEXT NOT NULL,
  default_x REAL NOT NULL,
  default_y REAL NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS characters_active_idx ON characters(deleted_at, tag);
CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  builtin_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  block TEXT NOT NULL,
  tags TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(type, name)
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  recipe TEXT NOT NULL,
  count INTEGER NOT NULL,
  seeds TEXT NOT NULL,
  estimated_anlas INTEGER,
  findings TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  account TEXT,
  connection_id TEXT,
  connection_name TEXT,
  composed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  total INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  generation_ids TEXT NOT NULL,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_plan_idx ON jobs(plan_id);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at DESC);
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
  recipe TEXT NOT NULL,
  seed INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  file TEXT NOT NULL,
  base_prompt TEXT NOT NULL,
  negative TEXT NOT NULL,
  characters TEXT NOT NULL,
  settings TEXT NOT NULL,
  estimated_anlas INTEGER NOT NULL,
  output_root TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS generations_recipe_idx ON generations(recipe_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ratings (
  generation_id INTEGER PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
  score INTEGER,
  liked INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_proposals (
  id TEXT PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL,
  application_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  connection_id TEXT,
  connection_name TEXT,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_proposals_recipe_idx ON recipe_proposals(recipe_id, created_at DESC);
`;

export class StudioSqliteStore {
  readonly db: Database.Database;

  constructor(readonly dataDir: string) {
    // The caller has to provide an explicit profile directory. This is the only
    // place where a database path is resolved; no cwd/env discovery occurs.
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, "studio.db"));
    try {
      const version = Number(db.pragma("user_version", { simple: true }));
      if (version > SQLITE_SCHEMA_VERSION) throw new SqliteSchemaError(`The workspace database uses newer schema version ${version}. Update NAI Recipe Studio before opening it.`);
      const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get();
      if (version === 0 && hasTables) throw new SqliteSchemaError("The workspace database has no recognized schema version and was left unchanged.");

      db.pragma("foreign_keys = ON");
      db.pragma("journal_mode = WAL");
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SQLITE_SCHEMA_VERSION}`);
      this.db = db;
      this.markInterrupted();
      this.seedPalette();
    } catch (cause) {
      db.close();
      throw cause;
    }
  }

  close() { this.db.close(); }

  private markInterrupted() {
    this.db.prepare("UPDATE jobs SET state='interrupted', error=COALESCE(error, 'The app stopped before the job completed.') WHERE state IN ('queued','running')").run();
  }

  private seedPalette() {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO presets (type, name, builtin_id, hidden, block, tags, notes, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`);
    const stamp = now();
    const tx = this.db.transaction(() => {
      for (const preset of PUBLIC_PALETTE) insert.run(preset.type, preset.name, preset.builtinId, json(preset.block), json(preset.tags), preset.notes, stamp, stamp);
    });
    tx();
  }

  listRecipes(input: { query?: string; limit?: number; offset?: number } = {}): Page<StoredRecipe> {
    const query = input.query?.trim();
    const where = query ? "WHERE name LIKE @query OR tags LIKE @query OR notes LIKE @query" : "";
    const params = query ? { query: `%${query}%` } : {};
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM recipes ${where}`).get(params) as { count: number }).count;
    const rows = this.db.prepare(`SELECT * FROM recipes ${where} ORDER BY updated_at DESC, id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: input.limit ?? 100, offset: input.offset ?? 0 }) as Record<string, unknown>[];
    const items = rows.map(rowRecipe);
    if (items.length) {
      const ids = items.map(item => item.id);
      const placeholders = ids.map(() => "?").join(",");
      const previews = this.db.prepare(`SELECT g.*, r.name AS recipe_name, rt.score, rt.liked, rt.note FROM generations g LEFT JOIN recipes r ON r.id=g.recipe_id LEFT JOIN ratings rt ON rt.generation_id=g.id WHERE g.id IN (SELECT MAX(id) FROM generations WHERE recipe_id IN (${placeholders}) GROUP BY recipe_id)`).all(...ids) as Record<string, unknown>[];
      const byRecipe = new Map(previews.map(row => [Number(row.recipe_id), rowGallery(row)]));
      const counts = this.db.prepare(`SELECT recipe_id, COUNT(*) AS count FROM generations WHERE recipe_id IN (${placeholders}) GROUP BY recipe_id`).all(...ids) as { recipe_id: number; count: number }[];
      const countByRecipe = new Map(counts.map(row => [row.recipe_id, row.count]));
      for (const item of items) { const latest = byRecipe.get(item.id); if (latest) item.latest = latest; item.generation_count = countByRecipe.get(item.id) ?? 0; }
    }
    return { items, total };
  }

  getRecipe(id: number): StoredRecipe {
    const row = this.db.prepare("SELECT * FROM recipes WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SqliteNotFoundError(`Recipe ${id} was not found.`);
    return rowRecipe(row);
  }

  saveRecipe(input: { recipe: Recipe; expectedVersion?: number; note?: string }): StoredRecipe {
    const parsed = input.recipe;
    const stamp = now();
    const transaction = this.db.transaction(() => {
      const existing = parsed.id ? this.db.prepare("SELECT * FROM recipes WHERE id=?").get(parsed.id) as Record<string, unknown> | undefined : undefined;
      if (existing) {
        const recipeId = parsed.id as number;
        const currentVersion = Number(existing.version);
        if (input.expectedVersion === undefined || input.expectedVersion !== currentVersion) throw new SqliteConflictError();
        const nextVersion = currentVersion + 1;
        this.db.prepare("UPDATE recipes SET name=?, tags=?, rating=?, blocks=?, source=?, notes=?, version=?, updated_at=? WHERE id=?")
          .run(parsed.name, json(parsed.tags), parsed.rating, json(parsed.blocks), parsed.source, parsed.notes, nextVersion, stamp, parsed.id);
        this.db.prepare("INSERT INTO recipe_versions (recipe_id, version, recipe, note, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(recipeId, nextVersion, json({ ...parsed, id: recipeId, updated_at: stamp }), input.note ?? "", stamp);
        return this.getRecipe(recipeId);
      }
      const result = this.db.prepare("INSERT INTO recipes (name, tags, rating, blocks, source, notes, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
        .run(parsed.name, json(parsed.tags), parsed.rating, json(parsed.blocks), parsed.source, parsed.notes, stamp, stamp);
      const id = Number(result.lastInsertRowid);
      const saved = { ...parsed, id, version: 1, created_at: stamp, updated_at: stamp } as StoredRecipe;
      this.db.prepare("INSERT INTO recipe_versions (recipe_id, version, recipe, note, created_at) VALUES (?, 1, ?, ?, ?)").run(id, json(saved), input.note ?? "", stamp);
      return saved as StoredRecipe;
    });
    return transaction() as StoredRecipe;
  }

  duplicateRecipe(id: number, name: string): StoredRecipe {
    const source = this.getRecipe(id);
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...recipe } = source;
    void _id; void _version; void _created; void _updated;
    return this.saveRecipe({ recipe: { ...recipe, name }, note: "Duplicated recipe" });
  }

  deleteRecipe(id: number) { return this.db.prepare("DELETE FROM recipes WHERE id=?").run(id).changes > 0; }

  listRecipeVersions(id: number): RecipeVersion[] {
    // Verify existence so a stale MCP id is an explicit error.
    this.getRecipe(id);
    return (this.db.prepare("SELECT version, recipe, created_at, note FROM recipe_versions WHERE recipe_id=? ORDER BY version DESC").all(id) as Record<string, unknown>[])
      .map(row => ({ version: Number(row.version), recipe: parse<Recipe>(row.recipe, {} as Recipe), created_at: String(row.created_at), note: String(row.note ?? "") }));
  }

  createRecipeProposal(input: {
    id: string;
    recipeId: number;
    expectedVersion: number;
    reason: string;
    connectionId?: string;
    connectionName?: string;
    expiresAt: string;
    changes: RecipeProposalChange[];
  }): RecipeProposal {
    const stamp = now();
    const transaction = this.db.transaction(() => {
      const current = this.getRecipe(input.recipeId);
      if (current.version !== input.expectedVersion) throw new SqliteConflictError();
      this.db.prepare(`INSERT INTO recipe_proposals (id, recipe_id, base_version, application_version, reason, connection_id, connection_name, changes, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.recipeId, input.expectedVersion, input.expectedVersion, input.reason, input.connectionId ?? null, input.connectionName ?? null, json(input.changes), stamp, stamp, input.expiresAt);
      return this.getRecipeProposal(input.id);
    });
    return transaction() as RecipeProposal;
  }

  getRecipeProposal(id: string): RecipeProposal {
    const row = this.db.prepare("SELECT * FROM recipe_proposals WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SqliteNotFoundError(`Recipe proposal ${id} was not found.`);
    return rowProposal(row);
  }

  listRecipeProposals(input: { recipeId?: number; connectionId?: string } = {}): RecipeProposal[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (input.recipeId !== undefined) { conditions.push("recipe_id=@recipeId"); params.recipeId = input.recipeId; }
    if (input.connectionId !== undefined) { conditions.push("connection_id=@connectionId"); params.connectionId = input.connectionId; }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM recipe_proposals ${where} ORDER BY created_at DESC, id DESC`).all(params) as Record<string, unknown>[]).map(rowProposal);
  }

  commitRecipeProposal(input: {
    proposalId: string;
    expectedVersion: number;
    recipe: Recipe;
    changes: RecipeProposalChange[];
    note: string;
  }): { proposal: RecipeProposal; recipe: StoredRecipe } {
    const stamp = now();
    const transaction = this.db.transaction(() => {
      const proposalRow = this.db.prepare("SELECT * FROM recipe_proposals WHERE id=?").get(input.proposalId) as Record<string, unknown> | undefined;
      if (!proposalRow) throw new SqliteNotFoundError(`Recipe proposal ${input.proposalId} was not found.`);
      const proposal = rowProposal(proposalRow);
      if (proposal.applicationVersion !== input.expectedVersion) throw new SqliteConflictError();
      const current = this.getRecipe(proposal.recipeId);
      if (current.version !== input.expectedVersion || input.recipe.id !== proposal.recipeId) throw new SqliteConflictError();
      const nextVersion = current.version + 1;
      const saved = { ...input.recipe, id: current.id, version: nextVersion, created_at: current.created_at, updated_at: stamp } as StoredRecipe;
      this.db.prepare("UPDATE recipes SET name=?, tags=?, rating=?, blocks=?, source=?, notes=?, version=?, updated_at=? WHERE id=?")
        .run(saved.name, json(saved.tags), saved.rating, json(saved.blocks), saved.source, saved.notes, nextVersion, stamp, saved.id);
      this.db.prepare("INSERT INTO recipe_versions (recipe_id, version, recipe, note, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(saved.id, nextVersion, json(saved), input.note, stamp);
      this.db.prepare("UPDATE recipe_proposals SET application_version=?, changes=?, updated_at=? WHERE id=?")
        .run(nextVersion, json(input.changes), stamp, input.proposalId);
      return { proposal: this.getRecipeProposal(input.proposalId), recipe: this.getRecipe(saved.id) };
    });
    return transaction() as { proposal: RecipeProposal; recipe: StoredRecipe };
  }

  listCharacters(input: { query?: string; limit?: number; offset?: number } = {}): Page<StoredCharacter> {
    const query = input.query?.trim();
    const where = query ? "AND (tag LIKE @query OR series LIKE @query OR display_name LIKE @query OR notes LIKE @query)" : "";
    const params = query ? { query: `%${query}%` } : {};
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM characters WHERE deleted_at IS NULL ${where}`).get(params) as { count: number }).count;
    const rows = this.db.prepare(`SELECT * FROM characters WHERE deleted_at IS NULL ${where} ORDER BY tag, id LIMIT @limit OFFSET @offset`).all({ ...params, limit: input.limit ?? 100, offset: input.offset ?? 0 }) as Record<string, unknown>[];
    const items = rows.map(rowCharacter);
    if (items.length) {
      const listedIds = new Set(items.map(item => item.id));
      const usage = new Map<number, { count: number; examples: GenerationExample[] }>();
      const generations = this.db.prepare("SELECT id, recipe_id, recipe, seed, rating, created_at FROM generations ORDER BY created_at DESC, id DESC").iterate() as Iterable<Record<string, unknown>>;
      for (const generation of generations) {
        const snapshot = parse<Recipe>(generation.recipe, { name: "", tags: [], rating: 0, blocks: [], source: "manual", notes: "" });
        const characterIds = new Set<number>();
        for (const block of snapshot.blocks ?? []) {
          if (block.type !== "cast") continue;
          for (const member of block.members) if (listedIds.has(member.character_id)) characterIds.add(member.character_id);
        }
        if (!characterIds.size) continue;
        const example = rowGenerationExample(generation);
        for (const id of characterIds) {
          const summary = usage.get(id) ?? { count: 0, examples: [] };
          summary.count += 1;
          if (summary.examples.length < 4) summary.examples.push(example);
          usage.set(id, summary);
        }
      }
      for (const item of items) {
        const summary = usage.get(item.id);
        item.generation_count = summary?.count ?? 0;
        item.examples = summary?.examples ?? [];
      }
    }
    return { items, total };
  }

  getCharacter(id: number): StoredCharacter {
    const row = this.db.prepare("SELECT * FROM characters WHERE id=? AND deleted_at IS NULL").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SqliteNotFoundError(`Character ${id} was not found.`);
    return rowCharacter(row);
  }

  saveCharacter(input: Character): StoredCharacter {
    const stamp = now();
    const tx = this.db.transaction(() => {
      const existing = input.id ? this.db.prepare("SELECT * FROM characters WHERE id=?").get(input.id) as Record<string, unknown> | undefined : undefined;
      const activeByTag = this.db.prepare("SELECT * FROM characters WHERE tag=? AND deleted_at IS NULL AND id<>?").get(input.tag, input.id ?? -1) as Record<string, unknown> | undefined;
      if (activeByTag) throw new SqliteConflictError(`Character tag ${input.tag} is already registered.`);
      const historical = !existing ? this.db.prepare("SELECT locked FROM characters WHERE tag=? ORDER BY id DESC LIMIT 1").get(input.tag) as { locked?: number } | undefined : undefined;
      const locked = !!existing?.locked || !!historical?.locked || !!input.locked;
      if (existing) {
        this.db.prepare("UPDATE characters SET tag=?, series=?, display_name=?, gender=?, age_flag=?, locked=?, fixed_traits=?, default_x=?, default_y=?, notes=?, deleted_at=NULL WHERE id=?")
          .run(input.tag, input.series, input.display_name, input.gender, input.age_flag, locked ? 1 : 0, json(input.fixed_traits), input.default_x, input.default_y, input.notes, input.id);
        return this.getCharacter(input.id!);
      }
      const result = this.db.prepare("INSERT INTO characters (tag, series, display_name, gender, age_flag, locked, fixed_traits, default_x, default_y, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.tag, input.series, input.display_name, input.gender, input.age_flag, locked ? 1 : 0, json(input.fixed_traits), input.default_x, input.default_y, input.notes, stamp);
      return this.getCharacter(Number(result.lastInsertRowid));
    });
    return tx() as StoredCharacter;
  }

  deleteCharacter(id: number) { return this.db.prepare("UPDATE characters SET deleted_at=? WHERE id=? AND deleted_at IS NULL").run(now(), id).changes > 0; }

  listPresets(input: { query?: string; limit?: number; offset?: number; type?: string; includeHidden?: boolean } = {}): Page<StoredPreset> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (!input.includeHidden) conditions.push("hidden=0");
    if (input.type) { conditions.push("type=@type"); params.type = input.type; }
    if (input.query?.trim()) { conditions.push("(name LIKE @query OR tags LIKE @query OR notes LIKE @query)"); params.query = `%${input.query.trim()}%`; }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM presets ${where}`).get(params) as { count: number }).count;
    const rows = this.db.prepare(`SELECT * FROM presets ${where} ORDER BY name, id LIMIT @limit OFFSET @offset`).all({ ...params, limit: input.limit ?? 100, offset: input.offset ?? 0 }) as Record<string, unknown>[];
    const items = rows.map(rowPreset);
    if (items.length) {
      const matchers = items.map(preset => ({ id: preset.id, matcher: createPresetMatcher(preset) }));
      const usage = new Map<number, { count: number; examples: GenerationExample[] }>();
      const generations = this.db.prepare("SELECT id, recipe_id, recipe, seed, rating, created_at, base_prompt FROM generations ORDER BY created_at DESC, id DESC").iterate() as Iterable<Record<string, unknown>>;
      for (const generation of generations) {
        const snapshot = parse<Recipe>(generation.recipe, { name: "", tags: [], rating: 0, blocks: [], source: "manual", notes: "" });
        const indexed = indexGenerationForPresets(snapshot, String(generation.base_prompt ?? ""));
        const example = rowGenerationExample(generation);
        for (const { id, matcher } of matchers) {
          if (!matchesPreset(indexed, matcher)) continue;
          const summary = usage.get(id) ?? { count: 0, examples: [] };
          summary.count += 1;
          if (summary.examples.length < 4) summary.examples.push(example);
          usage.set(id, summary);
        }
      }
      for (const item of items) {
        const summary = usage.get(item.id);
        item.usage = summary?.count ?? 0;
        item.examples = summary?.examples ?? [];
      }
    }
    return { items, total };
  }

  getPreset(id: number): StoredPreset {
    const row = this.db.prepare("SELECT * FROM presets WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SqliteNotFoundError(`Preset ${id} was not found.`);
    return rowPreset(row);
  }

  savePreset(input: BlockPreset): StoredPreset {
    const stamp = now();
    const existing = input.id ? this.db.prepare("SELECT * FROM presets WHERE id=?").get(input.id) as Record<string, unknown> | undefined : undefined;
    if (existing?.builtin_id) throw new SqliteConflictError("Built-in presets are read-only.");
    if (existing) {
      this.db.prepare("UPDATE presets SET type=?, name=?, block=?, tags=?, notes=?, updated_at=? WHERE id=?")
        .run(input.type, input.name, json(input.block), json(input.tags), input.notes, stamp, input.id);
      return this.getPreset(input.id!);
    }
    const result = this.db.prepare("INSERT INTO presets (type, name, block, tags, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.type, input.name, json(input.block), json(input.tags), input.notes, stamp, stamp);
    return this.getPreset(Number(result.lastInsertRowid));
  }

  deletePreset(id: number) {
    const row = this.db.prepare("SELECT builtin_id FROM presets WHERE id=?").get(id) as { builtin_id: string | null } | undefined;
    if (row?.builtin_id) throw new SqliteConflictError("Built-in presets are read-only.");
    return this.db.prepare("DELETE FROM presets WHERE id=?").run(id).changes > 0;
  }

  savePlan(plan: GenerationPlan, composed: Record<string, unknown>) {
    this.db.prepare("INSERT INTO plans (id, recipe, count, seeds, estimated_anlas, findings, expires_at, approved, account, connection_id, connection_name, composed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(plan.id, json(plan.recipe), plan.count, json(plan.seeds), plan.estimatedAnlas, json(plan.findings), plan.expiresAt, plan.approved ? 1 : 0, plan.account ? json(plan.account) : null, plan.connectionId ?? null, plan.connectionName ?? null, json(composed), now());
    return plan;
  }

  getPlan(id: string): StoredPlanRow {
    const row = this.db.prepare("SELECT * FROM plans WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SqliteNotFoundError(`Generation plan ${id} was not found.`);
    return rowPlan(row);
  }

  listPendingPlans(asOf = now()): GenerationPlan[] {
    const rows = this.db.prepare("SELECT p.* FROM plans p LEFT JOIN jobs j ON j.plan_id=p.id WHERE p.expires_at>? AND j.id IS NULL ORDER BY p.created_at DESC").all(asOf) as Record<string, unknown>[];
    return rows.map(rowPlan).map(({ composed: _composed, created_at: _createdAt, ...plan }) => plan);
  }

  approvePlan(id: string): GenerationPlan {
    this.getPlan(id);
    this.db.prepare("UPDATE plans SET approved=1 WHERE id=?").run(id);
    return this.getPlan(id);
  }

  saveJob(input: { id: string; planId: string; requestId: string; state: GenerationJob["state"]; total: number; completed?: number; generationIds?: number[]; error?: unknown }) {
    this.db.prepare("INSERT INTO jobs (id, plan_id, request_id, state, total, completed, generation_ids, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.planId, input.requestId, input.state, input.total, input.completed ?? 0, json(input.generationIds ?? []), input.error ? json(input.error) : null, now());
    return this.getJob(input.id);
  }

  getJob(id: string): GenerationJob {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SqliteNotFoundError(`Generation job ${id} was not found.`);
    return rowJob(row);
  }

  getJobByRequest(requestId: string): GenerationJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE request_id=?").get(requestId) as Record<string, unknown> | undefined;
    return row ? rowJob(row) : null;
  }

  getJobByPlan(planId: string): GenerationJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE plan_id=?").get(planId) as Record<string, unknown> | undefined;
    return row ? rowJob(row) : null;
  }

  listJobs(): GenerationJob[] { return (this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(rowJob); }

  updateJob(id: string, patch: { state?: GenerationJob["state"]; completed?: number; generationIds?: number[]; error?: unknown }) {
    const current = this.getJob(id);
    this.db.prepare("UPDATE jobs SET state=COALESCE(?,state), completed=COALESCE(?,completed), generation_ids=COALESCE(?,generation_ids), error=COALESCE(?,error) WHERE id=?")
      .run(patch.state ?? null, patch.completed ?? null, patch.generationIds ? json(patch.generationIds) : null, patch.error ? json(patch.error) : null, id);
    return this.getJob(current.id);
  }

  requestCancel(id: string) {
    this.getJob(id);
    this.db.prepare("UPDATE jobs SET cancel_requested=1, state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'running' END WHERE id=? AND state IN ('queued','running')").run(id);
    return this.getJob(id);
  }

  requestStopAll() {
    this.db.prepare("UPDATE jobs SET cancel_requested=1, state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END WHERE state IN ('queued','running')").run();
  }

  isCancelRequested(id: string) { return !!(this.db.prepare("SELECT cancel_requested FROM jobs WHERE id=?").get(id) as { cancel_requested: number } | undefined)?.cancel_requested; }

  insertGeneration(input: { recipe: Recipe; recipeId: number | null; seed: number; width: number; height: number; rating: number; file: string; outputRoot: string; basePrompt: string; negative: string; characters: unknown[]; settings: Record<string, unknown>; estimatedAnlas: number }) {
    const result = this.db.prepare("INSERT INTO generations (recipe_id, recipe, seed, width, height, rating, file, base_prompt, negative, characters, settings, estimated_anlas, output_root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.recipeId, json(input.recipe), input.seed, input.width, input.height, input.rating, input.file, input.basePrompt, input.negative, json(input.characters), json(input.settings), input.estimatedAnlas, input.outputRoot, now());
    return Number(result.lastInsertRowid);
  }

  getGenerationFile(id: number): { file: string; outputRoot: string } {
    const row = this.db.prepare("SELECT file, output_root FROM generations WHERE id=?").get(id) as { file?: string; output_root?: string } | undefined;
    if (!row || typeof row.file !== "string" || typeof row.output_root !== "string") throw new SqliteNotFoundError(`Gallery item ${id} was not found.`);
    return { file: row.file, outputRoot: row.output_root };
  }

  getGallery(id: number): GalleryItem {
    const row = this.db.prepare("SELECT g.*, r.name AS recipe_name, rt.score, rt.liked, rt.note FROM generations g LEFT JOIN recipes r ON r.id=g.recipe_id LEFT JOIN ratings rt ON rt.generation_id=g.id WHERE g.id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SqliteNotFoundError(`Gallery item ${id} was not found.`);
    return rowGallery(row);
  }

  listGallery(input: GalleryListInput = {}): Page<GalleryItem> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (input.recipeId !== undefined) { conditions.push("g.recipe_id=@recipeId"); params.recipeId = input.recipeId; }
    if (input.ratingMax !== undefined) { conditions.push("g.rating<=@ratingMax"); params.ratingMax = input.ratingMax; }
    if (input.liked !== undefined) { conditions.push("COALESCE(rt.liked,0)=@liked"); params.liked = input.liked ? 1 : 0; }
    if (input.query?.trim()) { conditions.push("(COALESCE(r.name,'') LIKE @query OR g.base_prompt LIKE @query)"); params.query = `%${input.query.trim()}%`; }
    const characterIds = [...new Set(input.characterIds ?? [])];
    if (characterIds.length) {
      const placeholders = characterIds.map((_, index) => `@characterId${index}`).join(",");
      conditions.push(`EXISTS (SELECT 1 FROM json_each(g.recipe, '$.blocks') AS block CROSS JOIN json_each(json_extract(block.value, '$.members')) AS member WHERE json_extract(block.value, '$.type')='cast' AND json_extract(member.value, '$.character_id') IN (${placeholders}))`);
      characterIds.forEach((id, index) => { params[`characterId${index}`] = id; });
    }
    const presetIds = [...new Set(input.presetIds ?? [])];
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = input.sort === "oldest" ? "ASC" : "DESC";
    const query = `SELECT g.*, r.name AS recipe_name, rt.score, rt.liked, rt.note FROM generations g LEFT JOIN recipes r ON r.id=g.recipe_id LEFT JOIN ratings rt ON rt.generation_id=g.id ${where} ORDER BY g.created_at ${order}, g.id ${order}`;
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    if (!presetIds.length) {
      const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM generations g LEFT JOIN recipes r ON r.id=g.recipe_id LEFT JOIN ratings rt ON rt.generation_id=g.id ${where}`).get(params) as { count: number }).count;
      const rows = this.db.prepare(`${query} LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset }) as Record<string, unknown>[];
      return { items: rows.map(rowGallery), total };
    }

    const placeholders = presetIds.map(() => "?").join(",");
    const selectedRows = this.db.prepare(`SELECT * FROM presets WHERE id IN (${placeholders})`).all(...presetIds) as Record<string, unknown>[];
    const matchers = selectedRows.map(rowPreset).map(preset => createPresetMatcher(preset));

    const items: GalleryItem[] = [];
    let total = 0;
    const generations = this.db.prepare(query).iterate(params) as Iterable<Record<string, unknown>>;
    for (const row of generations) {
      const snapshot = parse<Recipe>(row.recipe, { name: "", tags: [], rating: 0, blocks: [], source: "manual", notes: "" });
      const indexed = indexGenerationForPresets(snapshot, String(row.base_prompt ?? ""));
      const linkedById = presetIds.some(id => indexed.presetIds.has(id));
      if (!linkedById && !matchers.some(matcher => matchesPreset(indexed, matcher))) continue;
      if (total >= offset && items.length < limit) items.push(rowGallery(row));
      total += 1;
    }
    return { items, total };
  }

  rateGallery(id: number, input: { score?: number | null; liked?: boolean; note?: string }) {
    this.getGallery(id);
    const current = this.db.prepare("SELECT score, liked, note FROM ratings WHERE generation_id=?").get(id) as { score: number | null; liked: number; note: string } | undefined;
    this.db.prepare("INSERT INTO ratings (generation_id, score, liked, note) VALUES (?, ?, ?, ?) ON CONFLICT(generation_id) DO UPDATE SET score=excluded.score, liked=excluded.liked, note=excluded.note")
      .run(id, input.score === undefined ? current?.score ?? null : input.score, input.liked === undefined ? current?.liked ?? 0 : input.liked ? 1 : 0, input.note === undefined ? current?.note ?? "" : input.note);
    return this.getGallery(id);
  }

  deleteGallery(id: number) { return this.db.prepare("DELETE FROM generations WHERE id=?").run(id).changes > 0; }

  getSetting(key: string): string | null { return (this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null; }
  setSetting(key: string, value: string) { this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
}

function rowRecipe(row: Record<string, unknown>): StoredRecipe {
  return {
    id: Number(row.id), version: Number(row.version), name: String(row.name), tags: parse<string[]>(row.tags, []), rating: Number(row.rating), blocks: parse<Recipe["blocks"]>(row.blocks, []), source: String(row.source), notes: String(row.notes),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

function rowProposal(row: Record<string, unknown>): RecipeProposal {
  const changes = parse<RecipeProposalChange[]>(row.changes, []);
  const expiresAt = String(row.expires_at);
  const allApplied = changes.length > 0 && changes.every(change => change.state === "applied");
  const hasApplied = changes.some(change => change.state === "applied");
  const status: RecipeProposal["status"] = allApplied ? "applied" : Date.parse(expiresAt) <= Date.now() ? "expired" : hasApplied ? "partial" : "pending";
  return {
    id: String(row.id),
    recipeId: Number(row.recipe_id),
    baseVersion: Number(row.base_version),
    applicationVersion: Number(row.application_version),
    reason: String(row.reason),
    ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}),
    ...(row.connection_name ? { connectionName: String(row.connection_name) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt,
    status,
    changes,
  };
}

function rowCharacter(row: Record<string, unknown>): StoredCharacter {
  return {
    id: Number(row.id), tag: String(row.tag), series: String(row.series), display_name: String(row.display_name), gender: row.gender as Character["gender"], age_flag: row.age_flag as Character["age_flag"], locked: !!row.locked,
    fixed_traits: parse<string[]>(row.fixed_traits, []), default_x: Number(row.default_x), default_y: Number(row.default_y), notes: String(row.notes), created_at: String(row.created_at),
  };
}

function rowPreset(row: Record<string, unknown>): StoredPreset {
  return {
    id: Number(row.id), type: row.type as BlockPreset["type"], name: String(row.name), block: parse<BlockPreset["block"]>(row.block, { type: "scene", tags: [], text: "" } as BlockPreset["block"]), tags: parse<string[]>(row.tags, []), notes: String(row.notes), created_at: String(row.created_at), updated_at: String(row.updated_at),
    ...(row.builtin_id ? { builtinId: String(row.builtin_id) } : {}), ...(row.hidden ? { hidden: true } : {}),
  };
}

function rowJob(row: Record<string, unknown>): GenerationJob {
  return { id: String(row.id), planId: String(row.plan_id), state: row.state as GenerationJob["state"], total: Number(row.total), completed: Number(row.completed), generationIds: parse<number[]>(row.generation_ids, []), ...(row.error ? { error: parse(row.error, row.error as never) } : {}), created_at: String(row.created_at) };
}

function rowGenerationExample(row: Record<string, unknown>): GenerationExample {
  const id = Number(row.id);
  return {
    id,
    recipe_id: row.recipe_id == null ? null : Number(row.recipe_id),
    seed: Number(row.seed),
    created_at: String(row.created_at),
    rating: Number(row.rating),
    url: `recipe-studio://app/images/${id}`,
  };
}

function rowPlan(row: Record<string, unknown>): StoredPlanRow {
  return {
    id: String(row.id), recipe: parse<Recipe>(row.recipe, {} as Recipe), count: Number(row.count), seeds: parse<number[]>(row.seeds, []),
    estimatedAnlas: row.estimated_anlas == null ? null : Number(row.estimated_anlas), findings: parse(planFindings(row.findings), []), expiresAt: String(row.expires_at),
    approved: !!row.approved, account: parse<AccountStatus | null>(row.account, null),
    ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}), ...(row.connection_name ? { connectionName: String(row.connection_name) } : {}),
    composed: parse<Record<string, unknown>>(row.composed, {}), created_at: String(row.created_at),
  };
}

function rowGallery(row: Record<string, unknown>): GalleryItem {
  const recipe = parse<Recipe>(row.recipe, { name: "", tags: [], rating: 0, blocks: [], source: "manual", notes: "" });
  const characters = parse<Composed["characters"]>(row.characters, []);
  const settings = parse<Composed["settings"] | null>(row.settings, null);
  return {
    id: Number(row.id), recipe_id: row.recipe_id == null ? null : Number(row.recipe_id), recipe_name: String(row.recipe_name ?? recipe.name), recipe, seed: Number(row.seed), width: Number(row.width), height: Number(row.height), rating: Number(row.rating),
    url: `recipe-studio://app/images/${Number(row.id)}`, created_at: String(row.created_at), estimatedAnlas: Number(row.estimated_anlas), score: row.score == null ? null : Number(row.score), liked: !!row.liked, note: String(row.note ?? ""), base_prompt: String(row.base_prompt), negative: String(row.negative),
    characters, ...(settings ? { settings } : {}),
  } as GalleryItem;
}

function planFindings(value: unknown) { return parse<GenerationPlan["findings"]>(value, []); }
