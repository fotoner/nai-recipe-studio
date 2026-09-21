import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudioService } from "../services";
import { makeCharacter, makeRecipe } from "../core/recipe/model";

const tokenless = async () => null;

async function tempProfile() {
  return mkdtemp(path.join(tmpdir(), "nai-recipe-studio-backend-"));
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) break;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    value = await read();
  }
  if (done(value)) return value;
  throw new Error("Timed out waiting for backend job");
}

describe("studio service storage and public command boundary", () => {
  it("starts with only the generic palette and enforces recipe versions", async () => {
    const dataDir = await tempProfile();
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    try {
      const initial = await service.call("recipes.list", {});
      expect(initial).toEqual({ items: [], total: 0 });
      const presets = await service.call("presets.list", {});
      const builtinIds = presets.items.map(item => item.builtinId).filter(Boolean);
      expect(builtinIds).toEqual(expect.arrayContaining(["text-speech", "negative-default", "settings-default"]));
      expect(builtinIds.every(id => typeof id === "string" && id.length > 0)).toBe(true);

      const recipe = makeRecipe("Versioned recipe", [
        { type: "scene", tags: ["indoors"], text: "" },
        { type: "negative", base_preset: "heavy", rating: 0, extra: ["official art", "official style"] },
      ]);
      const first = await service.call("recipes.save", { recipe });
      expect(first.version).toBe(1);
      const second = await service.call("recipes.save", { recipe: { ...first, notes: "edited" }, expectedVersion: 1 });
      expect(second.version).toBe(2);
      await expect(service.call("recipes.save", { recipe: { ...second, notes: "missing expectation" } }))
        .rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" } });
      expect((await service.call("recipes.get", { id: first.id })).notes).toBe("edited");
      await expect(service.call("recipes.save", { recipe: { ...first, notes: "stale" }, expectedVersion: 1 })).rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" } });
      expect((await service.call("recipes.versions", { id: first.id })).map(version => version.version)).toEqual([2, 1]);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves character locks and stores user presets separately from built-ins", async () => {
    const dataDir = await tempProfile();
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    try {
      const character = await service.call("characters.save", { character: makeCharacter({ tag: "adult character", age_flag: "adult", locked: true }) });
      const edited = await service.call("characters.save", { character: { ...character, age_flag: "adult", locked: false } });
      expect(edited.locked).toBe(true);
      expect((await service.call("characters.delete", { id: character.id })).deleted).toBe(true);
      const reRegistered = await service.call("characters.save", { character: makeCharacter({ tag: character.tag, age_flag: "adult", locked: false }) });
      expect(reRegistered.locked).toBe(true);
      const secondCharacter = await service.call("characters.save", { character: makeCharacter({ tag: "second character", age_flag: "adult" }) });
      await expect(service.call("characters.save", { character: { ...secondCharacter, tag: reRegistered.tag } })).rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" } });
      const preset = await service.call("presets.save", { preset: { type: "scene", name: "My scene", block: { type: "scene", tags: ["park"], text: "" }, tags: [], notes: "" } });
      expect(preset.builtinId).toBeUndefined();
      expect((await service.call("presets.list", { query: "My scene" })).items).toHaveLength(1);
      await expect(service.call("presets.save", { preset: { type: "scene", name: "Mismatched", block: { type: "lighting", tags: ["soft"], text: "" }, tags: [], notes: "" } })).rejects.toMatchObject({ data: { code: "VALIDATION_FAILED" } });
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("enforces MCP connection permissions at the service boundary", async () => {
    const dataDir = await tempProfile();
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    const readOnly = {
      source: "mcp" as const,
      connection: {
        id: "read-only",
        name: "Read only",
        permissions: { read: true, write: false, generate: false, images: false },
        maxImages: 0,
        maxAnlas: 0,
        created_at: new Date().toISOString(),
      },
    };
    try {
      await expect(service.call("recipes.list", {}, readOnly)).resolves.toEqual({ items: [], total: 0 });
      await expect(service.call("recipes.save", { recipe: makeRecipe("Denied", []) }, readOnly)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } });
      await expect(service.call("status.read", {}, { source: "mcp" })).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } });
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects non-public recipe sources", async () => {
    const dataDir = await tempProfile();
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    try {
      const recipe = makeRecipe("Excluded source", []);
      await expect(service.call("recipes.save", { recipe: { ...recipe, source: "private-workflow:one" } })).rejects.toMatchObject({ data: { code: "VALIDATION_FAILED" } });
      await expect(service.call("recipe.compose", { recipe: { ...recipe, source: "external-queue:one" } })).rejects.toMatchObject({ data: { code: "VALIDATION_FAILED" } });
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("uses the persisted output directory after reopening the profile", async () => {
    const dataDir = await tempProfile();
    const outputDir = await tempProfile();
    const first = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    try {
      await first.call("settings.update", { outputDirectory: outputDir });
    } finally {
      await first.close();
    }
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    try {
      expect((await service.call("settings.get", {})).outputDirectory).toBe(outputDir);
      const plan = await service.call("generation.prepare", { recipe: makeRecipe("Persisted output", [{ type: "scene", tags: ["indoors"], text: "" }]), count: 1, seed: 9 });
      await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
      const job = await service.call("generation.start", { planId: plan.id, requestId: "persisted-output" }, { source: "ui" });
      const completed = await waitFor(() => service.call("generation.status", { id: job.id }), value => value.state === "completed");
      const gallery = await service.call("gallery.get", { id: completed.generationIds[0] });
      expect(gallery.url).toBe(`recipe-studio://app/images/${gallery.id}`);
      await expect(service.readImage(gallery.id)).resolves.toEqual(expect.any(Uint8Array));
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("publishes MCP plans for UI approval and binds them to their connection", async () => {
    const dataDir = await tempProfile();
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    const connection = {
      id: "connection-a",
      name: "Writer A",
      permissions: { read: true, write: true, generate: true, images: false },
      maxImages: 2,
      maxAnlas: 0,
      created_at: new Date().toISOString(),
    };
    const otherConnection = { ...connection, id: "connection-b", name: "Writer B" };
    const events: unknown[] = [];
    const unsubscribe = service.subscribe(event => events.push(event));
    try {
      const plan = await service.call("generation.prepare", { recipe: makeRecipe("MCP plan", [{ type: "scene", tags: ["indoors"], text: "" }]), count: 1, seed: 10 }, { source: "mcp", connection });
      expect(plan.connectionId).toBe(connection.id);
      expect(plan.connectionName).toBe(connection.name);
      expect(events).toContainEqual({ type: "generation.prepared", plan });
      expect((await service.call("generation.pending", {})).map(item => item.id)).toContain(plan.id);
      await expect(service.call("generation.start", { planId: plan.id, requestId: "wrong-owner" }, { source: "mcp", connection: otherConnection })).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } });
      await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
      const job = await service.call("generation.start", { planId: plan.id, requestId: "ui-start" }, { source: "ui" });
      expect((await service.call("generation.pending", {})).map(item => item.id)).not.toContain(plan.id);
      await waitFor(() => service.call("generation.status", { id: job.id }), value => ["completed", "cancelled", "failed"].includes(value.state));
    } finally {
      unsubscribe();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps pending plans visible and enforces connection image and Anlas budgets", async () => {
    const dataDir = await tempProfile();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      tier: 0,
      active: true,
      usage: { percent: 25, isNegative: false },
      trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const service = createStudioService({ dataDir, getToken: async () => "injected-token", fetch: fetchImpl });
    const connection = {
      id: "budget-connection",
      name: "Budget connection",
      permissions: { read: true, write: true, generate: true, images: false },
      maxImages: 1,
      maxAnlas: 100_000,
      created_at: new Date().toISOString(),
    };
    try {
      const recipe = makeRecipe("Budget plan", [{ type: "scene", tags: ["indoors"], text: "" }]);
      const imageLimited = await service.call("generation.prepare", { recipe, count: 2, seed: 12 }, { source: "mcp", connection });
      expect(imageLimited.estimatedAnlas).toBeGreaterThan(0);
      expect((await service.call("generation.pending", {})).map(item => item.id)).toContain(imageLimited.id);
      await service.call("generation.approve", { planId: imageLimited.id, allowPaid: true }, { source: "ui" });
      await expect(service.call("generation.start", { planId: imageLimited.id, requestId: "image-budget" }, { source: "mcp", connection }))
        .rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
      expect((await service.call("generation.pending", {})).map(item => item.id)).toContain(imageLimited.id);

      const anlasLimited = await service.call("generation.prepare", { recipe, count: 1, seed: 13 }, { source: "mcp", connection });
      const limitedConnection = { ...connection, maxImages: 1, maxAnlas: Math.max(0, (anlasLimited.estimatedAnlas ?? 1) - 1) };
      await service.call("generation.approve", { planId: anlasLimited.id, allowPaid: true }, { source: "ui" });
      await expect(service.call("generation.start", { planId: anlasLimited.id, requestId: "anlas-budget" }, { source: "mcp", connection: limitedConnection }))
        .rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps image reads and deletes tied to the generation output root", async () => {
    const dataDir = await tempProfile();
    const firstOutput = await tempProfile();
    const secondOutput = await tempProfile();
    const service = createStudioService({ dataDir, outputDir: firstOutput, getToken: tokenless, dryRun: true });
    try {
      const plan = await service.call("generation.prepare", { recipe: makeRecipe("Moved output", [{ type: "scene", tags: ["indoors"], text: "" }]), count: 1, seed: 11 });
      await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
      const job = await service.call("generation.start", { planId: plan.id, requestId: "moved-output" }, { source: "ui" });
      const completed = await waitFor(() => service.call("generation.status", { id: job.id }), value => value.state === "completed");
      const item = await service.call("gallery.get", { id: completed.generationIds[0] });
      const before = await service.readImage(item.id);
      await service.call("settings.update", { outputDirectory: secondOutput });
      await expect(service.readImage(item.id)).resolves.toEqual(before);
      await service.call("gallery.delete", { id: item.id });
      await expect(service.readImage(item.id)).rejects.toBeDefined();
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(firstOutput, { recursive: true, force: true });
      await rm(secondOutput, { recursive: true, force: true });
    }
  });

  it("keeps gallery metadata when removing its output file fails", async () => {
    const dataDir = await tempProfile();
    const outputDir = await tempProfile();
    const service = createStudioService({ dataDir, outputDir, getToken: tokenless, dryRun: true });
    try {
      const plan = await service.call("generation.prepare", { recipe: makeRecipe("Delete failure", [{ type: "scene", tags: ["indoors"], text: "" }]), count: 1, seed: 12 });
      await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
      const job = await service.call("generation.start", { planId: plan.id, requestId: "delete-failure" }, { source: "ui" });
      const completed = await waitFor(() => service.call("generation.status", { id: job.id }), value => value.state === "completed");
      const item = await service.call("gallery.get", { id: completed.generationIds[0] });
      const imagePath = path.join(outputDir, "images", job.id, `001-${plan.seeds[0]}.png`);
      await rm(imagePath);
      await mkdir(imagePath);

      await expect(service.call("gallery.delete", { id: item.id })).rejects.toBeDefined();
      await expect(service.call("gallery.get", { id: item.id })).resolves.toMatchObject({ id: item.id, recipe: item.recipe });
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe("generation service", () => {
  it("uses a zero quote in dry-run and requires UI approval", async () => {
    const dataDir = await tempProfile();
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    try {
      const recipe = makeRecipe("Generate me", [{ type: "scene", tags: ["indoors"], text: "" }, { type: "negative", base_preset: "heavy", rating: 0, extra: ["official art", "official style"] }]);
      const plan = await service.call("generation.prepare", { recipe, count: 2, seed: 42 });
      expect(plan.estimatedAnlas).toBe(0);
      expect(plan.approved).toBe(false);
      await expect(service.call("generation.approve", { planId: plan.id }, { source: "mcp" })).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } });
      const approved = await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
      expect(approved.approved).toBe(true);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not approve an expired generation plan", async () => {
    const dataDir = await tempProfile();
    const service = createStudioService({ dataDir, getToken: tokenless, dryRun: true });
    vi.useFakeTimers();
    try {
      const recipe = makeRecipe("Expiring plan", [{ type: "scene", tags: ["indoors"], text: "" }]);
      const plan = await service.call("generation.prepare", { recipe, count: 1, seed: 7 });
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      await expect(service.call("generation.approve", { planId: plan.id }, { source: "ui" })).rejects.toMatchObject({ data: { code: "PLAN_EXPIRED" } });
      await expect(service.call("generation.start", { planId: plan.id, requestId: "expired-plan" }, { source: "ui" })).rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
    } finally {
      await service.close();
      vi.useRealTimers();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("blocks approval when the production account quote is unknown", async () => {
    const dataDir = await tempProfile();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const service = createStudioService({ dataDir, getToken: async () => "injected-token", fetch: fetchImpl });
    try {
      const recipe = makeRecipe("Unknown quote", [{ type: "scene", tags: ["indoors"], text: "" }]);
      const plan = await service.call("generation.prepare", { recipe, count: 1, seed: 8 });
      expect(plan.estimatedAnlas).toBeNull();
      await expect(service.call("generation.approve", { planId: plan.id }, { source: "ui" })).rejects.toMatchObject({ data: { code: "COST_UNKNOWN" } });
      expect((await service.call("generation.pending", {})).map(item => item.id)).toContain(plan.id);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs one immutable plan sequentially, deduplicates request IDs, and supports gallery metadata", async () => {
    const dataDir = await tempProfile();
    const outputDir = await tempProfile();
    const service = createStudioService({ dataDir, outputDir, getToken: tokenless, dryRun: true });
    try {
      const character = await service.call("characters.save", { character: makeCharacter({ tag: "hero", series: "series", age_flag: "adult" }) });
      const scenePreset = await service.call("presets.save", { preset: { type: "scene", name: "Queued scene", block: { type: "scene", tags: ["indoors"], text: "" }, tags: [], notes: "" } });
      const recipe = makeRecipe("Queued recipe", [{ type: "cast", members: [{ character_id: character.id, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }] }, { type: "scene", preset_id: scenePreset.id, tags: ["indoors"], text: "" }, { type: "negative", base_preset: "heavy", rating: 0, extra: ["official art", "official style"] }]);
      const plan = await service.call("generation.prepare", { recipe, count: 2, seed: 100 });
      await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
      const first = await service.call("generation.start", { planId: plan.id, requestId: "request-1" }, { source: "ui" });
      const duplicate = await service.call("generation.start", { planId: plan.id, requestId: "request-1" }, { source: "ui" });
      expect(duplicate.id).toBe(first.id);
      await expect(service.call("generation.start", { planId: plan.id, requestId: "request-2" }, { source: "ui" })).rejects.toMatchObject({ data: { code: "IDEMPOTENCY_CONFLICT" } });
      const completed = await waitFor(() => service.call("generation.status", { id: first.id }), job => job.state === "completed");
      expect(completed.generationIds).toHaveLength(2);
      expect(completed.generationIds[0]).not.toBe(completed.generationIds[1]);
      const gallery = await service.call("gallery.list", {});
      expect(gallery.items).toHaveLength(2);
      const metadata = gallery.items[0] as typeof gallery.items[number] & { characters: unknown[]; settings: { width: number } };
      expect(metadata.characters).toEqual(expect.any(Array));
      expect(metadata.settings.width).toBe(832);
      expect((await service.call("gallery.list", { characterIds: [character.id] })).total).toBe(2);
      expect((await service.call("gallery.list", { presetIds: [scenePreset.id] })).total).toBe(2);
      const newest = await service.call("gallery.list", { sort: "newest" });
      const oldest = await service.call("gallery.list", { sort: "oldest" });
      expect(newest.items.map(item => item.id)).toEqual([...oldest.items].reverse().map(item => item.id));
      const rated = await service.call("gallery.rate", { id: gallery.items[0].id, liked: true, score: 5, note: "keep" });
      expect(rated.liked).toBe(true);
      expect(rated.url).toBe(`recipe-studio://app/images/${rated.id}`);
      await expect(service.readImage(rated.id)).resolves.toEqual(expect.any(Uint8Array));
      expect((await service.call("gallery.delete", { id: rated.id })).deleted).toBe(true);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("cancels a queued job without starting the next network request", async () => {
    const dataDir = await tempProfile();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    let releaseGeneration!: () => void;
    let generationCalls = 0;
    const generationWait = new Promise<void>(resolve => { releaseGeneration = resolve; });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/user/subscription")) {
        return new Response(JSON.stringify({ tier: 0, active: true, usage: { percent: 25, isNegative: false }, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      generationCalls += 1;
      await generationWait;
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const service = createStudioService({ dataDir, getToken: async () => "injected-token", fetch: fetchImpl });
    try {
      const recipe = makeRecipe("Queued cancellation", [{ type: "scene", tags: ["indoors"], text: "" }]);
      const firstPlan = await service.call("generation.prepare", { recipe, count: 1, seed: 20 });
      const secondPlan = await service.call("generation.prepare", { recipe, count: 1, seed: 21 });
      await service.call("generation.approve", { planId: firstPlan.id, allowPaid: true }, { source: "ui" });
      await service.call("generation.approve", { planId: secondPlan.id, allowPaid: true }, { source: "ui" });
      const firstJob = await service.call("generation.start", { planId: firstPlan.id, requestId: "queued-first" }, { source: "ui" });
      const secondJob = await service.call("generation.start", { planId: secondPlan.id, requestId: "queued-second" }, { source: "ui" });
      await waitFor(async () => generationCalls, value => value === 1);
      const cancelled = await service.call("generation.cancel", { id: secondJob.id }, { source: "ui" });
      expect(cancelled.state).toBe("cancelled");
      releaseGeneration();
      await waitFor(() => service.call("generation.status", { id: firstJob.id }), value => value.state === "completed");
      await expect(service.call("generation.status", { id: secondJob.id })).resolves.toMatchObject({ state: "cancelled", completed: 0 });
      expect(generationCalls).toBe(1);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
