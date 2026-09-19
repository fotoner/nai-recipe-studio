/**
 * Content gate. Non-negotiable, not overridable by any user setting:
 *  (a) rating >= 1 cannot combine with canonical or registered minors
 *      (adult and unspecified/unknown are allowed);
 *  (b) MINOR_CODED_TAGS can never appear anywhere in a rating >= 1 recipe.
 * Used by lint rule L14 and by the generate route before any API call.
 */
import { MINOR_CODED_TAGS } from "./schema";
import type { Character, CastMember } from "./schema";

/** Canonical restrictions survive age edits. Other unspecified ages are allowed; missing rows are not. */
export function allowsNsfwCast(c: Character | undefined | null): boolean {
  return !!c && !c.locked && c.age_flag !== "minor";
}

export type PolicyResult = { ok: boolean; reason: string };

/** Minor-coded tokens found in the given strings (substring match, deliberately conservative). */
export function findMinorCodedTags(strings: readonly string[]): string[] {
  const hay = strings.filter(Boolean).join(" , ").toLowerCase();
  return MINOR_CODED_TAGS.filter(t => hay.includes(t.toLowerCase()));
}

/**
 * @param rating  0 all-ages / 1 sensitive / 2 explicit
 * @param members cast members of the recipe
 * @param characters character registry rows to resolve member.character_id against
 * @param allTags every tag/text string of the recipe (base, members, negatives included)
 */
export function canCombine(
  rating: number,
  members: readonly CastMember[],
  characters: readonly Character[],
  allTags: readonly string[],
): PolicyResult {
  const coded = findMinorCodedTags(allTags);
  if (rating >= 1 && coded.length) {
    return { ok: false, reason: `minor-coded tags can never combine with rating ${rating}: ${coded.join(", ")}` };
  }
  if (rating < 1) return { ok: true, reason: "" };
  if (members.length === 0) return { ok: false, reason: `rating ${rating} needs a cast, but no cast member is set` };
  const byId = new Map(characters.map(c => [c.id ?? -1, c]));
  const bad: string[] = [];
  for (const m of members) {
    const c = byId.get(m.character_id);
    if (!c) { bad.push(`#${m.character_id} (unknown character)`); continue; }
    if (!allowsNsfwCast(c)) bad.push(`${c.tag} (${c.locked ? "canonical minor" : c.age_flag})`);
  }
  if (bad.length) return { ok: false, reason: `rating ${rating} cannot combine with a minor-setting character; blocked by ${bad.join(", ")}` };
  return { ok: true, reason: "" };
}

/**
 * Sexual-content dictionary for the second gate: these tags in CONTENT (tag blocks, member outfit/expression,
 * nsfw explicit tags) cannot combine with a minor-setting cast at any rating, and imply the minimum rating
 * the recipe must carry. Unspecified age is allowed. Negatives are never scanned.
 */
export const SEXUAL_TAGS_HARD = [
  "nude", "completely nude", "topless", "bottomless", "nipples", "areolae", "pussy", "vagina", "penis", "anus", "sex", "vaginal", "anal",
  "fellatio", "paizuri", "handjob", "cunnilingus", "masturbation", "fingering", "cum", "after sex", "ahegao", "spread pussy", "uncensored",
  "pussy juice", "sex from behind", "girl on top", "cowgirl position", "missionary", "doggystyle", "fucked silly",
  "futanari", "futa with female", "futa with futa", "futanari masturbation", "full-package futanari", "tribadism", "scissoring", "breast sucking",
  "strap-on", "mutual masturbation", "frottage", "penises touching", "erection", "testicles", "large penis", "huge penis", "veiny penis", "precum",
  "oral", "cum in pussy", "cum on body", "cum on breasts", "internal cumshot", "imminent penetration", "clothed sex",
  "reverse cowgirl position", "prone bone", "spooning", "mating press", "full nelson", "suspended congress", "standing sex", "upright straddle",
  "reverse upright straddle", "thigh sex", "intercrural", "69", "deepthroat", "irrumatio", "ejaculation", "cumdrip", "cum overflow", "orgasm",
  "female ejaculation", "facesitting", "double penetration", "sex toy", "vibrator", "dildo", "clothed female nude male", "against wall",
];
export const SEXUAL_TAGS_SOFT = [
  "panties", "underwear", "underwear only", "lingerie", "bra", "garter belt", "see-through", "no panties", "no bra", "naked shirt", "naked towel",
  "naked apron", "cameltoe", "nipple slip", "panty pull", "panties around one leg", "undressing", "micro bikini", "string bikini", "sling bikini",
  "spread legs", "presenting", "heart-shaped pupils", "seductive smile", "naughty face", "ass focus", "sideboob", "underboob", "wet clothes",
  "clothes lift", "shirt lift", "skirt lift", "playboy bunny", "thong", "top-down bottom-up", "all fours", "bent over", "hetero",
  "breast press", "symmetrical docking", "asymmetrical docking", "covering breasts", "grabbing another's breast", "french kiss",
  "pov crotch", "bondage", "leash", "pet play", "torso grab", "grabbing another's ass", "leg grab", "legs up", "legs over head", "rolling eyes",
];

const stripWeight = (t: string) => { const m = /^-?\d+(?:\.\d+)?::(.*?)\s*::$/.exec(t.trim()); return (m ? m[1] : t).trim().toLowerCase(); };

/** Sexual tags found in content strings (exact tag match after weight stripping, comma-split). */
export function findSexualTags(strings: readonly string[]): { hard: string[]; soft: string[] } {
  const tags = new Set(strings.flatMap(s => s.split(",")).map(stripWeight).filter(Boolean));
  return { hard: SEXUAL_TAGS_HARD.filter(t => tags.has(t)), soft: SEXUAL_TAGS_SOFT.filter(t => tags.has(t)) };
}

/** Minimum rating the content implies: 2 for hard tags, 1 for soft, 0 otherwise. */
export function impliedRating(strings: readonly string[]): number {
  const f = findSexualTags(strings);
  return f.hard.length ? 2 : f.soft.length ? 1 : 0;
}

/**
 * Second gate, independent of the rating field: sexual content needs a non-empty cast with no minors.
 * Blocks a minor-setting cast even at rating 0 (e.g. an NSFW outfit preset dropped into an all-ages recipe).
 */
export function sexualContentGate(members: readonly CastMember[], characters: readonly Character[], contentStrings: readonly string[]): PolicyResult {
  const f = findSexualTags(contentStrings);
  const found = [...f.hard, ...f.soft];
  if (!found.length) return { ok: true, reason: "" };
  if (members.length === 0) return { ok: false, reason: `sexual content (${found.slice(0, 4).join(", ")}) needs a cast, but no cast member is set` };
  const byId = new Map(characters.map(c => [c.id ?? -1, c]));
  const bad = members.map(m => {
    const c = byId.get(m.character_id);
    if (!c) return "unknown character";
    return !allowsNsfwCast(c) ? `${c.tag} (${c.locked ? "canonical minor" : c.age_flag})` : null;
  }).filter((x): x is string => !!x);
  if (bad.length) return { ok: false, reason: `sexual content (${found.slice(0, 4).join(", ")}) cannot combine with a minor-setting character; blocked by ${bad.join(", ")}` };
  return { ok: true, reason: "" };
}
