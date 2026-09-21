import * as React from "react";
import { LayoutGrid, Loader2, Plus, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StudioClient } from "@/contracts/studio";
import { errorMessage, studioCall, subscribeToStudio } from "@/desktop/renderer/studio-client";
import { readAllPages } from "@/features/shared/pagination";
import { type Character } from "@/features/shared/types";
import { useTranslation } from "react-i18next";
import { useCharactersTranslation } from "./locale";
import { CharacterCard, CharacterForm, CharacterTable, emptyCharacter, type CharacterCardData, type CharacterView } from "./CharacterComponents";

const VIEWS = ["cards", "table"] as const satisfies readonly CharacterView[];
type CharacterSort = "usage" | "usage_asc" | "newest" | "oldest";
const SORTS = ["usage", "usage_asc", "newest", "oldest"] as const satisfies readonly CharacterSort[];

function useChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = React.useState<T>(() => {
    try { const stored = localStorage.getItem(key) as T | null; return stored && allowed.includes(stored) ? stored : fallback; } catch { return fallback; }
  });
  const set = React.useCallback((next: T) => { try { localStorage.setItem(key, next); } catch { /* a local preference is optional */ } setValue(next); }, [key]);
  return [value, set];
}

function sortCharacters(items: CharacterCardData[], sort: CharacterSort): CharacterCardData[] {
  return [...items].sort((a, b) => {
    if (sort === "usage") return b.generation_count - a.generation_count || b.id - a.id;
    if (sort === "usage_asc") return a.generation_count - b.generation_count || b.id - a.id;
    const left = a.created_at ?? "";
    const right = b.created_at ?? "";
    return sort === "newest" ? right.localeCompare(left) : left.localeCompare(right);
  });
}

export type CharactersProps = { client?: StudioClient };

export function CharactersFeature({ client }: CharactersProps) {
  const { t } = useTranslation();
  const { t: tp } = useCharactersTranslation();
  const [characters, setCharacters] = React.useState<CharacterCardData[] | null>(null);
  const [blurSensitive, setBlurSensitive] = React.useState(true);
  const [editing, setEditing] = React.useState<Character | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = useChoice<CharacterSort>("studio.characters.sort", "usage", SORTS);
  const [view, setView] = useChoice<CharacterView>("studio.characters.view", "cards", VIEWS);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!client) { setCharacters([]); return; }
    setError(null);
    try {
      const characters = await readAllPages(({ limit, offset }) => studioCall(client, "characters.list", { limit, offset }));
      setCharacters(characters.map((character) => ({
        ...character,
        examples: character.examples ?? [],
        generation_count: character.generation_count ?? 0,
      })));
    } catch (cause) {
      setError(errorMessage(cause, "errors.load"));
      setCharacters([]);
    }
  }, [client]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    if (!client) return;
    let active = true;
    void studioCall(client, "settings.get", {}).then(settings => { if (active) setBlurSensitive(settings.blurSensitive ?? true); }).catch(() => undefined);
    return () => { active = false; };
  }, [client]);
  React.useEffect(() => {
    if (!client) return;
    return subscribeToStudio(client, (event) => {
      if (event.type === "workspace.changed" && (event.entity === "characters" || event.entity === "gallery")) void load();
      if (event.type === "settings.changed") setBlurSensitive(event.settings.blurSensitive);
    });
  }, [client, load]);

  const submit = async (character: Character) => {
    if (!client || busy) return;
    setBusy(true); setError(null);
    try { await studioCall(client, "characters.save", { character }); setEditing(null); await load(); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };
  const remove = async (character: CharacterCardData) => {
    if (!client || !window.confirm(tp("deleteConfirm", { tag: character.tag }))) return;
    setBusy(true); setError(null);
    try { await studioCall(client, "characters.delete", { id: character.id }); await load(); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };
  const visible = React.useMemo(() => {
    const search = query.trim().toLowerCase();
    return sortCharacters((characters ?? []).filter((character) => !search || [character.tag, character.series, character.display_name].join(" ").toLowerCase().includes(search)), sort);
  }, [characters, query, sort]);
  const translatedError = error && error.startsWith("errors.") ? t(error) : error ? tp("errorLoad") : null;

  return <>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6"><div className="min-w-0"><h1 className="text-base font-semibold tracking-tight">{t("characters.title")}</h1><p className="truncate text-xs text-muted-foreground">{characters ? tp("count", { count: characters.length }) : ""}</p></div><div className="flex flex-wrap items-center gap-2"><Input className="h-8 w-44" aria-label={t("common.search")} placeholder={tp("searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} /><Select value={sort} onValueChange={(next) => next && setSort(next as CharacterSort)} items={[["usage", tp("sortUsage")], ["usage_asc", tp("sortUsageAsc")], ["newest", tp("sortNewest")], ["oldest", tp("sortOldest")]].map(([value, label]) => ({ value, label }))}><SelectTrigger size="sm" aria-label={tp("sortLabel")} className="w-36"><SelectValue /></SelectTrigger><SelectContent>{[["usage", tp("sortUsage")], ["usage_asc", tp("sortUsageAsc")], ["newest", tp("sortNewest")], ["oldest", tp("sortOldest")]].map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><div className="flex rounded-lg border border-border p-0.5"><Button size="icon-xs" variant={view === "cards" ? "secondary" : "ghost"} aria-label={tp("cards")} title={tp("cards")} onClick={() => setView("cards")}><LayoutGrid /></Button><Button size="icon-xs" variant={view === "table" ? "secondary" : "ghost"} aria-label={tp("table")} title={tp("table")} onClick={() => setView("table")}><Rows3 /></Button></div><Button size="sm" onClick={() => setEditing(emptyCharacter())}><Plus />{tp("register")}</Button></div></header>
    <div className="p-4 md:p-6">{translatedError ? <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{translatedError}</p> : null}{characters === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{tp("loading")}</div> : visible.length === 0 ? <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{tp("empty")}</p> : view === "cards" ? <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">{visible.map((character) => <CharacterCard key={character.id} character={character} onEdit={(item) => setEditing(item)} onRemove={(item) => void remove(item)} blurSensitive={blurSensitive} />)}</div> : <CharacterTable characters={visible} onEdit={(item) => setEditing(item)} onRemove={(item) => void remove(item)} blurSensitive={blurSensitive} />}</div>
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{editing?.id ? t("characters.editCharacter") : t("characters.newCharacter")}</DialogTitle><DialogDescription>{tp("dialogDescription")}</DialogDescription></DialogHeader>{editing ? <CharacterForm key={editing.id ?? "new"} value={editing} busy={busy} onSubmit={submit} onCancel={() => setEditing(null)} client={client} /> : null}</DialogContent></Dialog>
  </>;
}
