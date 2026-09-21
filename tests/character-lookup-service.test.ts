import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createStudioService } from "../services/studio";

describe("character tag lookup", () => {
  it("queries public tags without credentials and normalizes suggestions for recipe tags", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-tag-lookup-"));
    const fetcher = vi.fn(async () => Response.json([{ name: "synthetic_character", category: 4, post_count: 25 }]));
    const getToken = vi.fn(async () => null);
    const service = createStudioService({ dataDir, getToken, fetch: fetcher });
    try {
      const result = await service.call("characters.tagLookup", { mode: "search", query: "synthetic char", kind: "character" });
      expect(result).toEqual([{ name: "synthetic character", tag: "synthetic_character", category: 4, post_count: 25 }]);
      const [requested, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
      const url = new URL(requested);
      expect(url.origin).toBe("https://danbooru.donmai.us");
      expect(url.searchParams.get("search[name_matches]")).toBe("synthetic_char*");
      expect(url.searchParams.get("search[category]")).toBe("4");
      expect(new Headers(options.headers).has("Authorization")).toBe(false);
      expect(getToken).not.toHaveBeenCalled();
    } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
  });

  it("sorts copyright suggestions by co-occurrence and specificity and reports upstream failures", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-tag-related-"));
    const fetcher = vi.fn(async () => Response.json({ related_tags: [
      { tag: { name: "broad_series", category: 3, post_count: 90 }, frequency: 0.91 },
      { tag: { name: "specific_series", category: 3, post_count: 10 }, frequency: 0.91 },
      { tag: { name: "unrelated_character", category: 4, post_count: 2 }, frequency: 1 },
    ] }));
    const service = createStudioService({ dataDir, getToken: async () => null, fetch: fetcher });
    try {
      const result = await service.call("characters.tagLookup", { mode: "related", tag: "synthetic character" });
      expect(result.map(item => item.tag)).toEqual(["specific_series", "broad_series"]);
      expect(result[0].frequency).toBe(0.91);
      fetcher.mockImplementation(async () => new Response("", { status: 503 }));
      await expect(service.call("characters.tagLookup", { mode: "related", tag: "synthetic character" })).rejects.toMatchObject({ data: { code: "TAG_LOOKUP_FAILED" } });
    } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
  });
});
