import { useCastTranslation } from "./locale";
import { i18n } from "@/i18n";
import { LIBRARY_SORTS, sortLibraryItems, type LibrarySort } from "@/lib/library-sort";
import { SortControl } from "@/features/palette/PaletteComponents";
export { sortLibraryItems } from "@/lib/library-sort";
import * as React from "react";
import { ImageOff, LayoutTemplate, Loader2, Plus, Search } from "lucide-react";
import type { BlockType } from "@/lib/schema";
import type { GenerationExample, StudioClient, StoredPreset } from "@/contracts/studio";
import { presetName, presetNotes } from "@/i18n/preset-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { newBlock, blockSummary, type Block } from "@/features/shared/types";
import { readAllPages } from "@/features/shared/pagination";
import { getStudioClient, studioCall } from "@/desktop/renderer/studio-client";

export type GalleryExample = Pick<GenerationExample, "id" | "seed" | "rating" | "url" | "created_at">;
export type BlockPresetCard = StoredPreset & { usage: number; examples: GalleryExample[] };

export function useLibrarySort(library: "presets" | "characters") {
  const key = `studio.${library}.sort`;
  const [sort, setSort] = React.useState<LibrarySort>("usage");
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(key) as LibrarySort | null;
      if (stored && LIBRARY_SORTS.includes(stored)) setSort(stored);
    } catch {
      // A private window may not provide storage; the default remains usable.
    }
  }, [key]);
  const update = React.useCallback((next: LibrarySort) => {
    setSort(next);
    try { localStorage.setItem(key, next); } catch { /* optional preference */ }
  }, [key]);
  return [sort, update] as const;
}

export function LibrarySortControl({ value, onChange, label }: { value: LibrarySort; onChange: (value: LibrarySort) => void; label?: string }) {
  return <SortControl value={value} onChange={onChange} label={label ?? i18n.t("paletteView:sortLabel")} />;
}

function useNsfwBlur(): boolean {
  const client = getStudioClient();
  const [blur, setBlur] = React.useState(true);
  React.useEffect(() => {
    if (!client) return;
    let active = true;
    void studioCall(client, "settings.get", {}).then(settings => { if (active) setBlur(settings.blurSensitive); }).catch(() => undefined);
    const unsubscribe = client.subscribe(event => { if (event.type === "settings.changed") setBlur(event.settings.blurSensitive); });
    return () => { active = false; unsubscribe(); };
  }, [client]);
  return blur;
}

/** One example thumbnail in the same fixed 3:4 box used by the original picker. */
export function ExampleStrip({ examples, className, onClick, title }: { examples: GalleryExample[]; className?: string; onClick?: () => void; title?: string }) {
  const { t } = useCastTranslation();
  const blur = useNsfwBlur();
  const example = examples[0];
  const box = cn("relative block shrink-0 aspect-3/4 w-full overflow-hidden bg-muted", onClick && "cursor-pointer", className);
  const inner = example?.url ? <img src={example.url} alt="" loading="lazy" className={cn("absolute inset-0 h-full w-full object-cover", blur && example.rating >= 1 && "blur-md")} /> : <span className="absolute inset-0 flex items-center justify-center text-muted-foreground"><ImageOff className="size-5" /></span>;
  const label = title ?? (example ? `#${example.id} seed ${example.seed}` : t("noExample"));
  return onClick ? <button type="button" onClick={onClick} className={box} title={label}>{inner}</button> : <div className={box} title={label}>{inner}</div>;
}

type MergeMode = "replace" | "merge";
const isTagBlock = (block: Block | undefined): block is Extract<Block, { tags: string[] }> => !!block && "tags" in block;

