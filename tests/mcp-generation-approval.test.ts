import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Connection } from "../contracts/studio";
import { makeRecipe } from "../core/recipe/model";
import { createStudioService } from "../services/studio";

const profiles: string[] = [];
const currentAccount = {
  tier: 0,
  active: true,
  usage: { percent: 50, isNegative: false },
  trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 },
};

async function tempProfile() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nai-mcp-auto-approval-"));
  profiles.push(dataDir);
  return dataDir;
}

afterEach(async () => { await Promise.all(profiles.splice(0).map(dataDir => rm(dataDir, { recursive: true, force: true }))); });

function connection(id: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id,
    name: "Synthetic MCP connection",
    permissions: { read: true, write: true, generate: true, images: false },
    maxImages: 2,
    maxAnlas: 100_000,
    created_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

const mcp = (connection: Connection) => ({ source: "mcp" as const, connection });
const normalRecipe = () => makeRecipe("MCP approval fixture", [{ type: "scene", tags: ["indoors"], text: "" }]);
const paidAccountFetch = vi.fn(async () => Response.json(currentAccount));

describe("MCP generation prepare approval", () => {
  it("auto-approves an eligible MCP plan but does not start a generation", async () => {
    const dataDir = await tempProfile();
    const current = connection("mcp-auto-approved");
    const getConnection = vi.fn(async (id: string) => id === current.id ? current : null);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/subscription")) return Response.json(currentAccount);
      throw new Error("Unexpected image generation request");
    }) as typeof fetch;
    const service = createStudioService({ dataDir, getToken: async () => "synthetic-token", fetch: fetchImpl, getConnection });
    try {
      const plan = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 31 }, mcp(current));

      expect(plan.estimatedAnlas).toBeGreaterThan(0);
      expect(Number.isFinite(plan.estimatedAnlas)).toBe(true);
      expect(plan.findings.some(finding => finding.severity === "error")).toBe(false);
      expect(plan.approved).toBe(true);
      expect(plan.connectionId).toBe(current.id);
      expect(getConnection).toHaveBeenCalledWith(current.id);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await service.call("generation.list", {})).toEqual([]);
      expect((await service.call("gallery.list", {})).total).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("rejects an auto-approved plan when the verified quote changes before start", async () => {
    const dataDir = await tempProfile();
    const current = connection("changed-quote");
    let subscription: unknown = { tier: 0, active: true, usage: { percent: 50, isNegative: false }, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 } };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/subscription")) return Response.json(subscription);
      throw new Error("Image generation must not start after a quote change");
    }) as typeof fetch;
    const service = createStudioService({
      dataDir,
      getToken: async () => "synthetic-token",
      fetch: fetchImpl,
      getConnection: async id => id === current.id ? current : null,
    });
    try {
      const context = mcp(current);
      const plan = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 311 }, context);
      expect(plan.estimatedAnlas).toBeGreaterThan(0);
      expect(plan.approved).toBe(true);

      subscription = { tier: 3, active: true, usage: { percent: 50, isNegative: false }, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 } };
      await expect(service.call("generation.start", { planId: plan.id, requestId: "changed-quote" }, context))
        .rejects.toMatchObject({ data: { code: "COST_CHANGED" } });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await service.call("generation.list", {})).toEqual([]);
      expect((await service.call("gallery.list", {})).total).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("keeps UI-prepared plans unapproved", async () => {
    const dataDir = await tempProfile();
    const current = connection("ui-plan");
    const getConnection = vi.fn(async () => current);
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true, getConnection });
    try {
      const plan = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 32 }, { source: "ui" });
      expect(plan.approved).toBe(false);
      expect(getConnection).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("auto-approves a dry-run MCP plan only after checking a live connection", async () => {
    const dataDir = await tempProfile();
    const current = connection("dry-run-mcp");
    const getConnection = vi.fn(async (id: string) => id === current.id ? current : null);
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true, getConnection });
    try {
      const plan = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 320 }, mcp(current));
      expect(plan).toMatchObject({ estimatedAnlas: 0, account: null, approved: true });
      expect(getConnection).toHaveBeenCalledWith(current.id);
      expect(await service.call("generation.list", {})).toEqual([]);
    } finally {
      await service.close();
    }
  });

  it.each([
    { name: "image limit", connection: connection("too-many-images", { maxImages: 1 }), recipe: normalRecipe(), count: 2 },
    { name: "Anlas limit", connection: connection("too-many-anlas", { maxAnlas: 1 }), recipe: normalRecipe(), count: 1 },
    { name: "validation error", connection: connection("invalid-recipe"), recipe: makeRecipe("Invalid", [{ type: "scene", tags: ["#if invalid"], text: "" }]), count: 1 },
  ])("leaves an over-limit or invalid $name plan pending and refuses to start it", async ({ connection: current, recipe, count }) => {
    const dataDir = await tempProfile();
    const service = createStudioService({
      dataDir,
      getToken: async () => "synthetic-token",
      fetch: paidAccountFetch as unknown as typeof fetch,
      getConnection: async id => id === current.id ? current : null,
    });
    try {
      const plan = await service.call("generation.prepare", { recipe, count, seed: 33 }, mcp(current));
      expect(plan.approved).toBe(false);
      if (current.id === "invalid-recipe") expect(plan.findings.some(finding => finding.severity === "error")).toBe(true);
      await expect(service.call("generation.start", { planId: plan.id, requestId: `blocked-${current.id}` }, mcp(current)))
        .rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
      expect(await service.call("generation.list", {})).toEqual([]);
    } finally {
      await service.close();
    }
  });

  it("does not auto-approve an unknown estimate", async () => {
    const dataDir = await tempProfile();
    const current = connection("unknown-estimate");
    const fetchImpl = vi.fn(async () => Response.json({}));
    const service = createStudioService({ dataDir, getToken: async () => "synthetic-token", fetch: fetchImpl as unknown as typeof fetch, getConnection: async () => current });
    try {
      const plan = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 34 }, mcp(current));
      expect(plan.estimatedAnlas).toBeNull();
      expect(plan.approved).toBe(false);
      await expect(service.call("generation.start", { planId: plan.id, requestId: "unknown-cost" }, mcp(current)))
        .rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
    } finally {
      await service.close();
    }
  });

  it("fails closed when the live MCP connection is revoked or has lower limits", async () => {
    const dataDir = await tempProfile();
    const supplied = connection("stale-context");
    let live: Connection | null = null;
    const getConnection = vi.fn(async () => live);
    const service = createStudioService({
      dataDir,
      getToken: async () => "synthetic-token",
      fetch: vi.fn(async () => Response.json(currentAccount)) as unknown as typeof fetch,
      getConnection,
    });
    try {
      const revoked = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 35 }, mcp(supplied));
      expect(revoked.approved).toBe(false);

      live = connection(supplied.id, { maxImages: 0 });
      const imageLimitLowered = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 36 }, mcp(supplied));
      expect(imageLimitLowered.approved).toBe(false);

      live = connection(supplied.id, { maxAnlas: 0 });
      const anlasLimitLowered = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 37 }, mcp(supplied));
      expect(anlasLimitLowered.approved).toBe(false);

      live = connection(supplied.id, { permissions: { ...supplied.permissions, generate: false } });
      const permissionRevoked = await service.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 38 }, mcp(supplied));
      expect(permissionRevoked.approved).toBe(false);
      expect(getConnection).toHaveBeenCalledTimes(4);
    } finally {
      await service.close();
    }
  });

  it("does not retroactively approve an older pending MCP plan", async () => {
    const dataDir = await tempProfile();
    const oldConnection = connection("legacy-pending");
    const earlierService = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
    let planId = "";
    try {
      const plan = await earlierService.call("generation.prepare", { recipe: normalRecipe(), count: 1, seed: 39 }, mcp(oldConnection));
      planId = plan.id;
      expect(plan.approved).toBe(false);
    } finally {
      await earlierService.close();
    }

    const reopened = createStudioService({ dataDir, getToken: async () => null, dryRun: true, getConnection: async () => oldConnection });
    try {
      const pending = await reopened.call("generation.pending", {});
      expect(pending.find(plan => plan.id === planId)?.approved).toBe(false);
      await expect(reopened.call("generation.start", { planId, requestId: "legacy-plan" }, mcp(oldConnection)))
        .rejects.toMatchObject({ data: { code: "APPROVAL_REQUIRED" } });
    } finally {
      await reopened.close();
    }
  });
});
