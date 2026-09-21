import { z } from "zod";
import type { CommandInput, TagSuggestion } from "../../contracts/studio";

const tagSchema = z.object({ name: z.string(), post_count: z.number(), category: z.number() });
const relatedSchema = z.object({ related_tags: z.array(z.object({ tag: tagSchema, frequency: z.number() })).default([]) });
const underscore = (value: string) => value.trim().replace(/\s+/g, "_");
const suggestion = (tag: z.infer<typeof tagSchema>): TagSuggestion => ({ ...tag, tag: tag.name, name: tag.name.replace(/_/g, " ") });

/** Public metadata lookup. NovelAI credentials never participate in these requests. */
export async function lookupCharacterTags(input: CommandInput<"characters.tagLookup">, fetchImpl: typeof fetch): Promise<TagSuggestion[]> {
  const url = new URL(input.mode === "related" ? "https://danbooru.donmai.us/related_tag.json" : "https://danbooru.donmai.us/tags.json");
  if (input.mode === "related") {
    url.search = new URLSearchParams({ query: underscore(input.tag), category: "copyright", limit: "8" }).toString();
  } else {
    url.search = new URLSearchParams({
      "search[name_matches]": underscore(input.query).replace(/\*+$/, "") + "*",
      "search[category]": input.kind === "character" ? "4" : "3",
      "search[order]": "count", limit: "10", only: "name,post_count,category",
    }).toString();
  }
  const response = await fetchImpl(url, { headers: { "User-Agent": "NAI-Recipe-Studio/0.1.0", Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("Tag lookup unavailable");
  const json: unknown = await response.json();
  if (input.mode === "search") return z.array(tagSchema).parse(json).map(suggestion);
  return relatedSchema.parse(json).related_tags
    .filter(item => item.tag.category === 3)
    .sort((a, b) => b.frequency - a.frequency || a.tag.post_count - b.tag.post_count)
    .map(item => ({ ...suggestion(item.tag), frequency: Math.round(item.frequency * 100) / 100 }));
}
