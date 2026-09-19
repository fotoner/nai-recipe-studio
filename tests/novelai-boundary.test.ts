import { describe, expect, it, vi } from "vitest";
import { fetchAccount, generateImage, extractPng } from "../adapters/novelai";
import { SettingsBlock } from "../lib/schema";

const subscription = { tier: 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 20 }, usage: { percent: 72, isNegative: false } };
const input = { token: "synthetic-token", prompt: "blue sky", negative: "blurry", seed: 12, characters: [], settings: SettingsBlock.parse({ type: "settings" }) };

describe("NovelAI account boundary", () => {
  it("parses the documented numeric tier and both Anlas balances", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(subscription));
    expect(await fetchAccount("synthetic-token", fetch)).toMatchObject({ tier: "opus", active: true, anlas: 120, usagePercent: 72, usageAvailable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("does not infer an Opus tier from arbitrary response text", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...subscription, tier: 1, note: "opus" }));
    expect(await fetchAccount("synthetic-token", fetch)).toMatchObject({ tier: "other" });
  });

  it("honors exhausted usage and treats malformed balances as unknown", async () => {
    const exhausted = vi.fn().mockResolvedValue(Response.json({ ...subscription, usage: { percent: 2, isNegative: true } }));
    expect(await fetchAccount("synthetic-token", exhausted)).toMatchObject({ usageAvailable: false });
    const invalid = vi.fn().mockResolvedValue(Response.json({ ...subscription, trainingStepsLeft: { fixedTrainingStepsLeft: "100" } }));
    expect(await fetchAccount("synthetic-token", invalid)).toMatchObject({ tier: "unknown", anlas: null });
  });
});

describe("image API uncertainty", () => {
  it("uses one image per request and sanitizes character and base prompts", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(png, { headers: { "content-type": "image/png" } }));
    const result = await generateImage({ ...input, prompt: "0.8::sample123::", characters: [{ prompt: "0.7::hero2::", uc: "blurry", x: 0.2, y: 0.6 }], fetchImpl });
    expect(result.png).toEqual(png);
    expect(result.payload.input).toBe("0.8::sample123 ::");
    expect(result.payload.parameters).toMatchObject({ n_samples: 1, qualityPresetId: "none", seed: 12, characterPrompts: [{ prompt: "0.7::hero2 ::", center: { x: 0.2, y: 0.6 } }] });
    expect(fetchImpl.mock.calls[0][1].headers["Content-Type"]).toContain("multipart/form-data; boundary=");
  });

  it("reports a lost response without retrying or exposing provider text", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("synthetic-token provider detail"));
    await expect(generateImage({ ...input, fetchImpl })).rejects.toMatchObject({ data: { code: "RESULT_UNKNOWN", retryable: false } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an authentication rejection from an uncertain server failure", async () => {
    await expect(generateImage({ ...input, fetchImpl: vi.fn().mockResolvedValue(new Response("private details", { status: 401 })) })).rejects.toMatchObject({ data: { code: "NOT_CONNECTED" } });
    await expect(generateImage({ ...input, fetchImpl: vi.fn().mockResolvedValue(new Response("private details", { status: 503 })) })).rejects.toMatchObject({ data: { code: "RESULT_UNKNOWN", retryable: false } });
  });

  it("does not accept truncated archives or text files as generated PNGs", () => {
    expect(() => extractPng(Buffer.from("PK\x03\x04"))).toThrow();
    expect(() => extractPng(Buffer.from("not an image"))).toThrow();
    expect(() => extractPng(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toThrow();
  });
});