/** Pick a palette block while keeping the command client at the renderer boundary. */
export function BlockPicker({ client, type, onOpenChange, onPick, replacing, existing, hideAdult = false, title }: {
  client?: StudioClient;
  type: BlockType | null;
  onOpenChange: (open: boolean) => void;
  onPick: (block: Block) => void;
  replacing?: boolean;
  existing?: Block;
  hideAdult?: boolean;
  title?: string;
}) {
  const { t } = useCastTranslation();
  const canMerge = replacing && isTagBlock(existing) && (existing.tags.length > 0 || existing.text.trim().length > 0);
  const [mode, setMode] = React.useState<MergeMode>("replace");
  const [loaded, setLoaded] = React.useState<{ type: BlockType; list: BlockPresetCard[] } | null>(null);
  const [q, setQ] = React.useState("");
  const [sort, setSort] = useLibrarySort("presets");
  const presets = loaded?.type === type ? loaded.list : null;

  React.useEffect(() => {
    if (!type) return;
    let alive = true;
    setLoaded(null);
    if (!client) {
      setLoaded({ type, list: [] });
      return () => { alive = false; };
    }
    void readAllPages(({ limit, offset }) => studioCall(client, "presets.list", { limit, offset, type, includeHidden: false })).then((presets) => {
      if (!alive) return;
      setLoaded({ type, list: presets.map((preset) => ({
        ...preset,
        usage: preset.usage ?? 0,
        examples: (preset.examples ?? []).slice(0, 3),
      })) });
    }).catch(() => {
      if (alive) setLoaded({ type, list: [] });
    });
    return () => { alive = false; };
  }, [client, type]);

  React.useEffect(() => { if (!canMerge) setMode("replace"); }, [canMerge]);
  React.useEffect(() => { setQ(""); }, [type]);

  const search = q.trim().toLowerCase();
  const list = sortLibraryItems((presets ?? [])
    .filter(preset => !(hideAdult && preset.tags.includes("nsfw")))
    .filter(preset => !search || presetName(preset).toLowerCase().includes(search) || preset.tags.some(tag => tag.toLowerCase().includes(search)) || blockSummary(preset.block).toLowerCase().includes(search)), sort);

  const pick = (preset: BlockPresetCard) => {
    const chosen: Block = preset.id ? { ...preset.block, preset_id: preset.id } : { ...preset.block };
    if (canMerge && mode === "merge" && isTagBlock(existing) && isTagBlock(chosen)) {
      const tags = [...new Set([...existing.tags, ...chosen.tags].map(tag => tag.trim()).filter(Boolean))];
      onPick({ ...existing, tags, text: existing.text.trim() ? existing.text : chosen.text, preset_id: undefined } as Block);
    } else onPick(chosen);
    onOpenChange(false);
  };

  return <Dialog open={!!type} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[92svh] flex-col gap-3 overflow-hidden sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>{title ?? t("chooseTitle", { block: type ? t(`block.${type}`) : "", action: t(replacing ? "replace" : "add") })}</DialogTitle>
        <DialogDescription>
          {type ? <span className="text-foreground/80">{t("chooseDescription", { block: t(`block.${type}`) })} </span> : null}
          {t(replacing ? "replaceDescription" : "addDescription")} {t("exampleDescription")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <LibrarySortControl value={sort} onChange={setSort} />
        <div className="relative"><Search className="absolute top-2 left-2 size-4 text-muted-foreground" /><Input className="h-8 w-56 pl-7" placeholder={t("presetSearch")} value={q} onChange={event => setQ(event.target.value)} autoFocus /></div>
        <span className="text-xs text-muted-foreground">{presets ? t("presetCount", { count: list.length }) : ""}</span>
        {canMerge ? <span className="flex rounded-lg border border-border p-0.5" title={t("mergeHelp")}><Button size="xs" variant={mode === "replace" ? "secondary" : "ghost"} onClick={() => setMode("replace")}>{t("replace")}</Button><Button size="xs" variant={mode === "merge" ? "secondary" : "ghost"} onClick={() => setMode("merge")}>{t("merge")}</Button></span> : null}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => { if (type) { onPick(newBlock(type)); onOpenChange(false); } }}><Plus /> {t("emptyBlock")}</Button>
        <Button size="sm" variant="ghost" nativeButton={false} render={<a href={type ? `#/palette?type=${type}` : "#/palette"} />}><LayoutTemplate /> {t("managePalette")}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {presets === null ? <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("loading")}</div> : list.length === 0 ? <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("noPresets")}</p> : <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">{list.map((preset, index) => <button key={preset.id ?? `preset-${index}`} type="button" onClick={() => pick(preset)} className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary focus-visible:border-primary focus-visible:outline-none">
          <ExampleStrip examples={preset.examples} />
          <div className="flex flex-col gap-1 p-2"><div className="flex items-center gap-1"><span className="truncate text-sm font-medium" title={presetName(preset)}>{presetName(preset)}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{preset.usage ? t("images", { count: preset.usage }) : ""}</span></div><p className="line-clamp-2 font-mono text-[11px] leading-4 text-muted-foreground">{blockSummary(preset.block)}</p>{presetNotes(preset) ? <p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{presetNotes(preset)}</p> : null}{preset.tags.length ? <div className="flex flex-wrap gap-1">{preset.tags.slice(0, 3).map(tag => <Badge key={tag} variant="secondary" className="h-4 px-1 text-[10px]">{tag}</Badge>)}</div> : null}</div>
        </button>)}</div>}
      </div>
    </DialogContent>
  </Dialog>;
}

export default BlockPicker;
