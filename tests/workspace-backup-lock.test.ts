import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallContext } from "../contracts/studio";
import type { WorkspaceBackupService } from "../services/workspace-backup";
import { OutputStore } from "../adapters/files";
import { makeRecipe } from "../core/recipe/model";
import { createStudioService } from "../services/studio";

const connection: NonNullable<CallContext["connection"]> = {
  id: "lock-test-connection",
  name: "Lock test connection",
  permissions: { read: true, write: true, generate: true, images: false },
  maxImages: 1,
  maxAnlas: 0,
  created_at: "2026-09-20T00:00:00.000Z",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function backupService(service: ReturnType<typeof createStudioService>): Pick<WorkspaceBackupService, "withExclusive"> {
  return (service as unknown as { workspaceBackup: WorkspaceBackupService }).workspaceBackup;
}

describe("workspace backup exclusive service lock", () => {
  it("blocks UI and MCP writes plus generation prepare/start, allows reads, then releases writes", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-backup-lock-"));
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
    const backup = backupService(service);
    const mcp: CallContext = { source: "mcp", connection };
    const finished = deferred();
    const entered = deferred();
    let exclusive: Promise<void> | undefined;
    try {
      const recipe = makeRecipe("Lock fixture", [{ type: "scene", tags: ["synthetic"], text: "" }]);
      const saved = await service.call("recipes.save", { recipe });
      const plan = await service.call("generation.prepare", { recipe: saved, count: 1, seed: 91 }, mcp);
      await service.call("generation.approve", { planId: plan.id }, { source: "ui" });

      exclusive = backup.withExclusive(async () => {
        entered.resolve();
        await finished.promise;
      });
      await entered.promise;

      await expect(service.call("recipes.list", {}, mcp)).resolves.toMatchObject({ total: 1 });
      await expect(service.call("recipes.save", { recipe: makeRecipe("Blocked UI write", []) })).rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });
      await expect(service.call("recipes.save", { recipe: makeRecipe("Blocked MCP write", []) }, mcp)).rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });
      await expect(service.call("generation.prepare", { recipe: saved, count: 1, seed: 92 }, { source: "ui" })).rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });
      await expect(service.call("generation.prepare", { recipe: saved, count: 1, seed: 93 }, mcp)).rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });
      await expect(service.call("generation.start", { planId: plan.id, requestId: "blocked-start" }, mcp)).rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });

      finished.resolve();
      await exclusive;
      await expect(service.call("recipes.save", { recipe: makeRecipe("Write after restore", []) })).resolves.toMatchObject({ name: "Write after restore" });
      await expect(service.call("generation.start", { planId: plan.id, requestId: "start-after-release" }, mcp)).resolves.toMatchObject({ planId: plan.id });
    } finally {
      finished.resolve();
      await exclusive?.catch(() => undefined);
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("waits for active withExclusive work before closing the SQLite store", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-backup-close-"));
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
    const backup = backupService(service);
    const hold = deferred();
    const entered = deferred();
    let exclusive: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      exclusive = backup.withExclusive(async () => {
        entered.resolve();
        await hold.promise;
      });
      await entered.promise;
      closing = service.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      hold.resolve();
      await Promise.all([exclusive, closing]);
      expect(closed).toBe(true);
    } finally {
      hold.resolve();
      await exclusive?.catch(() => undefined);
      await closing?.catch(() => undefined);
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses to acquire the backup lock while prepare is waiting on injected account lookup", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-backup-prepare-race-"));
    const fetchStarted = deferred();
    const fetchGate = deferred();
    const fetchImpl: typeof fetch = async () => {
      fetchStarted.resolve();
      await fetchGate.promise;
      return new Response(JSON.stringify({
        tier: 0,
        active: true,
        trainingStepsLeft: { fixedTrainingStepsLeft: 120, purchasedTrainingSteps: 0 },
        usage: { percent: 25, isNegative: false },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const service = createStudioService({ dataDir, getToken: async () => "synthetic-token", fetch: fetchImpl });
    const backup = backupService(service);
    let prepare: Promise<unknown> | undefined;
    try {
      prepare = service.call("generation.prepare", { recipe: makeRecipe("Prepare race", [{ type: "scene", tags: ["synthetic"], text: "" }]), count: 1, seed: 117 });
      await fetchStarted.promise;
      await expect(backup.withExclusive(async () => undefined)).rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });
      fetchGate.resolve();
      await expect(prepare).resolves.toMatchObject({ count: 1 });
    } finally {
      fetchGate.resolve();
      await prepare?.catch(() => undefined);
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses to acquire the backup lock while gallery deletion is awaiting file removal", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-backup-delete-race-"));
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
    const backup = backupService(service);
    const removeStarted = deferred();
    const removeGate = deferred();
    let deletion: Promise<unknown> | undefined;
    const removeSpy = vi.spyOn(OutputStore.prototype, "remove").mockImplementation(async () => {
      removeStarted.resolve();
      await removeGate.promise;
      return true;
    });
    try {
      const plan = await service.call("generation.prepare", { recipe: makeRecipe("Delete race", [{ type: "scene", tags: ["synthetic"], text: "" }]), count: 1, seed: 123 });
      const approved = await service.call("generation.approve", { planId: plan.id }, { source: "ui" });
      let finishJob!: () => void;
      const completed = new Promise<void>(resolve => { finishJob = resolve; });
      const unsubscribe = service.subscribe(event => {
        if (event.type === "job.changed" && event.job.state === "completed") finishJob();
      });
      try {
        await service.call("generation.start", { planId: approved.id, requestId: "delete-race-job" }, { source: "ui" });
        await completed;
      } finally { unsubscribe(); }
      const item = await service.call("gallery.list", { limit: 10 });
      const generationId = item.items[0]?.id;
      expect(generationId).toBeDefined();

      deletion = service.call("gallery.delete", { id: generationId! });
      await removeStarted.promise;
      await expect(backup.withExclusive(async () => undefined)).rejects.toMatchObject({ data: { code: "WORKSPACE_BUSY" } });
      removeGate.resolve();
      await expect(deletion).resolves.toMatchObject({ deleted: true });
    } finally {
      removeGate.resolve();
      removeSpy.mockRestore();
      await deletion?.catch(() => undefined);
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
