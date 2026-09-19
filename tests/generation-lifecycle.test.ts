import { expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudioService } from "../services/studio";
import type { Connection } from "../contracts/studio";
import { makeRecipe } from "../core/recipe/model";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) break;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    value = await read();
  }
  if (done(value)) return value;
  throw new Error("job did not settle");
}
const recipe = makeRecipe("Synthetic queue", [{ type: "scene", tags: ["blue sky"], text: "" }]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

it("quotes and generates each image using the same current credential", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nai-credential-switch-"));
  let token = "synthetic-a";
  const imageTokens: string[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/subscription")) return Response.json({ tier: 0, active: true, usage: { percent: 50, isNegative: false }, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 } });
    imageTokens.push(new Headers(init?.headers).get("authorization") ?? "");
    token = "synthetic-b";
    return new Response(png, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const service = createStudioService({ dataDir, getToken: async () => token, fetch: fetchImpl });
  try {
    const plan = await service.call("generation.prepare", { recipe, count: 2 });
    await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
    const job = await service.call("generation.start", { planId: plan.id, requestId: "credential-switch" });
    await until(() => service.call("generation.status", { id: job.id }), job => job.state === "completed");
    expect(imageTokens).toEqual(["Bearer synthetic-a", "Bearer synthetic-b"]);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it("a saved output preference wins over the app's startup default", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nai-output-preference-"));
  const preferred = path.join(dataDir, "chosen");
  const first = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
  await first.call("settings.update", { outputDirectory: preferred });
  await first.close();
  const service = createStudioService({ dataDir, outputDir: path.join(dataDir, "default"), getToken: async () => null, dryRun: true });
  try {
    const saved = await service.call("recipes.save", { recipe });
    const plan = await service.call("generation.prepare", { recipe: saved, count: 1 });
    await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
    const job = await service.call("generation.start", { planId: plan.id, requestId: "startup-output" });
    await until(() => service.call("generation.status", { id: job.id }), job => job.state === "completed");
    expect(await readdir(path.join(preferred, "images", job.id))).toContainEqual(expect.stringMatching(/\.png$/));
    const listed = await service.call("recipes.list", {});
    expect(listed.items[0]).toMatchObject({ generation_count: 1, latest: { recipe_id: saved.id, url: expect.stringMatching(/^recipe-studio:\/\/app\/images\//) } });
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it("revoking a connection during one image prevents the next image", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nai-queue-revocation-"));
  const connection: Connection = { id: "synthetic-connection", name: "Synthetic", permissions: { read: true, write: true, generate: true, images: false }, maxImages: 2, maxAnlas: 100, created_at: new Date().toISOString() };
  let current: Connection | null = connection;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let requests = 0;
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/subscription")) return Response.json({ tier: 0, active: true, usage: { percent: 50, isNegative: false }, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 } });
    requests++; await pending;
    return new Response(png, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const service = createStudioService({ dataDir, getToken: async () => "synthetic", fetch: fetchImpl, getConnection: async () => current });
  try {
    const context = { source: "mcp" as const, connection };
    const plan = await service.call("generation.prepare", { recipe, count: 2 }, context);
    await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
    const job = await service.call("generation.start", { planId: plan.id, requestId: "revoked-queue" }, context);
    await until(async () => requests, requests => requests === 1);
    current = null; finish();
    const settled = await until(() => service.call("generation.status", { id: job.id }), job => ["failed", "completed"].includes(job.state));
    expect(settled).toMatchObject({ state: "failed", completed: 1, error: { code: "PERMISSION_DENIED" } });
    expect(requests).toBe(1);
  } finally { finish(); await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});
