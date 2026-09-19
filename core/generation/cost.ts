import type { AccountStatus } from "../../contracts/studio";

export const FREE_PIXELS = 1024 * 1024;
export const FREE_STEPS = 28;
const A = 2.951823174884865e-6;
const B = 5.753298233447344e-7;
const V5_MULTIPLIER = 1.5;

export type CostSettings = { width: number; height: number; steps: number };
export type GenerationQuote = { estimatedAnlas: number | null; isFree: boolean; verified: boolean; perImage: number | null; count: number; reason: string };

export function estimateAnlas(settings: CostSettings): number {
  const px = settings.width * settings.height;
  const base = Math.ceil(A * px + B * px * settings.steps);
  return Math.max(2, Math.ceil(base * V5_MULTIPLIER));
}

/** Subscription data is a prerequisite for a free claim. Unknown is deliberately paid/unknown. */
export function quoteGeneration(settings: CostSettings, count: number, account: AccountStatus | null): GenerationQuote {
  const safeCount = Math.max(1, Math.trunc(count));
  const verified = !!account && account.tier !== "unknown" && Number.isFinite(account.anlas ?? NaN) && account.active !== false;
  if (!verified) return { estimatedAnlas: null, isFree: false, verified: false, perImage: null, count: safeCount, reason: "account_unverified" };
  const inFreeWindow = settings.width * settings.height <= FREE_PIXELS && settings.steps <= FREE_STEPS;
  if (account.tier === "opus" && inFreeWindow && (account.usageAvailable === false || !Number.isFinite(account.usagePercent ?? NaN) || (account.usagePercent ?? 0) <= 0)) {
    return { estimatedAnlas: null, isFree: false, verified: false, perImage: null, count: safeCount, reason: "usage_unavailable" };
  }
  const isFree = account.tier === "opus" && inFreeWindow;
  const perImage = isFree ? 0 : estimateAnlas(settings);
  return { estimatedAnlas: isFree ? 0 : perImage * safeCount, isFree, verified: true, perImage, count: safeCount, reason: isFree ? "verified_opus_free_window" : "estimated_paid_generation" };
}
