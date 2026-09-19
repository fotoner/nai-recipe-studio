import { describe, expect, it } from "vitest";
import { quoteGeneration } from "../core/generation/cost";
import type { AccountStatus } from "../contracts/studio";

const settings = { width: 832, height: 1216, steps: 28 };
const account = (overrides: Partial<AccountStatus> = {}): AccountStatus => ({ tier: "opus", anlas: 100, usagePercent: 50, checkedAt: new Date().toISOString(), ...overrides });

describe("verified generation estimates", () => {
  it("charges a non-Opus account inside the Opus size window", () => {
    expect(quoteGeneration(settings, 2, account({ tier: "other" }))).toMatchObject({ estimatedAnlas: 60, perImage: 30, isFree: false });
  });

  it("does not call an exhausted or inactive Opus account free", () => {
    expect(quoteGeneration(settings, 1, account({ usagePercent: 0 }))).toMatchObject({ estimatedAnlas: null, isFree: false });
    expect(quoteGeneration(settings, 1, account({ active: false }))).toMatchObject({ isFree: false });
    expect(quoteGeneration(settings, 1, account({ usageAvailable: false }))).toMatchObject({ estimatedAnlas: null, isFree: false });
  });

  it("allows a paid tier without an Opus usage meter and preserves boundary prices", () => {
    expect(quoteGeneration(settings, 1, account({ tier: "other", usagePercent: null }))).toMatchObject({ estimatedAnlas: 30, verified: true });
    expect(quoteGeneration({ width: 1024, height: 1024, steps: 28 }, 1, account())).toMatchObject({ estimatedAnlas: 0, isFree: true });
    expect(quoteGeneration({ width: 1024, height: 1536, steps: 28 }, 1, account())).toMatchObject({ estimatedAnlas: 45, isFree: false });
  });
});
