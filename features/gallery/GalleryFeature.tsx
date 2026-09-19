import * as React from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { StudioClient, GalleryItem as StoredGalleryItem, Character, BlockPreset } from "@/contracts/studio";
import { studioCall } from "@/desktop/renderer/studio-client";
import { readAllPages } from "@/features/shared/pagination";
import { GalleryGrid } from "./GalleryGrid";
import type { GalleryItem, GalleryQuery } from "./types";
import { useGalleryTranslation } from "./locale";

function toItem(item: StoredGalleryItem): GalleryItem {
  return { ...item, recipe_snapshot: JSON.stringify(item.recipe), characters: "characters" in item ? item.characters ?? [] : [], anlas_cost: item.estimatedAnlas } as GalleryItem;
}

export function GalleryFeature({ client, blurSensitive = false, onOpenRecipe }: { client?: StudioClient; blurSensitive?: boolean; onOpenRecipe: (id: number) => void }) {
  const { t } = useGalleryTranslation();
  const [items, setItems] = React.useState<GalleryItem[] | null>(null);
  const [recipes, setRecipes] = React.useState<{ id: number; name: string }[]>([]);
  const [characters, setCharacters] = React.useState<Character[]>([]);
  const [presets, setPresets] = React.useState<BlockPreset[]>([]);
  const [query, setQuery] = React.useState<GalleryQuery>(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const ids = (key: string) => (params.get(key) ?? "").split(",").map(Number).filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 100);
    const rating = Number(params.get("rating_max") ?? 0);
    return { rating_max: rating >= 0 && rating <= 2 ? rating : 0, limit: 60, sort: params.get("sort") === "oldest" ? "oldest" : "newest", recipe_id: ids("recipe_id")[0], character_ids: ids(params.has("character_ids") ? "character_ids" : "character_id"), preset_ids: ids(params.has("preset_ids") ? "preset_ids" : "preset_id") };
  });
  const [total, setTotal] = React.useState(0);
  const [more, setMore] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const queryRef = React.useRef(query);
  const [tick, setTick] = React.useState(0);
  const reload = (q: GalleryQuery = query) => { queryRef.current = q; setReloading(true); setQuery(q); setTick(value => value + 1); };
  const listPage = React.useCallback(async (q: GalleryQuery) => {
    if (!client) return { items: [] as GalleryItem[], total: 0 };
    const page = await studioCall(client, "gallery.list", { limit: q.limit, offset: q.offset, ratingMax: q.rating_max, recipeId: q.recipe_id, characterIds: q.character_ids, presetIds: q.preset_ids, sort: q.sort });
    return { items: page.items.map(toItem), total: page.total };
  }, [client]);
  React.useEffect(() => {
    let alive = true;
    void listPage(query).then(page => { if (alive) { setItems(page.items); setTotal(page.total); } })
      .catch(() => { if (alive) { setItems([]); setTotal(0); toast.add({ title: t("loadFailed"), type: "error" }); } })
      .finally(() => { if (alive) setReloading(false); });
    return () => { alive = false; };
  }, [query, tick, listPage, t]);
  React.useEffect(() => {
    if (!client) return;
    let alive = true;
    void Promise.all([
      readAllPages(({ limit, offset }) => studioCall(client, "recipes.list", { limit, offset })),
      readAllPages(({ limit, offset }) => studioCall(client, "characters.list", { limit, offset })),
      readAllPages(({ limit, offset }) => studioCall(client, "presets.list", { limit, offset })),
    ])
      .then(([recipes, characters, presets]) => { if (alive) { setRecipes(recipes); setCharacters(characters); setPresets(presets); } })
      .catch(() => { if (alive) toast.add({ title: t("loadFailed"), type: "error" }); });
    return () => { alive = false; };
  }, [client, t]);
  React.useEffect(() => client?.subscribe(event => { if (event.type === "job.changed" || event.type === "workspace.changed") setTick(value => value + 1); }), [client]);
  const loadingRef = React.useRef(false);
  const loadMore = React.useCallback(async () => {
    if (!items || reloading || loadingRef.current || items.length >= total) return;
    loadingRef.current = true; setMore(true);
    try {
      const page = await listPage({ ...query, offset: items.length });
      if (queryRef.current !== query) return;
      setItems(previous => { const seen = new Set(previous?.map(item => item.id)); return [...previous ?? [], ...page.items.filter(item => !seen.has(item.id))]; });
      setTotal(page.total);
    } catch { toast.add({ title: t("moreFailed"), type: "error" }); }
    finally { setMore(false); loadingRef.current = false; }
  }, [items, reloading, total, listPage, query, t]);
  const sentinel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = sentinel.current;
    if (!element || !items || reloading || items.length >= total || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore(); }, { root: element.closest("main"), rootMargin: "600px 0px" });
    observer.observe(element); return () => observer.disconnect();
  }, [items, reloading, total, loadMore]);
  const onDelete = async (ids: number[]) => {
    if (!client) return;
    const deleted: number[] = [];
    for (const id of ids) { try { await studioCall(client, "gallery.delete", { id }); deleted.push(id); } catch { toast.add({ title: t("deleteFailed", { id }), type: "error" }); } }
    if (deleted.length) toast.add({ title: t("deleted", { count: deleted.length }), type: "success" });
    setItems(previous => (previous ?? []).filter(item => !deleted.includes(item.id)));
    setTotal(value => Math.max(0, value - deleted.length));
  };
  const onRate = async (item: GalleryItem, patch: { score?: number | null; liked?: boolean; note?: string }) => {
    if (!client) return;
    const updated = toItem(await studioCall(client, "gallery.rate", { id: item.id, ...patch }));
    setItems(previous => previous?.map(value => value.id === updated.id ? updated : value) ?? null);
  };
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
      <div className="min-w-0"><h1 className="text-base font-semibold tracking-tight">{t("gallery")}</h1><p className="truncate text-xs text-muted-foreground">{items ? t("count", { count: total }) : ""}</p></div>
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => reload()}><RefreshCw />{t("refresh")}</Button></div>
    </div>
    <div className="p-4 md:p-6">
      {items === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("loading")}</div> : <>
        <GalleryGrid items={items} recipes={recipes} characters={characters} presets={presets} query={query} onQuery={reload} onDelete={onDelete} loading={reloading} blur={blurSensitive} onOpenRecipe={onOpenRecipe} onRate={onRate} onExport={async (item, includeMetadata) => { if (client) await studioCall(client, "gallery.export", { id: item.id, includeMetadata }); }} />
        {!reloading && items.length < total ? <div ref={sentinel} className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">{more ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}{more ? t("loading") : t("remaining", { count: total - items.length })}</div> : !reloading && items.length > 0 ? <p className="py-6 text-center text-xs text-muted-foreground">{t("complete", { count: total })}</p> : null}
      </>}
    </div>
  </>;
}
