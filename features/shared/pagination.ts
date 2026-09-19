const PAGE_LIMIT = 200;

type PageRequest = { limit: typeof PAGE_LIMIT; offset: number };
type Page<T> = { items: T[]; total: number };

/** Read a bounded command list until the server reports its total or an empty page. */
export async function readAllPages<T>(fetchPage: (request: PageRequest) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (items.length < total) {
    const page = await fetchPage({ limit: PAGE_LIMIT, offset });
    total = page.total;
    items.push(...page.items);
    if (page.items.length === 0) break;
    offset += page.items.length;
  }

  return items.slice(0, Number.isFinite(total) ? total : undefined);
}
