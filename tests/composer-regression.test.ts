import { describe, expect, it } from "vitest";
import type { Character, Recipe } from "../lib/schema";
import { compose, composeParts, previewText, SFW_GUARDS, UC_HEAVY, UC_LIGHT } from "../lib/composer";
import { splitTags } from "../lib/prompt-utils";

const ch = (p: Partial<Character> & { id: number; tag: string }): Character => ({
  series: "", display_name: "", gender: "girl", age_flag: "unknown", locked: false,
  fixed_traits: [], default_x: 0.5, default_y: 0.5, notes: "", ...p,
});

const CANON = ch({ id: 1, tag: "sample heroine", series: "sample series", age_flag: "minor", locked: true });
const ORIGINAL = ch({ id: 2, tag: "sample original", series: "", age_flag: "adult", fixed_traits: ["long black hair", "red eyes"] });
const BOY = ch({ id: 3, tag: "sample boy", series: "", gender: "boy", age_flag: "adult", fixed_traits: ["short brown hair"] });
const CHARS = [CANON, ORIGINAL, BOY];

const member = (id: number, extra: Record<string, unknown> = {}) => ({
  character_id: id, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [], ...extra,
});

const recipe = (blocks: Recipe["blocks"], rating = 0): Recipe => ({
  name: "t", tags: [], rating, blocks, source: "manual", notes: "",
});

const STYLE = {
  type: "style" as const,
  artists: [{ name: "sample artist a", weight: 0.9 }, { name: "sample artist b", weight: 1 }],
  year: "year 2026",
  quality: ["very aesthetic", "masterpiece"],
  minus: ["-1::artist collaboration::"],
};

describe("OC vs canon character tag", () => {
  it("sends fixed traits without the name tag for an OC, and only the tag for a canon character", () => {
    const oc = ch({ id: 9, tag: "my oc", series: "", age_flag: "adult", fixed_traits: ["black hair", "blue eyes"] });
    const canon = ch({ id: 10, tag: "sample heroine", series: "sample series", age_flag: "minor", fixed_traits: ["blonde hair"] });
    const rec = (id: number): Recipe => ({ name: "t", tags: [], rating: 0, source: "manual", notes: "", blocks: [
      { type: "cast", members: [{ character_id: id, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }], layout_preset: "solo", auto_leak_guard: true },
      { type: "scene", tags: ["cafe"], text: "" },
    ] });
    const a = compose(rec(9), [oc, canon]).base_prompt;
    expect(a.startsWith("solo, black hair, blue eyes, cafe")).toBe(true);
    expect(a.includes("my oc")).toBe(false);
    const b = compose(rec(10), [oc, canon]).base_prompt;
    expect(b.startsWith("solo, sample heroine, cafe")).toBe(true);
    expect(b.includes("blonde hair")).toBe(false);
  });
});

describe("compose: solo", () => {
  const r = recipe([
    { type: "cast", members: [member(1, { outfit: ["jacket"], expression: ["smiling"] })], layout_preset: "solo", auto_leak_guard: true },
    { type: "scene", tags: ["indoors"], text: "standing by a window" },
    { type: "composition", tags: ["upper body", "from below"], text: "" },
    { type: "lighting", tags: ["soft light"], text: "" },
    STYLE,
    { type: "negative", base_preset: "heavy", extra: ["official art", "official style"] },
    { type: "settings", width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "fixed", seed: 7, quality_preset: "none", uc_preset: "heavy" },
  ]);
  const c = compose(r, CHARS);
  const tags = splitTags(c.base_prompt);

  it("puts the count tag first and the character right after it", () => {
    expect(tags[0]).toBe("solo");
    expect(tags[1]).toBe("sample heroine");
  });

  it("keeps the validated block order", () => {
    const at = (t: string) => tags.indexOf(t);
    expect(at("jacket")).toBeLessThan(at("indoors"));
    expect(at("indoors")).toBeLessThan(at("upper body"));
    expect(at("upper body")).toBeLessThan(at("soft light"));
    expect(at("soft light")).toBeLessThan(at("0.9::artist:sample artist a::"));
    expect(at("0.9::artist:sample artist a::")).toBeLessThan(at("year 2026"));
    expect(at("year 2026")).toBeLessThan(at("masterpiece"));
    expect(at("masterpiece")).toBeLessThan(at("-1::artist collaboration::"));
  });

  it("renders weight 1 artists bare and sends no characterPrompts", () => {
    expect(c.base_prompt).toContain("artist:sample artist b");
    expect(c.base_prompt).not.toContain("1::artist:sample artist b");
    expect(c.characters).toEqual([]);
  });

  it("does not leak canon appearance traits and keeps the settings block", () => {
    expect(c.base_prompt).not.toContain("long black hair");
    expect(c.settings.seed).toBe(7);
    expect(previewText(c)).toContain("BASE");
  });
});

