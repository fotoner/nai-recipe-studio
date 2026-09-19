import { useCastTranslation } from "./locale";
import * as React from "react";
import { Check, Plus, Search } from "lucide-react";
import type { Character } from "@/features/shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ExampleStrip, LibrarySortControl, sortLibraryItems, useLibrarySort, type GalleryExample } from "./BlockPicker";

export type LibraryCharacter = Character & Partial<{ examples: GalleryExample[]; generation_count: number; created_at: string }>;

export function CharacterPicker({ characters, selectedIds, onAdd }: { characters: LibraryCharacter[]; selectedIds: number[]; onAdd: (id: number) => void }) {
  const { t } = useCastTranslation();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = useLibrarySort("characters");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const search = query.trim().toLowerCase();
  const list = sortLibraryItems(characters.filter(character => character.id !== undefined && (!search || [character.display_name, character.tag, character.series].some(value => value.toLowerCase().includes(search)))), sort);
  const full = selectedIds.length >= 6;

  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery(""); }}>
    <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}><Plus /> {t("addCharacter")}</DialogTrigger>
    <DialogContent initialFocus={searchRef} className="flex max-h-[90svh] flex-col gap-3 overflow-hidden sm:max-w-3xl">
      <DialogHeader><DialogTitle>{t("addCharacter")}</DialogTitle><DialogDescription>{t("characterHelp")}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap items-center gap-2"><div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" /><Input ref={searchRef} type="search" aria-label={t("characterSearch")} placeholder={t("characterSearchHint")} className="h-8 pl-8" value={query} onChange={event => setQuery(event.target.value)} /></div><LibrarySortControl value={sort} onChange={setSort} label={t("characterSort")} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-0.5">
        {list.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t(characters.length ? "noSearch" : "noCharacters")}</p> : <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">{list.map(character => {
          const selected = selectedIds.includes(character.id!);
          const name = character.display_name || character.tag;
          return <button key={character.id} type="button" aria-label={`${t(selected ? "added" : "add")}: ${name}`} disabled={selected || full} onClick={() => onAdd(character.id!)} className={cn("relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary enabled:hover:border-primary", selected ? "border-primary" : "border-border", full && !selected && "opacity-50")}>
            <ExampleStrip examples={character.examples ?? []} />
            {selected ? <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-primary px-2 py-1 text-xs text-primary-foreground"><Check className="size-3" /> {t("added")}</span> : null}
            <div className="flex w-full min-w-0 flex-col gap-1 p-2"><span className="truncate text-sm font-medium">{name}</span><span className="truncate font-mono text-[10px] text-muted-foreground">{character.tag}</span><span className="truncate text-[11px] text-muted-foreground">{character.series || t("original")} · {t("usage", { count: character.generation_count ?? 0 })}</span></div>
          </button>;
        })}</div>}
      </div>
      <DialogFooter className="flex-row items-center justify-between sm:justify-between"><div role="status" className="text-xs text-muted-foreground"><p>{t("selected", { count: selectedIds.length })}</p>{full ? <p className="mt-1">{t("full")}</p> : null}</div><Button type="button" size="sm" onClick={() => { setOpen(false); setQuery(""); }}>{t("done")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export default CharacterPicker;
