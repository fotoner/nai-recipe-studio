import * as React from "react";
import { Download } from "lucide-react";
import type { StudioClient, GalleryItem as StoredGalleryItem } from "@/contracts/studio";
import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/features/gallery/Thumbnail";
import { Lightbox } from "@/features/gallery/Lightbox";
import type { GalleryItem } from "@/features/gallery/types";
import { toast } from "@/components/ui/toast";
import { errorMessage, studioCall } from "@/desktop/renderer/studio-client";
import { useGenerationTranslation } from "./locale";
import type { GenerationDraftFromImage } from "@/core/recipe/from-generation";

function asViewItem(item: StoredGalleryItem): GalleryItem {
  return {
    ...item,
    recipe_snapshot: JSON.stringify(item.recipe),
    characters: item.characters ?? [],
    anlas_cost: item.estimatedAnlas,
  };
}

export function GenerationResults({ items, client, large = false, blurSensitive, onContinueFromGeneration }: {
  items: StoredGalleryItem[];
  client?: StudioClient;
  large?: boolean;
  blurSensitive?: boolean;
  onContinueFromGeneration?: (draft: GenerationDraftFromImage) => void;
}) {
  const { t } = useGenerationTranslation();
  const [localItems, setLocalItems] = React.useState(items);
  const [settingBlur, setSettingBlur] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [previewId, setPreviewId] = React.useState<number | null>(null);
  const stripRef = React.useRef<HTMLDivElement>(null);
  const shownItems = localItems;
  const selectedIndex = Math.max(0, shownItems.findIndex(item => item.id === selectedId));
  const selected = shownItems[selectedIndex];
  const previewIndex = shownItems.findIndex(item => item.id === previewId);
  const blur = blurSensitive ?? settingBlur;
  const visible = large ? selected ? [selected] : [] : shownItems;

  React.useEffect(() => setLocalItems(items), [items]);
  React.useEffect(() => {
    if (!shownItems.length) { setSelectedId(null); return; }
    if (selectedId === null || !shownItems.some(item => item.id === selectedId)) setSelectedId(shownItems[0]!.id);
  }, [selectedId, shownItems]);
  React.useEffect(() => {
    if (!client || blurSensitive !== undefined) return;
    let active = true;
    void studioCall(client, "settings.get", {}).then(settings => { if (active) setSettingBlur(settings.blurSensitive); }).catch(() => undefined);
    const unsubscribe = client.subscribe(event => {
      if (event.type === "settings.changed") setSettingBlur(event.settings.blurSensitive);
    });
    return () => { active = false; unsubscribe(); };
  }, [blurSensitive, client]);

  const select = (index: number) => {
    const item = shownItems[index];
    if (!item) return;
    setSelectedId(item.id);
    const strip = stripRef.current;
    const thumb = strip?.children[index] as HTMLElement | undefined;
    if (strip && thumb) {
      if (thumb.offsetLeft < strip.scrollLeft) strip.scrollLeft = thumb.offsetLeft;
      else if (thumb.offsetLeft + thumb.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = thumb.offsetLeft + thumb.offsetWidth - strip.clientWidth;
    }
  };
  const exportItem = async (item: GalleryItem, includeMetadata = false) => {
    if (!client) return;
    try {
      await studioCall(client, "gallery.export", { id: item.id, includeMetadata });
    } catch (cause) {
      toast.add({ title: errorMessage(cause, t("exportFailed")), type: "error" });
    }
  };
  const rateItem = async (item: GalleryItem, patch: { score?: number | null; liked?: boolean; note?: string }) => {
    if (!client) return;
    const updated = await studioCall(client, "gallery.rate", { id: item.id, ...patch });
    setLocalItems(current => current.map(value => value.id === updated.id ? updated : value));
  };
  const viewerItems = React.useMemo(() => shownItems.map(asViewItem), [shownItems]);

  if (!shownItems.length) return null;
  return <>
    <div className={large ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"}>
      {visible.map(item => (
        <div key={item.id} className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <button type="button" aria-label={t("openGeneratedImage", { id: item.id })} onClick={() => setPreviewId(item.id)} className="block w-full overflow-hidden bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
            <Thumbnail src={item.url} alt={item.recipe_name} className={`${large ? "h-[min(65svh,48rem)] w-full object-contain" : "aspect-3/4 w-full object-cover"}${blur && item.rating >= 1 ? " blur-md" : ""}`} />
          </button>
          <div className="flex flex-col gap-1 p-2 text-xs">
            {!large ? <span className="truncate" title={item.recipe_name}>{item.recipe_name}</span> : null}
            <div className="flex items-center justify-between gap-1 text-muted-foreground">
              <span className="truncate font-mono text-[10px]">{t("seed", { seed: item.seed })}</span>
              {large && shownItems.length > 1 ? <span className="ml-auto tabular-nums">{t("resultPosition", { index: selectedIndex + 1, count: shownItems.length })}</span> : null}
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t("exportGeneratedImage", { id: item.id })} disabled={!client} onClick={() => void exportItem(asViewItem(item))}><Download /></Button>
            </div>
          </div>
        </div>
      ))}
      {large && shownItems.length > 1 ? (
        <div ref={stripRef} role="group" aria-label={t("resultGroup")} className="relative flex gap-2 overflow-x-auto p-1"
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const index = Math.max(0, Math.min(shownItems.length - 1, selectedIndex + (event.key === "ArrowRight" ? 1 : -1)));
            select(index);
            (stripRef.current?.children[index] as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
          }}>
          {shownItems.map((item, index) => (
            <button key={item.id} type="button" aria-label={t("selectResult", { index: index + 1, seed: item.seed })} aria-pressed={index === selectedIndex} onClick={() => select(index)}
              className={`relative w-16 shrink-0 overflow-hidden rounded-md bg-muted ring-2 ring-transparent transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${index === selectedIndex ? "ring-primary" : "opacity-60 hover:opacity-100"}`}>
              <Thumbnail src={item.url} alt="" className={`h-22 w-full object-cover${blur && item.rating >= 1 ? " blur-md" : ""}`} />
              <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white">{index + 1}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
    {previewIndex >= 0 ? <Lightbox items={viewerItems} index={previewIndex} blur={blur}
      onClose={() => setPreviewId(null)} onIndex={index => { select(index); setPreviewId(shownItems[index]?.id ?? null); }}
      onExport={exportItem} onRate={rateItem} onOpenRecipe={id => { window.location.hash = `#/recipe/${id}`; }} onContinueFromGeneration={onContinueFromGeneration} /> : null}
  </>;
}

export default GenerationResults;
