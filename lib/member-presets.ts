/**
 * Per-character use of palette presets: outfit, pose, expression and actions
 * belong to each character prompt; the base prompt keeps scene-wide tags only).
 */
import type { Block, CastMember } from "./schema";

export type MergeMode = "replace" | "merge";
const uniq = (tags: string[]) => [...new Set(tags.map(t => t.trim()).filter(Boolean))];

/** Outfit presets fill `member.outfit`, expression/pose presets fill `member.expression`; other block types are not per-character. */
export function applyMemberPreset(member: CastMember, preset: Block, mode: MergeMode = "replace"): CastMember {
  if (!("tags" in preset)) return member;
  const key = preset.type === "outfit" ? "outfit" : preset.type === "expression_pose" ? "expression" : null;
  if (!key) return member;
  return { ...member, [key]: mode === "merge" ? uniq([...member[key], ...preset.tags]) : uniq(preset.tags) };
}

/** Tags that describe an act between characters; everything else in an act preset is scene-wide (pov, hetero, uncensored…). */
export const ACTION_TAGS = new Set([
  "sex", "vaginal", "anal", "missionary", "cowgirl position", "reverse cowgirl position", "girl on top", "doggystyle", "sex from behind",
  "prone bone", "spooning", "mating press", "full nelson", "suspended congress", "standing sex", "upright straddle", "reverse upright straddle",
  "thigh sex", "intercrural", "69", "fellatio", "deepthroat", "irrumatio", "oral", "paizuri", "handjob", "cunnilingus", "fingering",
  "tribadism", "scissoring", "mutual masturbation", "breast sucking", "breast press", "symmetrical docking", "asymmetrical docking",
  "grabbing another's breast", "grabbing another's ass", "torso grab", "leg grab", "hand on another's head", "frottage", "penises touching",
  "kiss", "french kiss", "cheek kiss", "hug", "hug from behind", "holding hands", "headpat", "lap pillow", "princess carry", "straddling",
]);

/**
 * Deal an act preset's tags to the cast: action tags become `source#x` on the acting member and `target#x` on the receiving one
 * (or `mutual#x` on every member when no direction is given); the remaining tags are returned for the base prompt.
 */
export function dealAct(tags: string[], members: CastMember[], source: number | null, target: number | null): { members: CastMember[]; base: string[] } {
  const actions = uniq(tags).filter(t => ACTION_TAGS.has(t.toLowerCase()));
  const base = uniq(tags).filter(t => !ACTION_TAGS.has(t.toLowerCase()));
  const directed = source !== null && target !== null && source !== target;
  const next = members.map((m, i) => {
    const prefix = directed ? (i === source ? "source#" : i === target ? "target#" : null) : "mutual#";
    if (!prefix) return m;
    return { ...m, interactions: uniq([...m.interactions, ...actions.map(a => `${prefix}${a}`)]) };
  });
  return { members: next, base };
}
