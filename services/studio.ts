import { randomUUID } from "node:crypto";
import path from "node:path";
import { StudioError, APP_VERSION, PROTOCOL_VERSION, parseCommandInput, type CallContext, type Connection, type Command, type CommandInput, type CommandOutput, type Finding, type GenerationPlan, type Settings, type StudioEvent, type StudioStatus } from "../contracts/studio";
import { BlockPreset as BlockPresetSchema, Character as CharacterSchema, Recipe as RecipeSchema, type Character, type Recipe } from "../lib/schema";
import { compose } from "../core/recipe/compose";
import { cloneJson } from "../core/recipe/model";
import { validateAndFix, validateRecipe } from "../core/recipe/validate";
import { quoteGeneration } from "../core/generation/cost";
import { StudioSqliteStore, SqliteConflictError, SqliteNotFoundError } from "../adapters/sqlite";
import { OutputStore } from "../adapters/files";
import { buildParams, fetchAccount, generateImage, MODEL } from "../adapters/novelai";

export type StudioServiceOptions = {
  dataDir: string;
  outputDir?: string;
  getToken: () => Promise<string | null>;
  getConnection?: (id: string) => Promise<Connection | null>;
  fetch?: typeof fetch;
  /** Tests may opt into deterministic local PNGs. Production callers must set this explicitly. */
  dryRun?: boolean;
};

export type StudioService = {
  call<K extends Command>(command: K, input: CommandInput<K>, context?: CallContext): Promise<CommandOutput<K>>;
  subscribe(listener: (event: StudioEvent) => void): () => void;
  readImage(id: number): Promise<Uint8Array>;
  close(): Promise<void>;
};

const DRY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const DEFAULT_SETTINGS: Settings = { language: "system", blurSensitive: true, outputDirectory: "" };
const asInput = <K extends Command>(input: unknown) => input as CommandInput<K>;

const MCP_READ_COMMANDS = new Set<Command>([
  "status.read", "recipes.list", "recipes.get", "recipes.versions", "characters.list", "presets.list",
  "recipe.compose", "recipe.validate", "generation.status", "generation.list", "gallery.list", "gallery.get",
  "settings.get", "ai.connections.list", "setup.inspect",
]);
const MCP_WRITE_COMMANDS = new Set<Command>([
  "recipes.save", "recipes.duplicate", "recipes.delete", "characters.save", "characters.delete", "presets.save",
  "presets.delete", "gallery.rate", "gallery.delete", "settings.update", "ai.connections.create", "ai.connections.revoke",
  "setup.install", "setup.uninstall",
]);
const MCP_GENERATION_COMMANDS = new Set<Command>(["generation.prepare", "generation.start", "generation.cancel"]);
const MCP_IMAGE_COMMANDS = new Set<Command>(["gallery.export"]);
const MCP_UI_ONLY_COMMANDS = new Set<Command>([
  "generation.pending", "generation.approve", "credentials.set", "credentials.clear", "credentials.test", "files.importRecipe", "files.exportRecipe",
  "files.chooseOutput", "files.openOutput", "help.open",
]);

function error(code: string, messageKey: string, params?: Record<string, string | number>, retryable?: boolean): never {
  throw new StudioError({ code, messageKey, ...(params ? { params } : {}), ...(retryable === undefined ? {} : { retryable }) });
}

function findingsHaveErrors(findings: Finding[]) { return findings.some(finding => finding.severity === "error"); }

function asStudioError(cause: unknown): StudioError {
  if (cause instanceof StudioError) return cause;
  if (cause instanceof SqliteConflictError) return new StudioError({ code: "VERSION_CONFLICT", messageKey: "errors.VERSION_CONFLICT", retryable: true });
  if (cause instanceof SqliteNotFoundError) return new StudioError({ code: "NOT_FOUND", messageKey: "errors.NOT_FOUND" });
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/generation HTTP|NovelAI response|fetch|AbortError|timed out/i.test(message)) return new StudioError({ code: "RESULT_UNKNOWN", messageKey: "errors.RESULT_UNKNOWN", retryable: false });
  if (/ENOSPC|no space|output directory/i.test(message)) return new StudioError({ code: "STORAGE_FULL", messageKey: "errors.STORAGE_FULL", retryable: true });
  return new StudioError({ code: "INTERNAL_ERROR", messageKey: "errors.INTERNAL_ERROR", retryable: false });
}

