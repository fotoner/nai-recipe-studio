import { charactersForRecipe } from "./characters";
import { composeParts } from "../../lib/composer";
import { canCombine, sexualContentGate } from "../../lib/policy";
import { sanitizePrompt, splitTags } from "../../lib/prompt-utils";
import type { Character, Recipe } from "../../lib/schema";
import type { Finding } from "../../contracts/studio";
import { cloneJson } from "./model";

/** Rules that inspect a user's private style profile are intentionally absent here. */
const unsupportedSyntax = /#if\b|<lora:/i;
const countSyntax = /^(?:solo|\d+\s*(?:girls?|boys?|others?))$/i;

function finding(code: string, messageKey: string, severity: Finding["severity"], block?: string, fixable = false, params?: Finding["params"]): Finding {
  return { code, messageKey, severity, block, fixable, ...(params ? { params } : {}) };
}

function stringsOf(recipe: Recipe): string[] {
  const out: string[] = [];
  for (const block of recipe.blocks) {
    if ("artists" in block) out.push(...block.artists.map(a => a.name), block.year, ...block.quality, ...block.minus);
    if ("members" in block) for (const member of block.members) out.push(...member.traits, ...member.outfit, ...member.expression, ...member.uc, ...member.interactions);
    if ("tags" in block) out.push(...block.tags, block.text);
    if ("entries" in block) out.push(...block.entries.map(entry => entry.text));
    if ("extra" in block) out.push(...block.extra);
    if ("explicit_tags" in block) out.push(...block.explicit_tags);
  }
  return out.filter(Boolean);
}

function contentStrings(recipe: Recipe): string[] {
  const out: string[] = [];
  for (const block of recipe.blocks) {
    if ("members" in block) for (const member of block.members) out.push(...member.traits, ...member.outfit, ...member.expression, ...member.interactions);
    if ("tags" in block) out.push(...block.tags, block.text);
    if ("entries" in block) out.push(...block.entries.map(entry => entry.text));
    if ("explicit_tags" in block) out.push(...block.explicit_tags);
  }
  return out.filter(Boolean);
}

function countFinding(recipe: Recipe, characters: Character[]): Finding[] {
  const parts = composeParts(recipe, characters);
  if (parts.members.length < 2) return [];
  const expected = new Set(splitTags(parts.count));
  const mismatched: string[] = [];
  for (const value of contentStrings(recipe).flatMap(splitTags)) if (countSyntax.test(value) && !expected.has(value)) mismatched.push(value);
  return mismatched.length
    ? [finding("COUNT_MISMATCH", "validation.countMismatch", "error", "cast", false, { expected: parts.count, actual: mismatched.join(", ") })]
    : [];
}

/** Validate neutral structural and safety rules. Private style recommendations are not part of this graph. */
export function validateRecipe(recipe: Recipe, characters: Character[], status?: { battery_percent: number }): Finding[] {
  characters = charactersForRecipe(recipe, characters);
  const findings: Finding[] = [];
  const ids = new Set(characters.map(character => character.id));
  if (recipe.blocks.some(block => block.type === "cast" && block.members.some(member => !ids.has(member.character_id)))) findings.push(finding("MISSING_CHARACTER", "validation.missingCharacter", "error", "cast"));
  for (const value of stringsOf(recipe)) {
    if (sanitizePrompt(value) !== value) findings.push(finding("PROMPT_SYNTAX", "validation.promptSyntax", "error", undefined, true));
    if (unsupportedSyntax.test(value) || value.includes("|")) findings.push(finding("UNSUPPORTED_SYNTAX", "validation.unsupportedSyntax", "error", undefined, false));
  }
  const parts = composeParts(recipe, characters);
  const policy = canCombine(parts.rating, parts.members, characters, stringsOf(recipe));
  if (!policy.ok) findings.push(finding("POLICY_BLOCKED", "validation.policyBlocked", "error", "negative", false));
  const sexual = sexualContentGate(parts.members, characters, contentStrings(recipe));
  if (!sexual.ok) findings.push(finding("CONTENT_BLOCKED", "validation.contentBlocked", "error", "cast", false));
  findings.push(...countFinding(recipe, characters));
  if (status && status.battery_percent < 20) findings.push(finding("ACCOUNT_LOW", "validation.accountLow", "info"));
  return [...new Map(findings.map(item => [`${item.code}:${item.block ?? ""}`, item])).values()];
}

function sanitizePromptFields(recipe: Recipe): Recipe {
  const list = (values: string[]) => values.map(sanitizePrompt);
  return {
    ...recipe,
    blocks: recipe.blocks.map(block => {
      switch (block.type) {
        case "style":
          return { ...block, artists: block.artists.map(artist => ({ ...artist, name: sanitizePrompt(artist.name) })), year: sanitizePrompt(block.year), quality: list(block.quality), minus: list(block.minus) };
        case "cast":
          return { ...block, members: block.members.map(member => ({ ...member, traits: list(member.traits), outfit: list(member.outfit), expression: list(member.expression), uc: list(member.uc), interactions: list(member.interactions) })) };
        case "scene":
        case "composition":
        case "outfit":
        case "expression_pose":
        case "lighting":
        case "motif":
          return { ...block, tags: list(block.tags), text: sanitizePrompt(block.text) };
        case "text":
          return { ...block, entries: block.entries.map(entry => ({ ...entry, text: sanitizePrompt(entry.text) })) };
        case "negative":
          return { ...block, extra: list(block.extra) };
        case "nsfw":
          return { ...block, explicit_tags: list(block.explicit_tags) };
        case "settings":
          return block;
      }
    }),
  };
}

/** Apply only mechanical, user-selected fixes. Policy findings remain explicit blockers. */
export function validateAndFix(recipe: Recipe, characters: Character[], fixes: string[] = [], status?: { battery_percent: number }) {
  const next = cloneJson(recipe);
  const applied: string[] = [];
  if (fixes.includes("PROMPT_SYNTAX") || fixes.includes("L01")) {
    Object.assign(next, sanitizePromptFields(next));
    applied.push("PROMPT_SYNTAX");
  }
  return { recipe: next, applied, findings: validateRecipe(next, characters, status) };
}
