import { describe, expect, it } from "vitest";
import { parseCommandInput, type Command } from "../contracts/studio";

describe("command input boundary", () => {
  it("rejects inherited object keys as unknown commands", () => {
    expect(() => parseCommandInput("__proto__" as Command, {})).toThrow("UNKNOWN_COMMAND");
    expect(() => parseCommandInput("constructor" as Command, {})).toThrow("UNKNOWN_COMMAND");
  });

  it("does not accept client-supplied approval or unbounded generation", () => {
    expect(() => parseCommandInput("generation.start", { planId: "plan", requestId: "request", approved: true })).toThrow("VALIDATION_FAILED");
    expect(() => parseCommandInput("generation.prepare", { recipe: {}, count: 201 })).toThrow("VALIDATION_FAILED");
  });

  it("validates permissions and counts without silently coercing strings", () => {
    expect(() => parseCommandInput("ai.connections.create", { name: "AI", permissions: { read: true, write: false, generate: false, images: false }, maxImages: "1", maxAnlas: 0 })).toThrow("VALIDATION_FAILED");
    expect(parseCommandInput("recipes.list", { limit: 25, offset: 0 })).toEqual({ limit: 25, offset: 0 });
  });
});
