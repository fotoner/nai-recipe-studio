"use client";

import * as React from "react";
import { presetName } from "@/i18n/preset-text";
import { Thumbnail } from "./Thumbnail";
import { CheckSquare, Eye, EyeOff, Loader2, Maximize2, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TFunction } from "i18next";
import { useGalleryTranslation } from "./locale";
import { useTranslation } from "react-i18next";
import type { GalleryItem, GalleryQuery } from "./types";
import { BLOCK_LABEL_KEY } from "@/features/shared/types";
import { Block, type BlockPreset, type Character } from "@/lib/schema";
import { blockKey } from "@/core/palette";
import { Lightbox } from "./Lightbox";
import { GalleryFilters } from "./GalleryFilters";
import type { GenerationDraftFromImage } from "@/core/recipe/from-generation";

const CORE_PALETTES = ["style", "scene", "composition", "outfit"] as const;
type PaletteIndex = { byId: Map<number, BlockPreset>; byKey: Map<string, BlockPreset> };

/** Read generation-time blocks, never the current recipe or prompt tag guesses. */
function paletteSummary(snapshot: string, index: PaletteIndex, t: TFunction<"galleryView">) {
  let blocks: Block[];
  try {
    const saved: unknown = JSON.parse(snapshot);
    if (!saved || typeof saved !== "object" || !("blocks" in saved) || !Array.isArray(saved.blocks)) return [];
    blocks = saved.blocks.flatMap(raw => { const result = Block.safeParse(raw); return result.success ? [result.data] : []; });
  } catch { return []; }
  return CORE_PALETTES.flatMap(type => blocks.filter(b => b.type === type).flatMap(b => {
    const key = blockKey(b);
    const linked = b.preset_id ? index.byId.get(b.preset_id) : undefined;
    const preset = b.preset_id ? linked : index.byKey.get(key);
    const modified = linked && blockKey(linked.block) !== key;
    let name = preset ? `${presetName(preset)}${modified ? t("modified") : ""}` : b.preset_id ? t("preset", { id: b.preset_id }) : "";
    if (!name && "artists" in b && b.artists.length) name = t("artists", { count: b.artists.length });
    if (!name && "tags" in b) name = b.tags.slice(0, 2).join(", ") || b.text;
    return name ? [{ type, name }] : [];
  }));
}

function Item({ item, blur, palettes, onOpen, onDelete, selecting, selected, onSelect }: {
  item: GalleryItem; blur: boolean; palettes: PaletteIndex; onOpen: () => void;
  onDelete?: (item: GalleryItem) => void; selecting?: boolean; selected?: boolean; onSelect?: (on: boolean) => void;
}) {
  const { t } = useGalleryTranslation();
  const { t: ui } = useTranslation();
  const [reveal, setReveal] = React.useState(false);
  const hidden = blur && item.rating >= 1 && !reveal;
  const summary = paletteSummary(item.recipe_snapshot, palettes, t);
  const src = item.url;

  return (
    <div data-testid="gallery-card" className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border p-2", selected ? "border-primary" : "border-border")}>
      <div className="group/thumb relative shrink-0 overflow-hidden rounded-lg bg-muted">
        <button type="button" onClick={selecting ? () => onSelect?.(!selected) : onOpen} className={cn("relative block aspect-3/4 w-full", selecting ? "cursor-pointer" : "cursor-zoom-in")} title={selecting ? t("select") : t("enlarge")}>
          <Thumbnail src={src} alt={`#${item.id}`} fill
            sizes="(min-width: 1536px) calc((100vw - 304px) / 5), (min-width: 1280px) calc((100vw - 292px) / 4), (min-width: 1024px) calc((100vw - 280px) / 3), (min-width: 768px) calc((100vw - 268px) / 2), calc((100vw - 44px) / 2)"
            className={cn("object-cover transition", hidden && "blur-xl")} />
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-md bg-background/80 p-1 opacity-0 transition-opacity group-hover/thumb:opacity-100">
            <Maximize2 className="size-3.5" />
          </span>
          {selecting ? (
            <span className="absolute top-1.5 left-1.5 rounded-md bg-background/80 p-0.5">
              {selected ? <CheckSquare className="size-4 text-primary" /> : <Square className="size-4" />}
            </span>
          ) : null}
        </button>
        {onDelete && !selecting ? (
          <Button size="icon-xs" variant="secondary" className="absolute bottom-1.5 right-1.5 opacity-0 transition-opacity group-hover/thumb:opacity-100" title={t("delete")}
            onClick={() => { if (confirm(t("deleteOne", { id: item.id }))) onDelete(item); }}><Trash2 /></Button>
        ) : null}
        {item.rating >= 1 ? (
          <Button size="icon-xs" variant="secondary" className="absolute top-1.5 right-1.5" aria-label={t(hidden ? "show" : "hide")} onClick={() => setReveal(r => !r)}>
            {hidden ? <EyeOff /> : <Eye />}
          </Button>
        ) : null}
      </div>
      <div className="flex h-4 min-w-0 shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
        <span className="truncate" title={`#${item.id} · seed ${item.seed} · ${item.width}×${item.height}`}>#{item.id} · seed {item.seed} · {item.width}×{item.height}</span>
        {item.rating >= 1 ? <Badge variant="destructive" className="h-4 text-[10px]">R{item.rating}</Badge> : null}
      </div>
      <p className="h-4 shrink-0 truncate text-[11px] text-muted-foreground" title={item.recipe_name}>{item.recipe_name}</p>
      <div role="group" aria-label={t("usedPalette")} className="flex h-[5.25rem] shrink-0 flex-col gap-1 border-t border-border pt-1.5">
        {summary.length ? CORE_PALETTES.map(type => {
          const name = summary.filter(p => p.type === type).map(p => p.name).join(" · ");
          return <div key={type} className="flex h-4 min-w-0 shrink-0 items-baseline gap-1.5 text-[11px]">
            <span className="shrink-0 text-muted-foreground">{ui(BLOCK_LABEL_KEY[type])}</span>
            <span className={cn("truncate", type === "style" && "font-medium")} title={name}>{name || "—"}</span>
          </div>
        }) : <span className="text-[11px] text-muted-foreground">{t("noPalette")}</span>}
      </div>
    </div>
  );
}