function recipeFromInput(value: Recipe): Recipe {
  const parsed = RecipeSchema.safeParse(value);
  if (!parsed.success) error("VALIDATION_FAILED", "errors.VALIDATION_FAILED");
  // The distributed backend accepts only neutral workspace recipes and explicit
  // file imports. Private workflow sources are kept outside this public graph.
  const source = parsed.data.source;
  if (source !== "manual" && !source.startsWith("import:")) error("VALIDATION_FAILED", "errors.VALIDATION_FAILED");
  return parsed.data;
}

function characterFromInput(value: Character): Character { const parsed = CharacterSchema.safeParse(value); if (!parsed.success) error("VALIDATION_FAILED", "errors.VALIDATION_FAILED"); return parsed.data; }

function stableSeed(seed: number | undefined, offset: number) {
  if (seed === undefined) return Math.floor(Math.random() * 2 ** 32) >>> 0;
  return (seed + offset) >>> 0;
}

function settingsOfRecipe(recipe: Recipe) {
  const block = recipe.blocks.find(block => block.type === "settings");
  return block ?? { type: "settings" as const, width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random" as const, quality_preset: "none" as const, uc_preset: "heavy" as const };
}

function authorizeContext(command: Command, context?: CallContext) {
  if (context?.source !== "mcp") return;
  if (MCP_UI_ONLY_COMMANDS.has(command)) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
  const connection = context.connection;
  if (!connection) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
  if (MCP_READ_COMMANDS.has(command) && !connection.permissions.read) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
  if (MCP_WRITE_COMMANDS.has(command) && !connection.permissions.write) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
  if (MCP_GENERATION_COMMANDS.has(command) && !connection.permissions.generate) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
  if (MCP_IMAGE_COMMANDS.has(command) && !connection.permissions.images) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
}

export function createStudioService(options: StudioServiceOptions): StudioService {
  if (!options.dataDir) throw new Error("dataDir is required");
  const dryRun = options.dryRun === true;
  const fetchImpl = options.fetch ?? fetch;
  const store = new StudioSqliteStore(options.dataDir);
  const persistedOutput = (() => {
    const value = store.getSetting("app");
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as { outputDirectory?: unknown };
      return typeof parsed.outputDirectory === "string" && parsed.outputDirectory ? parsed.outputDirectory : undefined;
    } catch { return undefined; }
  })();
  let outputRoot = path.resolve(persistedOutput ?? options.outputDir ?? path.join(options.dataDir, "output"));
  let output = new OutputStore(outputRoot);
  const listeners = new Set<(event: StudioEvent) => void>();
  let queue = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;

  const emit = (event: StudioEvent) => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* notifications must not change the command result */ }
    }
  };
  const workspaceChanged = (entity: "recipes" | "characters" | "presets" | "gallery", ids?: number[]) => emit({ type: "workspace.changed", entity, ...(ids ? { ids } : {}) });

  const getAccount = async (currentToken?: string): Promise<StudioStatus["account"]> => {
    if (dryRun) return null;
    let token: string | null;
    try { token = currentToken ?? await options.getToken(); } catch { token = null; }
    if (!token) return null;
    try { return await fetchAccount(token, fetchImpl); } catch { return null; }
  };

  const resolveCharacters = (recipe: Recipe): Character[] => {
    const ids = new Set<number>();
    for (const block of recipe.blocks) if (block.type === "cast") for (const member of block.members) ids.add(member.character_id);
    return [...ids].flatMap(id => {
      try { return [store.getCharacter(id)]; } catch { return []; }
    });
  };

  const authorizeGeneration = (plan: GenerationPlan, context?: CallContext) => {
    if (context?.source !== "mcp") return;
    const connection = context.connection;
    if (!connection?.permissions.generate) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
    if (connection.maxImages < plan.count) error("APPROVAL_REQUIRED", "errors.APPROVAL_REQUIRED", { maxImages: connection.maxImages });
    if (plan.estimatedAnlas === null) error("COST_UNKNOWN", "errors.COST_UNKNOWN", undefined, true);
    if (connection.maxAnlas < plan.estimatedAnlas) error("APPROVAL_REQUIRED", "errors.APPROVAL_REQUIRED", { maxAnlas: connection.maxAnlas });
  };

  const authorizePlanConnection = (plan: GenerationPlan, context?: CallContext) => {
    if (context?.source !== "mcp") return;
    if (!context.connection || !plan.connectionId || context.connection.id !== plan.connectionId) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
  };

  const checkPlanConnection = async (plan: GenerationPlan) => {
    if (!plan.connectionId || !options.getConnection) return;
    const connection = await options.getConnection(plan.connectionId);
    if (!connection?.permissions.generate) error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
    if (dryRun) {
      if (connection.maxImages < plan.count) error("APPROVAL_REQUIRED", "errors.APPROVAL_REQUIRED");
      return;
    }
    authorizeGeneration(plan, { source: "mcp", connection });
  };

  const runJob = async (jobId: string) => {
    let job = store.getJob(jobId);
    const plan = store.getPlan(job.planId);
    try {
      if (store.isCancelRequested(jobId)) { job = store.updateJob(jobId, { state: "cancelled" }); emit({ type: "job.changed", job }); return; }
      job = store.updateJob(jobId, { state: "running" }); emit({ type: "job.changed", job });
      const recipe = recipeFromInput(plan.recipe);
      const composed = plan.composed as { base_prompt: string; negative: string; characters: { prompt: string; uc: string; x: number; y: number }[]; settings: ReturnType<typeof settingsOfRecipe>; rating: number };
      let token: string | null = null;
      for (let index = job.completed; index < plan.count; index++) {
        if (closed) {
          job = store.updateJob(jobId, { state: "interrupted" }); emit({ type: "job.changed", job }); return;
        }
        if (store.isCancelRequested(jobId)) { job = store.updateJob(jobId, { state: "cancelled" }); emit({ type: "job.changed", job }); return; }
        if (!dryRun) {
          token = await options.getToken();
          if (!token) error("NOT_CONNECTED", "errors.NOT_CONNECTED", undefined, true);
          const currentAccount = await getAccount(token);
          const currentQuote = quoteGeneration({ width: composed.settings.width, height: composed.settings.height, steps: composed.settings.steps }, plan.count, currentAccount);
          if (currentQuote.estimatedAnlas === null) error("COST_UNKNOWN", "errors.COST_UNKNOWN", undefined, true);
          if (!currentQuote.verified || currentQuote.estimatedAnlas !== plan.estimatedAnlas) error("COST_CHANGED", "errors.COST_CHANGED", undefined, true);
        }
        await checkPlanConnection(plan);
        if (closed || store.isCancelRequested(jobId)) {
          job = store.updateJob(jobId, { state: closed ? "interrupted" : "cancelled" }); emit({ type: "job.changed", job }); return;
        }
        const seed = plan.seeds[index];
        let png: Uint8Array = DRY_PNG;
        let payload: Record<string, unknown> = buildParams({ prompt: composed.base_prompt, negative: composed.negative, settings: composed.settings, seed, characters: composed.characters });
        if (!dryRun) {
          const result = await generateImage({ token: token!, prompt: composed.base_prompt, negative: composed.negative, settings: composed.settings, seed, characters: composed.characters, fetchImpl });
          png = result.png;
          payload = result.payload;
        }
        const relative = `images/${jobId}/${String(index + 1).padStart(3, "0")}-${seed}.png`;
        const imageOutputRoot = outputRoot;
        const imageOutput = output;
        const file = await imageOutput.write(relative, png, { created_at: new Date().toISOString(), model: MODEL, recipe, seed, rating: composed.rating, settings: composed.settings, payload, dry_run: dryRun });
        const generationId = store.insertGeneration({ recipe, recipeId: recipe.id ?? null, seed, width: composed.settings.width, height: composed.settings.height, rating: composed.rating, file, outputRoot: imageOutputRoot, basePrompt: composed.base_prompt, negative: composed.negative, characters: composed.characters, settings: composed.settings as unknown as Record<string, unknown>, estimatedAnlas: plan.estimatedAnlas === null ? 0 : Math.ceil(plan.estimatedAnlas / plan.count) });
        job = store.updateJob(jobId, { completed: index + 1, generationIds: [...job.generationIds, generationId] });
        emit({ type: "job.changed", job });
      }
      job = store.updateJob(jobId, { state: closed ? "interrupted" : "completed" }); emit({ type: "job.changed", job });
      workspaceChanged("gallery", job.generationIds);
    } catch (cause) {
      const serviceError = asStudioError(cause);
      job = store.updateJob(jobId, { state: "failed", error: serviceError.data });
      emit({ type: "job.changed", job });
    }
  };

  const enqueue = (jobId: string) => {
    queue = queue.then(() => runJob(jobId)).catch(() => undefined);
  };

  let startCommitTail = Promise.resolve();
  const commitGenerationJob = async (plan: GenerationPlan, requestId: string, context?: CallContext) => {
    const previous = startCommitTail;
    let release!: () => void;
    startCommitTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const existing = store.getJobByRequest(requestId);
      if (existing) {
        const existingPlan = store.getPlan(existing.planId);
        if (existing.planId !== plan.id) error("IDEMPOTENCY_CONFLICT", "errors.IDEMPOTENCY_CONFLICT");
        authorizePlanConnection(existingPlan, context);
        authorizeGeneration(existingPlan, context);
        return { job: existing, created: false };
      }
      if (store.getJobByPlan(plan.id)) error("IDEMPOTENCY_CONFLICT", "errors.IDEMPOTENCY_CONFLICT");
      const job = store.saveJob({ id: randomUUID(), planId: plan.id, requestId, state: "queued", total: plan.count });
      return { job, created: true };
    } finally {
      release();
    }
  };

  const readImage = async (id: number) => {
    const stored = store.getGenerationFile(id);
    return new OutputStore(stored.outputRoot).read(stored.file);
  };

  const command = async <K extends Command>(name: K, input: CommandInput<K>, context?: CallContext): Promise<CommandOutput<K>> => {
    if (closed) error("APP_CLOSED", "errors.APP_CLOSED");
    authorizeContext(name, context);
    switch (name) {
      case "status.read": {
        const settings = readSettings();
        const token = dryRun ? null : await options.getToken().catch(() => null);
        const account = await getAccount();
        return { appVersion: APP_VERSION, schemaVersion: PROTOCOL_VERSION, connected: !!token, account, dryRun, locale: settings.language } as CommandOutput<K>;
      }
      case "recipes.list": return store.listRecipes(asInput<"recipes.list">(input)) as CommandOutput<K>;
      case "recipes.get": return store.getRecipe(asInput<"recipes.get">(input).id) as CommandOutput<K>;
      case "recipes.save": {
        const body = asInput<"recipes.save">(input);
        const recipe = recipeFromInput(body.recipe);
        const saved = store.saveRecipe({ recipe, expectedVersion: body.expectedVersion, note: body.note });
        workspaceChanged("recipes", [saved.id]); return saved as CommandOutput<K>;
      }
      case "recipes.duplicate": {
        const body = asInput<"recipes.duplicate">(input); const saved = store.duplicateRecipe(body.id, body.name); workspaceChanged("recipes", [saved.id]); return saved as CommandOutput<K>;
      }
      case "recipes.delete": { const id = asInput<"recipes.delete">(input).id; const deleted = store.deleteRecipe(id); if (deleted) workspaceChanged("recipes", [id]); return { deleted } as CommandOutput<K>; }
      case "recipes.versions": return store.listRecipeVersions(asInput<"recipes.versions">(input).id) as CommandOutput<K>;
      case "characters.list": return store.listCharacters(asInput<"characters.list">(input)) as CommandOutput<K>;
      case "characters.save": { const saved = store.saveCharacter(characterFromInput(asInput<"characters.save">(input).character)); workspaceChanged("characters", [saved.id]); return saved as CommandOutput<K>; }
      case "characters.delete": { const id = asInput<"characters.delete">(input).id; const deleted = store.deleteCharacter(id); if (deleted) workspaceChanged("characters", [id]); return { deleted } as CommandOutput<K>; }
      case "presets.list": return store.listPresets(asInput<"presets.list">(input)) as CommandOutput<K>;
      case "presets.save": { const raw = asInput<"presets.save">(input).preset; const parsed = BlockPresetSchema.safeParse(raw); if (!parsed.success || parsed.data.block.type !== parsed.data.type) error("VALIDATION_FAILED", "errors.VALIDATION_FAILED"); const saved = store.savePreset(parsed.data); workspaceChanged("presets", [saved.id]); return saved as CommandOutput<K>; }
      case "presets.delete": { const id = asInput<"presets.delete">(input).id; const deleted = store.deletePreset(id); if (deleted) workspaceChanged("presets", [id]); return { deleted } as CommandOutput<K>; }
      case "recipe.compose": { const recipe = recipeFromInput(asInput<"recipe.compose">(input).recipe); return compose(recipe, resolveCharacters(recipe)) as CommandOutput<K>; }
      case "recipe.validate": {
        const body = asInput<"recipe.validate">(input); const recipe = recipeFromInput(body.recipe); const result = validateAndFix(recipe, resolveCharacters(recipe), body.fixes ?? []); return result as CommandOutput<K>;
      }
      case "generation.prepare": {
        const body = asInput<"generation.prepare">(input); const recipe = recipeFromInput(body.recipe); const characters = resolveCharacters(recipe); const findings = validateRecipe(recipe, characters); const composed = compose(recipe, characters); const account = await getAccount(); const quote = quoteGeneration({ width: composed.settings.width, height: composed.settings.height, steps: composed.settings.steps }, body.count, account); const fixedSeed = body.seed ?? (composed.settings.seed_policy === "fixed" ? composed.settings.seed : undefined); const seeds = Array.from({ length: body.count }, (_, index) => stableSeed(fixedSeed, index)); const connection = context?.source === "mcp" ? context.connection : undefined; const plan: GenerationPlan = { id: randomUUID(), recipe: cloneJson(recipe), count: body.count, seeds, estimatedAnlas: quote.estimatedAnlas, findings, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), approved: false, account, ...(connection ? { connectionId: connection.id, connectionName: connection.name } : {}) }; store.savePlan(plan, composed as unknown as Record<string, unknown>); emit({ type: "generation.prepared", plan }); return plan as CommandOutput<K>;
      }
      case "generation.pending": return store.listPendingPlans() as CommandOutput<K>;
      case "generation.approve": {
        if (context?.source !== "ui") error("PERMISSION_DENIED", "errors.PERMISSION_DENIED");
        const planId = asInput<"generation.approve">(input).planId;
        const plan = store.getPlan(planId);
        if (new Date(plan.expiresAt).getTime() <= Date.now()) error("PLAN_EXPIRED", "errors.PLAN_EXPIRED", undefined, true);
        return store.approvePlan(planId) as CommandOutput<K>;
      }
      case "generation.start": {
        const body = asInput<"generation.start">(input);
        const existing = store.getJobByRequest(body.requestId);
        if (existing) {
          const existingPlan = store.getPlan(existing.planId);
          if (existing.planId !== body.planId) error("IDEMPOTENCY_CONFLICT", "errors.IDEMPOTENCY_CONFLICT");
          authorizePlanConnection(existingPlan, context);
          authorizeGeneration(existingPlan, context);
          return existing as CommandOutput<K>;
        }
        const plan = store.getPlan(body.planId);
        authorizePlanConnection(plan, context);
        const planJob = store.getJobByPlan(plan.id);
        if (planJob) {
          if (planJob.id) error("IDEMPOTENCY_CONFLICT", "errors.IDEMPOTENCY_CONFLICT");
        }
        if (!plan.approved) error("APPROVAL_REQUIRED", "errors.APPROVAL_REQUIRED");
        if (new Date(plan.expiresAt).getTime() <= Date.now()) error("PLAN_EXPIRED", "errors.PLAN_EXPIRED", undefined, true);
        if (findingsHaveErrors(plan.findings)) error("VALIDATION_FAILED", "errors.VALIDATION_FAILED");
        authorizeGeneration(plan, context);
        if (!dryRun) {
          const token = await options.getToken().catch(() => null);
          if (!token) error("NOT_CONNECTED", "errors.NOT_CONNECTED", undefined, true);
          const account = await getAccount(token);
          const quote = quoteGeneration({ width: settingsOfRecipe(plan.recipe).width, height: settingsOfRecipe(plan.recipe).height, steps: settingsOfRecipe(plan.recipe).steps }, plan.count, account);
          if (quote.estimatedAnlas === null) error("COST_UNKNOWN", "errors.COST_UNKNOWN", undefined, true);
          if (!quote.verified || quote.estimatedAnlas !== plan.estimatedAnlas) error("COST_CHANGED", "errors.COST_CHANGED", undefined, true);
        }
        await checkPlanConnection(plan);
        if (closed) error("APP_CLOSED", "errors.APP_CLOSED");
        const committed = await commitGenerationJob(plan, body.requestId, context);
        if (committed.created) enqueue(committed.job.id);
        return committed.job as CommandOutput<K>;
      }
      case "generation.status": return store.getJob(asInput<"generation.status">(input).id) as CommandOutput<K>;
      case "generation.list": return store.listJobs() as CommandOutput<K>;
      case "generation.cancel": { const id = asInput<"generation.cancel">(input).id; authorizePlanConnection(store.getPlan(store.getJob(id).planId), context); const job = store.requestCancel(id); emit({ type: "job.changed", job }); return job as CommandOutput<K>; }
      case "gallery.list": return store.listGallery(asInput<"gallery.list">(input)) as CommandOutput<K>;
      case "gallery.get": return store.getGallery(asInput<"gallery.get">(input).id) as CommandOutput<K>;
      case "gallery.rate": { const body = asInput<"gallery.rate">(input); const item = store.rateGallery(body.id, { score: body.score, liked: body.liked, note: body.note }); workspaceChanged("gallery", [body.id]); return item as CommandOutput<K>; }
      case "gallery.delete": {
        const id = asInput<"gallery.delete">(input).id;
        const stored = store.getGenerationFile(id);
        const removed = await new OutputStore(stored.outputRoot).remove(stored.file);
        if (!removed) return { deleted: false } as CommandOutput<K>;
        const deleted = store.deleteGallery(id);
        if (deleted) workspaceChanged("gallery", [id]);
        return { deleted } as CommandOutput<K>;
      }
      case "gallery.export": { const body = asInput<"gallery.export">(input); const item = store.getGallery(body.id); const stored = store.getGenerationFile(body.id); const bytes = await new OutputStore(stored.outputRoot).read(stored.file); const relative = `exports/${item.id}.png`; await output.write(relative, bytes, body.includeMetadata ? item : undefined); return { saved: true } as CommandOutput<K>; }
      case "settings.get": return readSettings() as CommandOutput<K>;
      case "settings.update": { const inputSettings = asInput<"settings.update">(input); const current = readSettings(); const normalizedOutput = inputSettings.outputDirectory ? path.resolve(inputSettings.outputDirectory) : undefined; const next = { ...current, ...inputSettings, ...(normalizedOutput ? { outputDirectory: normalizedOutput } : {}) }; if (normalizedOutput && normalizedOutput !== outputRoot) { outputRoot = normalizedOutput; output = new OutputStore(outputRoot); } store.setSetting("app", JSON.stringify(next)); emit({ type: "settings.changed", settings: next }); return next as CommandOutput<K>; }
      default: error("NOT_SUPPORTED", "errors.NOT_SUPPORTED");
    }
  };

  function readSettings(): Settings {
    const stored = store.getSetting("app");
    const current = stored ? (() => { try { return JSON.parse(stored) as Partial<Settings>; } catch { return {}; } })() : {};
    return { ...DEFAULT_SETTINGS, outputDirectory: outputRoot, ...current };
  }

  const call = async <K extends Command>(name: K, input: CommandInput<K>, context?: CallContext): Promise<CommandOutput<K>> => {
    try { return await command(name, parseCommandInput(name, input), context); } catch (cause) { throw asStudioError(cause); }
  };

  return {
    call,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    readImage,
    close() {
      if (closing) return closing;
      closed = true;
      store.requestStopAll();
      // Preserve the result of the current request before closing SQLite.
      closing = queue.then(() => store.close());
      return closing;
    },
  };
}

export default createStudioService;
