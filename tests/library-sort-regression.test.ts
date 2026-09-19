import { describe, expect, it } from "vitest";
import { sortLibraryItems as sortPresets } from "../lib/library-sort";
const presetCard = (id?: number, fields: { usage?: number; created_at?: string; id?: number } = {}) => ({ id, usage: 0, created_at: "", ...fields });

describe("preset sorting", () => {
  const oldest = presetCard(1, { usage: 9, created_at: "2026-09-01 00:00:00" });
  const newest = presetCard(3, { usage: 1, created_at: "2026-09-03 00:00:00" });
  const popular = presetCard(2, { usage: 12, created_at: "2026-09-02 00:00:00" });
  const list = [oldest, newest, popular];

  it("defaults to most used first", () => {
    expect(sortPresets(list).map(p => p.id)).toEqual([2, 1, 3]);
  });
  it("sorts by creation date, not usage or last edit", () => {
    expect(sortPresets(list.map(p => ({ ...p, updated_at: "2099-01-01" })), "newest").map(p => p.id)).toEqual([3, 2, 1]);
  });
  it("breaks usage ties by creation time, then id", () => {
    expect(sortPresets(list.map(p => ({ ...p, usage: 0 }))).map(p => p.id)).toEqual([3, 2, 1]);
    expect(sortPresets([presetCard(1), presetCard(3), presetCard(2)]).map(p => p.id)).toEqual([3, 2, 1]);
  });
  it("does not mutate the fetched list or its items", () => {
    const input = Object.freeze(list.map(p => Object.freeze({ ...p })));
    const sorted = sortPresets(input);
    expect(input.map(p => p.id)).toEqual([1, 3, 2]);
    expect(sorted).not.toBe(input);
    expect(sorted[0]).toBe(input[2]);
  });
  it("handles missing and invalid dates deterministically", () => {
    const input = [presetCard(4, { created_at: "invalid" }), presetCard(2, { created_at: undefined }), newest];
    expect(sortPresets(input, "newest").map(p => p.id)).toEqual([3, 4, 2]);
  });
  it("compares SQLite UTC dates and ISO dates consistently", () => {
    const input = [presetCard(1, { created_at: "2026-09-01 03:00:00" }), presetCard(2, { created_at: "2026-09-01T11:00:00+09:00" })];
    expect(sortPresets(input, "newest").map(p => p.id)).toEqual([1, 2]);
  });
  it("handles empty lists and presets without ids", () => {
    expect(sortPresets([])).toEqual([]);
    const input = [presetCard(undefined, { id: undefined, created_at: undefined })];
    expect(sortPresets(input)).toEqual(input);
    const unsaved = [{ id: undefined, name: "first" }, { id: undefined, name: "second" }];
    expect(sortPresets(unsaved)).toEqual(unsaved);
  });
  it("uses character generation counts and creation time with the same rules", () => {
    const chars = [{ id: 1, generation_count: 10 }, { id: 3, generation_count: 2 }, { id: 2, generation_count: 10 }];
    expect(sortPresets(chars).map(c => c.id)).toEqual([2, 1, 3]);
    expect(sortPresets(chars, "newest").map(c => c.id)).toEqual([3, 2, 1]);
  });
  it("sorts least generated first, including unused items, without reversing tie order", () => {
    expect(sortPresets([...list, presetCard(4, { usage: 0 })], "usage_asc").map(p => p.id)).toEqual([4, 3, 1, 2]);
    const chars = [{ id: 1, generation_count: 2 }, { id: 2, generation_count: 0 }, { id: 3, generation_count: 2 }];
    expect(sortPresets(chars, "usage_asc").map(c => c.id)).toEqual([2, 3, 1]);
  });
  it("supports oldest registration first with deterministic ties", () => {
    expect(sortPresets(list, "oldest").map(p => p.id)).toEqual([1, 2, 3]);
  });
});
