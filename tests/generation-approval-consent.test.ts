import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudioService } from "../services/studio";
import { makeRecipe } from "../core/recipe/model";

const account = (tier: number) => ({
  tier,
  active: true,
  usage: { percent: 50, isNegative: false },
  trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 },
});

describe("generation paid approval", () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("requires explicit paid consent and rejects unknown quotes before marking plans approved", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "nai-generation-consent-"));
    let subscription: unknown = account(3);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/user/subscription")) throw new Error("Unexpected image-generation request in consent test");
      return Response.json(subscription);
    }) as typeof fetch;
    const service = createStudioService({ dataDir, getToken: async () => "synthetic-token", fetch: fetchImpl });

    try {
      const freePlan = await service.call("generation.prepare", { recipe: makeRecipe("Free", []), count: 1, seed: 1 });
      expect(freePlan.estimatedAnlas).toBe(0);
      await expect(service.call("generation.approve", { planId: freePlan.id }, { source: "ui" })).resolves.toMatchObject({ approved: true });

      const paidRecipe = makeRecipe("Paid", [{ type: "settings", width: 1024, height: 1536, steps: 28 }]);
      subscription = account(0);
      const unpaidPlan = await service.call("generation.prepare", { recipe: paidRecipe, count: 1, seed: 2 });
      expect(unpaidPlan.estimatedAnlas).toBeGreaterThan(0);
      await expect(service.call("generation.approve", { planId: unpaidPlan.id }, { source: "ui" }))
        .rejects.toMatchObject({ data: { code: "PAID_CONFIRMATION_REQUIRED" } });
      expect((await service.call("generation.pending", {})).find(plan => plan.id === unpaidPlan.id)?.approved).toBe(false);

      await expect(service.call("generation.approve", { planId: unpaidPlan.id, allowPaid: true }, { source: "ui" }))
        .resolves.toMatchObject({ approved: true });

      subscription = {};
      const unknownPlan = await service.call("generation.prepare", { recipe: makeRecipe("Unknown", []), count: 1, seed: 3 });
      expect(unknownPlan.estimatedAnlas).toBeNull();
      await expect(service.call("generation.approve", { planId: unknownPlan.id, allowPaid: true }, { source: "ui" }))
        .rejects.toMatchObject({ data: { code: "COST_UNKNOWN" } });
      expect((await service.call("generation.pending", {})).find(plan => plan.id === unknownPlan.id)?.approved).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      await service.close();
    }
  });
});
