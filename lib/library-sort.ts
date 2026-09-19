export const LIBRARY_SORTS = ["usage", "usage_asc", "newest", "oldest"] as const;
export type LibrarySort = typeof LIBRARY_SORTS[number];

type LibraryItem = { id?: number; created_at?: string; usage?: number; generation_count?: number };

function timestamp(value?: string): number {
  if (!value) return 0;
  // SQLite datetime('now') is UTC even though its string has no timezone suffix.
  const iso = value.replace(" ", "T");
  const time = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + "Z");
  return Number.isFinite(time) ? time : 0;
}

/** Sort a copy so searching/reordering a view never mutates the fetched data or existing cast. */
export function sortLibraryItems<T extends LibraryItem>(items: readonly T[], order: LibrarySort = "usage"): T[] {
  return [...items].sort((a, b) => {
    const usage = (b.usage ?? b.generation_count ?? 0) - (a.usage ?? a.generation_count ?? 0);
    if ((order === "usage" || order === "usage_asc") && usage !== 0) return order === "usage_asc" ? -usage : usage;
    const created = timestamp(b.created_at) - timestamp(a.created_at);
    return (order === "oldest" ? -created : created) || (b.id ?? 0) - (a.id ?? 0);
  });
}
