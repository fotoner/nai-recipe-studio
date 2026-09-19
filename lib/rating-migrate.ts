/**
 * 2026-09-20 block restructure: the rating (0/1/2) and its required negatives moved from the `nsfw` block into the
 * `negative` block ("등급·네거티브"); the `nsfw` block now holds explicit content tags only.
 * These functions accept the legacy shape and return the new one, so stored recipes, presets and API input keep working.
 * Dependency-free on purpose: schema.ts uses them in a zod preprocess.
 */
type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const uniq = (a: string[]) => [...new Set(a)];
const isLegacyNsfw = (b: Bag) => b.type === "nsfw" && ("rating" in b || "required_negatives" in b);

export function migrateLegacyBlocks(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  const legacy = blocks.find(b => isBag(b) && isLegacyNsfw(b)) as Bag | undefined;
  if (!legacy) return blocks;
  const rating = typeof legacy.rating === "number" ? legacy.rating : 0;
  const required = list(legacy.required_negatives);
  const out: unknown[] = [];
  let merged = false;
  for (const b of blocks) {
    if (!isBag(b)) { out.push(b); continue; }
    if (b === legacy) {
      const explicit = list(b.explicit_tags);
      if (explicit.length) {
        const { rating: _r, required_negatives: _n, ...rest } = b; void _r; void _n;
        out.push({ ...rest, explicit_tags: explicit });
      }
      continue;
    }
    if (b.type === "negative" && !merged) {
      merged = true;
      out.push({ ...b, rating: Math.max(rating, typeof b.rating === "number" ? b.rating : 0), extra: uniq([...list(b.extra), ...required]) });
      continue;
    }
    out.push(b);
  }
  if (!merged) out.push({ type: "negative", base_preset: "heavy", rating, extra: uniq(required) });
  return out;
}

/** A legacy nsfw preset without explicit tags was a rating setting: it becomes a negative-type preset. Act presets keep their tags only. */
export function migrateLegacyPreset<T extends { type: string; block: unknown }>(p: T): T {
  const b = p.block;
  if (!isBag(b) || !isLegacyNsfw(b)) return p;
  const explicit = list(b.explicit_tags);
  if (explicit.length) {
    const { rating: _r, required_negatives: _n, ...rest } = b; void _r; void _n;
    return { ...p, block: { ...rest, explicit_tags: explicit } };
  }
  const { explicit_tags: _e, required_negatives: _n, rating, type: _t, ...rest } = b; void _e; void _n; void _t;
  return { ...p, type: "negative", block: { ...rest, type: "negative", base_preset: "heavy", rating: typeof rating === "number" ? rating : 0,
    extra: uniq(["official art", "official style", ...list(b.required_negatives)]) } };
}