describe("compose: multi cast", () => {
  const r = recipe([
    {
      type: "cast",
      members: [member(2, { x: 0.3, y: 0.55, expression: ["smiling"], interactions: ["source#hug"] }), member(3, { x: 0.7, y: 0.55, uc: ["hat"] })],
      layout_preset: "side_by_side",
      auto_leak_guard: true,
    },
    { type: "scene", tags: ["outdoors"], text: "" },
    { type: "outfit", tags: ["casual clothes"], text: "" },
    STYLE,
    { type: "negative", base_preset: "light", extra: [] },
    { type: "settings", width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random", quality_preset: "none", uc_preset: "heavy" },
  ]);
  const c = compose(r, CHARS);

  it("computes the count tag from member genders", () => {
    expect(c.base_prompt.startsWith("1girl, 1boy,")).toBe(true);
  });

  it("keeps character tags out of the base prompt", () => {
    expect(c.base_prompt).not.toContain("sample original");
    expect(c.base_prompt).toContain("outdoors");
  });

  it("moves wardrobe/expression blocks into every characterPrompt (composition contract)", () => {
    expect(c.base_prompt).not.toContain("casual clothes");
    for (const ch of c.characters) expect(ch.prompt).toContain("casual clothes");
  });

  it("emits one characterPrompt per member starting with girl/boy", () => {
    expect(c.characters).toHaveLength(2);
    expect(c.characters[0].prompt.startsWith("girl, long black hair, red eyes")).toBe(true); // OC: traits, no name tag
    expect(c.characters[0].prompt).toContain("source#hug");
    expect(c.characters[0].prompt.endsWith("source#hug")).toBe(true); // interactions stay last
    expect(c.characters[1].prompt.startsWith("boy, short brown hair")).toBe(true);
    expect(c.characters.map(x => [x.x, x.y])).toEqual([[0.3, 0.55], [0.7, 0.55]]);
  });

  it("adds the other member's hair/eye tags as a leak guard", () => {
    expect(c.characters[0].uc).toContain("short brown hair");
    expect(c.characters[1].uc).toContain("long black hair");
    expect(c.characters[1].uc).toContain("hat");
  });

  it("respects auto_leak_guard = false", () => {
    const off = structuredClone(r);
    (off.blocks[0] as { auto_leak_guard: boolean }).auto_leak_guard = false;
    expect(compose(off, CHARS).characters[1].uc).toBe("hat");
  });
});

describe("compose: negative assembly", () => {
  const blocks = (rating: number, extra: string[], required: string[]): Recipe["blocks"] => [
    { type: "cast", members: [member(2)], layout_preset: "solo", auto_leak_guard: true },
    { type: "negative", base_preset: "heavy", rating, extra: [...extra, ...required] },
    { type: "nsfw", explicit_tags: ["nude"] },
  ];

  it("rating 0: heavy preset + extra + SFW guards, no explicit tags", () => {
    const c = compose(recipe(blocks(0, ["official art"], [])), CHARS);
    expect(c.negative.startsWith(UC_HEAVY)).toBe(true);
    expect(c.negative).toContain("official art");
    for (const g of SFW_GUARDS) expect(c.negative).toContain(g);
    expect(c.base_prompt).not.toContain("nude");
  });

  it("rating 2: required negatives instead of the SFW guards, explicit tags in the base", () => {
    const c = compose(recipe(blocks(2, ["official art"], ["mutated hands"]), 2), CHARS);
    expect(c.negative).toContain("mutated hands");
    expect(c.negative).not.toContain("nipples");
    expect(c.base_prompt).toContain("nude");
    expect(c.rating).toBe(2);
  });

  it("light and none presets", () => {
    const light = compose(recipe([{ type: "negative", base_preset: "light", extra: [] }, { type: "cast", members: [member(2)], layout_preset: "solo", auto_leak_guard: true }]), CHARS);
    expect(light.negative.startsWith(UC_LIGHT)).toBe(true);
    const none = compose(recipe([{ type: "negative", base_preset: "none", extra: ["blurry"] }, { type: "cast", members: [member(2)], layout_preset: "solo", auto_leak_guard: true }]), CHARS);
    expect(none.negative.startsWith("blurry")).toBe(true);
  });
});

describe("compose: sanitising", () => {
  it("spaces a digit before a CLOSING :: but leaves the opening weight alone", () => {
    const r = recipe([
      { type: "cast", members: [member(1)], layout_preset: "solo", auto_leak_guard: true },
      { type: "style", artists: [{ name: "sample123", weight: 0.8 }], year: "", quality: [], minus: [] },
    ]);
    const c = compose(r, CHARS);
    expect(c.base_prompt).toContain("0.8::artist:sample123 ::");
    expect(c.base_prompt).not.toContain("sample123::");
  });

  it("hoists a Text: render block to the very end", () => {
    const r = recipe([
      { type: "cast", members: [member(1)], layout_preset: "solo", auto_leak_guard: true },
      { type: "scene", tags: [], text: "english text, Text: hello" },
      { type: "style", artists: [], year: "year 2026", quality: [], minus: [] },
    ]);
    const c = compose(r, CHARS);
    expect(c.base_prompt.endsWith("Text: hello")).toBe(true);
    expect(c.base_prompt).toContain("english text");
    expect(composeParts(r, CHARS).base.at(-1)).toBe("year 2026");
  });
});
