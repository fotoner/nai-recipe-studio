import type { Character, Recipe, CastMember } from "../../lib/schema";

/** Frozen prompt data remains reproducible; protection flags can only get stricter. */
export function resolveMemberCharacter(member: CastMember, live?: Character): Character | undefined {
  const snapshot = member.character_snapshot;
  if (!snapshot) return live;
  return { ...snapshot, id: member.character_id, locked: snapshot.locked || !!live?.locked, age_flag: snapshot.age_flag === "minor" || live?.age_flag === "minor" ? "minor" : snapshot.age_flag };
}
export function charactersForRecipe(recipe: Recipe, characters: Character[]): Character[] {
  const byId = new Map(characters.map(character => [character.id, character]));
  for (const block of recipe.blocks) if (block.type === "cast") for (const member of block.members) {
    const resolved = resolveMemberCharacter(member, byId.get(member.character_id));
    if (resolved) byId.set(member.character_id, resolved);
  }
  return [...byId.values()];
}
export function snapshotRecipeCharacters(recipe: Recipe, characters: Character[]): Recipe {
  const byId = new Map(characters.map(character => [character.id, character]));
  return { ...recipe, blocks: recipe.blocks.map(block => block.type !== "cast" ? block : { ...block, members: block.members.map(member => {
    const character = resolveMemberCharacter(member, byId.get(member.character_id));
    return character ? { ...member, character_snapshot: JSON.parse(JSON.stringify(character)) as Character } : member;
  }) }) };
}
