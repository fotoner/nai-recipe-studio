import { describe, expect, it } from "vitest";
import { artistTag, countTag, extractArtists, joinTags, sanitizePrompt, splitTags, splitTextRender } from "../lib/prompt-utils";

describe("prompt utilities", () => {
  it("normalizes whitespace and deduplicates without changing the first spelling or input", () => {
    const input = [null, "", "  Blue   sky, ", "blue sky", undefined, "cloud"];
    expect(joinTags(input)).toBe("Blue sky, cloud");
    expect(input[2]).toBe("  Blue   sky, ");
  });
  it("does not split commas inside nested grouping syntax", () => {
    expect(splitTags("a, (b, [c, d]), {e, f}, <g, h>, , i")).toEqual(["a", "(b, [c, d])", "{e, f}", "<g, h>", "i"]);
    expect(splitTags("")).toEqual([]);
    expect(splitTags("a), b")).toEqual(["a)", "b"]);
  });
  it("sanitizes digit-ending tags idempotently, not opening weights", () => {
    const input = "0.8::artist:test123::, -1::test2::";
    const safe = "0.8::artist:test123 ::, -1::test2 ::";
    expect(sanitizePrompt(input)).toBe(safe);
    expect(sanitizePrompt(safe)).toBe(safe);
    expect(sanitizePrompt("")).toBe("");
  });
  it("extracts only artist references and keeps explicit and bracket weights", () => {
    expect(extractArtists("sky, artist:a, 0.8::artist:b::, {{artist:c}}, [artist:d]")).toEqual([
      { name: "a", weight: 1 }, { name: "b", weight: 0.8 }, { name: "c", weight: 1.1025 }, { name: "d", weight: 0.95 },
    ]);
    expect(artistTag({ name: "a", weight: 1 })).toBe("artist:a");
    expect(artistTag({ name: "b", weight: 0.8 })).toBe("0.8::artist:b::");
  });
  it.each([
    [[], ""], [["girl"], "solo"], [["girl", "boy", "other"], "1girl, 1boy, 1other"],
    [["girl", "girl", "boy", "boy", "other", "other"], "2girls, 2boys, 2others"],
  ] as const)("counts the cast %j", (genders, expected) => expect(countTag(genders)).toBe(expected));
  it("preserves the render-text tail while trimming the preceding separator", () => {
    expect(splitTextRender("scene, Text: hello, world")).toEqual({ head: "scene", text: "Text: hello, world" });
    expect(splitTextRender("scene")).toEqual({ head: "scene", text: "" });
  });
});
