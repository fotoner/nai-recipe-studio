import * as React from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { StudioClient, StoredCharacter } from "@/contracts/studio";
import { errorMessage, studioCall, subscribeToStudio } from "@/desktop/renderer/studio-client";
import { type BlockType, type Character } from "@/features/shared/types";
import { readAllPages } from "@/features/shared/pagination";
import { useTranslation } from "react-i18next";
import { usePaletteTranslation } from "./locale";
import {
  BLOCK_ICON,
  BlockDescription,
  emptyPreset,
  ORDER,
  PresetCard,
  PresetDialog,
  sortPresets,
  StyleCompare,
  type LibrarySort,
  type PalettePreset,
  type PresetDraft,
  useDefaultStyleName,
} from "./PaletteComponents";

const SORTS = ["usage", "usage_asc", "newest", "oldest"] as const satisfies readonly LibrarySort[];

function useChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = React.useState<T>(() => {
    try { const stored = localStorage.getItem(key) as T | null; return stored && allowed.includes(stored) ? stored : fallback; } catch { return fallback; }
  });
  const set = React.useCallback((next: T) => { try { localStorage.setItem(key, next); } catch { /* a local preference is optional */ } setValue(next); }, [key]);
  return [value, set];
}

export type PaletteProps = { client?: StudioClient };

export function PaletteFeature({ client }: PaletteProps) {
  const { t } = useTranslation();
  const { t: tp } = usePaletteTranslation();
  const [type, setType] = React.useState<BlockType>(() => {
    if (typeof window === "undefined") return "scene";
    const query = window.location.hash.includes("?") ? window.location.hash.split("?")[1] : window.location.search.slice(1);
    const value = new URLSearchParams(query).get("type");
    return value && (ORDER as readonly string[]).includes(value) ? value as BlockType : "scene";
  });
  const [all, setAll] = React.useState<PalettePreset[] | null>(null);
  const [characters, setCharacters] = React.useState<Character[]>([]);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = useChoice<LibrarySort>("studio.presets.sort", "usage", SORTS);
  const [draft, setDraft] = React.useState<PresetDraft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [defaultStyle, setDefaultStyle] = useDefaultStyleName();

  const load = React.useCallback(async () => {
    if (!client) { setAll([]); setCharacters([]); return; }
    setError(null);
    try {
      const [presetsResult, charactersResult] = await Promise.allSettled([
        readAllPages(({ limit, offset }) => studioCall(client, "presets.list", { limit, offset, includeHidden: false })),
        readAllPages(({ limit, offset }) => studioCall(client, "characters.list", { limit, offset })),
      ]);
      if (presetsResult.status !== "fulfilled") throw presetsResult.reason;
      setAll(presetsResult.value.map((preset) => ({
        ...preset,
        usage: preset.usage ?? 0,
        examples: preset.examples ?? [],
      })));
      setCharacters(charactersResult.status === "fulfilled" ? charactersResult.value as StoredCharacter[] : []);
    } catch (cause) {
      setError(errorMessage(cause, "errors.load"));
      setAll([]);
    }
  }, [client]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    if (!client) return;
    return subscribeToStudio(client, (event) => {
      if (event.type === "workspace.changed" && (event.entity === "presets" || event.entity === "characters" || event.entity === "gallery")) void load();
    });
  }, [client, load]);

  const counts = React.useMemo(() => {
    const value: Partial<Record<BlockType, number>> = {};
    for (const preset of all ?? []) value[preset.type] = (value[preset.type] ?? 0) + 1;
    return value;
  }, [all]);
  const list = React.useMemo(() => {
    const search = query.trim().toLowerCase();
    return sortPresets((all ?? []).filter((preset) => preset.type === type).filter((preset) => !search || [preset.name, preset.notes, ...preset.tags, JSON.stringify(preset.block)].join(" ").toLowerCase().includes(search)), sort);
  }, [all, query, sort, type]);

  const remove = async (preset: PalettePreset) => {
    if (!client || preset.builtinId || !window.confirm(tp("deleteConfirm", { name: preset.name }))) return;
    try { await studioCall(client, "presets.delete", { id: preset.id }); await load(); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
  };
  const translatedError = error && error.startsWith("errors.") ? t(error) : error ? tp("errorLoad") : null;

  return <>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
      <div className="min-w-0"><h1 className="text-base font-semibold tracking-tight">{tp("pageTitle")}</h1><p className="truncate text-xs text-muted-foreground">{tp("pageDescription")}</p></div>
      <div className="flex flex-wrap items-center gap-2"><SortControl value={sort} onChange={setSort} label={tp("sortLabel")} /><div className="relative"><Search className="absolute top-2 left-2 size-4 text-muted-foreground" /><Input aria-label={t("common.search")} className="h-8 w-44 pl-7" placeholder={tp("searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} /></div><Button size="sm" onClick={() => setDraft(emptyPreset(type))}><Plus />{tp("newPreset", { label: tp(`block.${type}`) })}</Button></div>
    </header>
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[11rem_minmax(0,1fr)] md:p-6">
      <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">{ORDER.map((item) => { const Icon = BLOCK_ICON[item]; return <button key={item} type="button" onClick={() => setType(item)} title={tp("descriptionGeneric")} className={cn("flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors", item === type ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}><Icon className="size-4 shrink-0 text-muted-foreground" /><span className="flex-1 text-left">{tp(`block.${item}`)}</span><span className="font-mono text-[10px] text-muted-foreground">{counts[item] ?? 0}</span></button>; })}</nav>
      <div className="flex flex-col gap-3">
        {translatedError ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{translatedError}</p> : null}
        {notice ? <p role="status" className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs text-primary">{notice}</p> : null}
        <BlockDescription type={type} />
        {type === "style" && all ? <StyleCompare presets={all.filter((preset) => preset.type === "style")} /> : null}
        {all === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{tp("loading")}</div> : list.length === 0 ? <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{tp("emptyType", { label: tp(`block.${type}`) })}</p> : <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-3">{list.map((preset) => <PresetCard key={preset.id} preset={preset} onEdit={() => setDraft({ id: preset.id, type: preset.type, name: preset.name, block: preset.block, tags: preset.tags, notes: preset.notes })} onDuplicate={() => setDraft({ type: preset.type, name: `${preset.name} · ${t("common.duplicate")}`, block: preset.block, tags: [...preset.tags], notes: preset.notes })} onRemove={() => void remove(preset)} isDefault={preset.type === "style" && defaultStyle === preset.name} onDefault={preset.type === "style" ? () => { setDefaultStyle(preset.name, preset.block); setNotice(`${tp("default")}: ${preset.name}`); } : undefined} />)}</div>}
      </div>
    </div>
    <PresetDialog client={client} draft={draft} characters={characters} onOpenChange={(open) => { if (!open) setDraft(null); }} onSaved={(saved) => { setNotice(saved.name); void load(); }} />
  </>;
}

function SortControl({ value, onChange, label }: { value: LibrarySort; onChange: (value: LibrarySort) => void; label: string }) {
  const { t } = usePaletteTranslation();
  const options: Array<[LibrarySort, string]> = [["usage", t("sortUsage")], ["usage_asc", t("sortUsageAsc")], ["newest", t("sortNewest")], ["oldest", t("sortOldest")]];
  return <Select value={value} onValueChange={(next) => next && onChange(next as LibrarySort)} items={options.map(([option, text]) => ({ value: option, label: text }))}><SelectTrigger size="sm" aria-label={label} className="w-36"><SelectValue /></SelectTrigger><SelectContent>{options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectContent></Select>;
}