export function GalleryGrid({ items, recipes, characters = [], presets = [], query, onQuery, onDelete, onExport, onRate, onOpenRecipe, onContinueFromGeneration, blur = false, openId, loading = false }: {
  items: GalleryItem[];
  recipes: { id: number; name: string }[];
  characters?: Character[];
  presets?: BlockPreset[];
  blur?: boolean;
  onExport: (item: GalleryItem, includeMetadata: boolean) => Promise<void>;
  onRate: (item: GalleryItem, patch: { score?: number | null; liked?: boolean; note?: string }) => Promise<void>;
  onOpenRecipe: (id: number) => void;
  onContinueFromGeneration?: (draft: GenerationDraftFromImage) => void;
  query: GalleryQuery;
  onQuery: (q: GalleryQuery) => void;
  /** delete one or many generations; the parent refreshes the list */
  onDelete?: (ids: number[]) => Promise<void>;
  /** generation id to open in the lightbox on load (from ?g=) */
  openId?: number;
  loading?: boolean;
}) {
  const { t } = useGalleryTranslation();
  const palettes = React.useMemo<PaletteIndex>(() => ({
    byId: new Map(presets.filter(p => p.id).map(p => [p.id!, p])),
    byKey: new Map(presets.map(p => [blockKey(p.block), p])),
  }), [presets]);
  const [selecting, setSelecting] = React.useState(false);
  const [sel, setSel] = React.useState<Set<number>>(new Set());
  const [deleting, setDeleting] = React.useState(false);
  const presentSel = [...sel].filter(id => items.some(it => it.id === id));
  const removeOne = async (it: GalleryItem) => { if (!onDelete) return; setOpen(null); await onDelete([it.id]); };
  const removeSelected = async () => {
    if (!onDelete || !presentSel.length || !confirm(t("deleteMany", { count: presentSel.length }))) return;
    setDeleting(true);
    try { await onDelete(presentSel); setSel(new Set()); setSelecting(false); } finally { setDeleting(false); }
  };
  // deep link: /gallery?g=<generation id>. The page mounts this grid only after items are loaded, so mount-time lookup is enough.
  const [open, setOpen] = React.useState<number | null>(() => {
    if (!openId) return null;
    const i = items.findIndex(it => it.id === openId);
    return i >= 0 ? i : null;
  });
  return (
    <div className="flex flex-col gap-3">
      <Lightbox items={items} index={open} blur={blur} onClose={() => setOpen(null)} onIndex={setOpen} onDelete={onDelete ? removeOne : undefined} onExport={onExport} onRate={onRate} onOpenRecipe={onOpenRecipe} onContinueFromGeneration={onContinueFromGeneration} />
      <div className="flex items-start gap-2 border-b border-border pb-3">
        <GalleryFilters characters={characters} presets={presets} recipes={recipes} query={query}
          onQuery={q => { setOpen(null); setSelecting(false); setSel(new Set()); onQuery(q); }} />
        {onDelete ? (
          <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
            <Button size="sm" variant={selecting ? "secondary" : "ghost"} onClick={() => { setSelecting(v => !v); setSel(new Set()); }}>
              {selecting ? <CheckSquare /> : <Square />} {t("select")}{selecting && presentSel.length ? ` ${presentSel.length}` : ""}
            </Button>
            {selecting ? <Button size="sm" variant="ghost" onClick={() => setSel(new Set(items.map(it => it.id)))}>{t("all")}</Button> : null}
            {selecting ? (
              <Button size="sm" variant="destructive" disabled={!presentSel.length || deleting} onClick={removeSelected}><Trash2 /> {t("deleteSelected")}</Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {loading ? (
        <p role="status" className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("loading")}</p>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {items.map((it, i) => (
            <Item key={it.id} item={it} blur={blur} palettes={palettes} onOpen={() => setOpen(i)} onDelete={onDelete ? removeOne : undefined}
              selecting={selecting} selected={sel.has(it.id)} onSelect={on => setSel(s => { const n = new Set(s); if (on) n.add(it.id); else n.delete(it.id); return n; })} />
          ))}
        </div>
      )}
    </div>
  );
}

export default GalleryGrid;
