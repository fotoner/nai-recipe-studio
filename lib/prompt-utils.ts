/**
 * Prompt string helpers shared by the composer, the linter and the NAI client.
 * sanitizePrompt is a 1:1 port of sanitize_prompt() in scripts/nai_gen.py.
 */

/** Opening weight tokens: "0.8::", "-1::", "1.5::" at the start of a tag. Ported from _OPEN_WEIGHT. */
const OPEN_WEIGHT = /(?:^|(?<=,)|(?<=,\s)|(?<=\s))-?\d*\.?\d+::/g;
/** A digit glued to a "::" — ported from _DIGIT_CLOSE. */
const DIGIT_CLOSE = /(\d)::/g;

/**
 * The V5 parser reads a digit-ending tag like `sample123::` as a weight token.
 * Insert a space between a trailing digit and a CLOSING `::`; opening weights (`0.8::`) are left alone.
 */
export function sanitizePrompt(prompt: string): string {
  if (!prompt) return prompt;
  const guarded: [number, number][] = [];
  OPEN_WEIGHT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_WEIGHT.exec(prompt)) !== null) guarded.push([m.index, m.index + m[0].length]);
  DIGIT_CLOSE.lastIndex = 0;
  return prompt.replace(DIGIT_CLOSE, (full, digit: string, offset: number) =>
    guarded.some(([a, b]) => a <= offset && offset < b) ? full : `${digit} ::`,
  );
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^,+|,+$/g, "").trim();

/** Join tag-ish fragments into a `, `-separated prompt line, dropping empties and duplicates. */
export function joinTags(list: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (!raw) continue;
    const t = norm(raw);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.join(", ");
}

/** Split a prompt line on commas that are not inside (), [], {} or <>. */
export function splitTags(str: string): string[] {
  if (!str) return [];
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of str) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { const t = norm(buf); if (t) out.push(t); buf = ""; continue; }
    buf += ch;
  }
  const t = norm(buf);
  if (t) out.push(t);
  return out;
}

export type ArtistRef = { name: string; weight: number };

const round2 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Pull artist references out of a prompt line: `N::artist:x::`, `artist:x`, `{artist:x}` (1.05), `[artist:x]` (0.95). */
export function extractArtists(prompt: string): ArtistRef[] {
  const out: ArtistRef[] = [];
  for (const tag of splitTags(prompt)) {
    let m = /^(-?\d+(?:\.\d+)?)\s*::\s*artist:(.+?)\s*::$/i.exec(tag);
    if (m) { out.push({ name: m[2].trim(), weight: parseFloat(m[1]) }); continue; }
    m = /^(\{+|\[+)\s*artist:(.+?)\s*(\}+|\]+)$/i.exec(tag);
    if (m) {
      const n = Math.min(m[1].length, m[3].length);
      const step = m[1][0] === "{" ? 1.05 : 0.95;
      out.push({ name: m[2].trim(), weight: round2(Math.pow(step, n)) });
      continue;
    }
    m = /^artist:(.+)$/i.exec(tag);
    if (m) out.push({ name: m[1].trim(), weight: 1 });
  }
  return out;
}

/** Render one artist reference back to prompt syntax (weight 1 stays bare). */
export function artistTag(a: ArtistRef): string {
  return a.weight === 1 ? `artist:${a.name}` : `${a.weight}::artist:${a.name}::`;
}

/** Danbooru-style count tag for a cast. One member -> "solo". */
export function countTag(genders: readonly ("girl" | "boy" | "other")[]): string {
  if (genders.length === 0) return "";
  if (genders.length === 1) return "solo";
  const n = { girl: 0, boy: 0, other: 0 };
  for (const g of genders) n[g] += 1;
  const parts: string[] = [];
  if (n.girl) parts.push(n.girl === 1 ? "1girl" : `${n.girl}girls`);
  if (n.boy) parts.push(n.boy === 1 ? "1boy" : `${n.boy}boys`);
  if (n.other) parts.push(n.other === 1 ? "1other" : `${n.other}others`);
  return parts.join(", ");
}

/** Matches a count tag such as "2girls", "1boy", "3others", "solo". */
export const COUNT_TAG_RE = /^(?:solo|\d+\s*(?:girls?|boys?|others?))$/i;

/** Split a string into its content head and a trailing `Text: ...` render block (V5 puts it last). */
export function splitTextRender(s: string): { head: string; text: string } {
  const i = s.indexOf("Text:");
  if (i < 0) return { head: s, text: "" };
  return { head: s.slice(0, i).replace(/[,\s]+$/, ""), text: s.slice(i).trim() };
}
