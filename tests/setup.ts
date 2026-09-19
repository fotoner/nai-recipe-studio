import { afterEach, beforeEach, expect, vi } from "vitest";

let unexpectedRequests: number;
beforeEach(() => {
  vi.clearAllMocks();
  unexpectedRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    unexpectedRequests++;
    throw new Error("Unexpected network request: inject a test double");
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(unexpectedRequests, "A test attempted an unmocked network request").toBe(0);
});
