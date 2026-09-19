import * as React from "react";
import { BookOpen, CircleAlert, CircleCheck, Copy, Eye, EyeOff, FileUp, ImageOff, LayoutGrid, Loader2, Plus, Rows3, Search, ShieldCheck, TriangleAlert, Trash2 } from "lucide-react";
import type { StudioClient } from "@/contracts/studio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortControl } from "@/features/palette/PaletteComponents";
import { sortLibraryItems, type LibrarySort } from "@/lib/library-sort";
import { cx } from "@/features/shared/ui";
import { newRecipe, type Recipe, type RecipeSummary } from "@/features/shared/types";
import { studioCall, errorMessage, subscribeToStudio } from "@/desktop/renderer/studio-client";
import { useTranslation } from "react-i18next";
import { LintSheet, type RecipeLintRow, type RecipeLintFixItem } from "./LintSheet";
import { useRecipeLintTranslation } from "./locale";
import { readAllPages } from "@/features/shared/pagination";

function listRecipes(client: StudioClient, query?: string): Promise<RecipeSummary[]> {
  return readAllPages(request => studioCall(client, "recipes.list", { query, ...request }));
}


type RecipesFeatureProps = { client?: StudioClient; onOpenRecipe: (id: number) => void; onOpenGeneration: (recipe?: Recipe) => void };
type RecipeView = "cards" | "table";

export function RecipesFeature({ client, onOpenRecipe }: RecipesFeatureProps) {
  const { t, i18n } = useTranslation();
  const { t: lintT } = useRecipeLintTranslation();
  const [lintRows, setLintRows] = React.useState<RecipeLintRow[] | null>(null);
  const [lintOpen, setLintOpen] = React.useState(false);
  const [lintBusy, setLintBusy] = React.useState(false);
  const [onlyIssues, setOnlyIssues] = React.useState(false);
  const lintBy = React.useMemo(() => new Map((lintRows ?? []).map(row => [row.recipe.id, row])), [lintRows]);
  const [recipes, setRecipes] = React.useState<RecipeSummary[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<RecipeView>("cards");
  const [sort, setSort] = React.useState<LibrarySort>("usage");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [blurSensitive, setBlurSensitive] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!client) { setRecipes([]); return; }
    setError(null);
    try {
      setRecipes(await listRecipes(client));
    } catch (cause) { setError(errorMessage(cause, "errors.load")); setRecipes([]); }
  }, [client]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    if (!client) return;
    let active = true;
    void studioCall(client, "settings.get", {}).then((settings) => { if (active) setBlurSensitive(settings.blurSensitive); }).catch(() => undefined);
    const unsubscribe = subscribeToStudio(client, (event) => {
      if (event.type === "settings.changed") setBlurSensitive(event.settings.blurSensitive);
      if (event.type === "workspace.changed" && (event.entity === "recipes" || event.entity === "gallery")) void load();
    });
    return () => { active = false; unsubscribe(); };
  }, [client, load]);

  const create = async () => {
    if (!client || busy) return;
    setBusy(true);
    try { const saved = await studioCall(client, "recipes.save", { recipe: newRecipe(t("recipes.newRecipe")) }); onOpenRecipe(saved.id); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };
  const duplicate = async (recipe: RecipeSummary) => {
    if (!client || !recipe.id) return;
    setBusy(true);
    try { await studioCall(client, "recipes.duplicate", { id: recipe.id, name: `${recipe.name} · ${t("common.duplicate")}` }); await load(); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };
  const remove = async (recipe: RecipeSummary) => {
    if (!client || !recipe.id || !window.confirm(t("recipes.deleteDescription"))) return;
    setBusy(true);
    try { await studioCall(client, "recipes.delete", { id: recipe.id }); await load(); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };
  const importRecipe = async () => {
    if (!client || busy) return;
    setBusy(true);
    try { const imported = await studioCall(client, "files.importRecipe", {}); if (imported.recipe) { const saved = await studioCall(client, "recipes.save", { recipe: imported.recipe }); onOpenRecipe(saved.id); } else if (imported.warnings.length) setError("errors.invalidRecipe"); }
    catch (cause) { setError(errorMessage(cause, "errors.import")); }
    finally { setBusy(false); }
  };

  const runLint = async () => {
    if (!client) return;
    setLintOpen(true); setLintBusy(true); setError(null);
    try {
      const items = await listRecipes(client);
      const rows = await Promise.all(items.map(async recipe => ({ recipe, findings: (await studioCall(client, "recipe.validate", { recipe })).findings })));
      setLintRows(rows);
    } catch (cause) { setError(errorMessage(cause, "errors.load")); }
    finally { setLintBusy(false); }
  };
  const fixSelected = async (items: RecipeLintFixItem[]) => {
    if (!client) return;
    setLintBusy(true); setError(null);
    try {
      for (const item of items) {
        const row = lintBy.get(item.recipe_id);
        if (!row) continue;
        const fixed = await studioCall(client, "recipe.validate", { recipe: row.recipe, fixes: item.rules });
        const recipe = fixed.applied.length ? await studioCall(client, "recipes.save", { recipe: fixed.recipe, expectedVersion: row.recipe.version }) : row.recipe;
        setLintRows(current => current?.map(existing => existing.recipe.id === recipe.id ? { recipe: { ...recipe, id: item.recipe_id }, findings: fixed.findings } : existing) ?? null);
      }
      await load();
    } catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setLintBusy(false); }
  };
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortLibraryItems((recipes ?? []).filter((recipe) => (!q || recipe.name.toLowerCase().includes(q) || recipe.tags.some((tag) => tag.toLowerCase().includes(q))) && (!onlyIssues || !lintRows || lintBy.get(recipe.id)?.findings.some(finding => finding.severity !== "info"))), sort);
  }, [query, recipes, sort, onlyIssues, lintRows, lintBy]);
  const translatedError = error && error.startsWith("errors.") ? t(error) : error ? t("errors.unknown") : null;

  return <>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
      <div className="min-w-0"><h1 className="text-base font-semibold tracking-tight">{t("recipes.title")}</h1><p className="truncate text-xs text-muted-foreground">{recipes ? lintT("librarySummary", { count: recipes.length, thumbnails: recipes.filter(recipe => recipe.latest).length }) : ""}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative"><Search className="absolute top-2 left-2 size-4 text-muted-foreground" /><Input aria-label={t("common.search")} className="h-8 w-44 pl-7" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("recipes.searchPlaceholder")} /></div>
        <SortControl value={sort} onChange={setSort} label={t("recipesExtra.sort")} />
        <div className="flex rounded-lg border border-border p-0.5"><Button size="icon-xs" variant={view === "cards" ? "secondary" : "ghost"} aria-label={t("recipesExtra.viewCards")} onClick={() => setView("cards")}><LayoutGrid /></Button><Button size="icon-xs" variant={view === "table" ? "secondary" : "ghost"} aria-label={t("recipesExtra.viewTable")} onClick={() => setView("table")}><Rows3 /></Button></div>
        {lintRows ? <Button size="sm" variant={onlyIssues ? "secondary" : "ghost"} onClick={() => setOnlyIssues(value => !value)}>{lintT("issuesOnly")}</Button> : null}
        <Button size="sm" variant="outline" disabled={lintBusy} onClick={() => void runLint()}>{lintBusy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{lintT("check")}</Button>
        <Button size="sm" variant="outline" onClick={() => void importRecipe()} disabled={busy}><FileUp />{t("recipes.importRecipe")}</Button><Button size="sm" disabled={busy} onClick={() => void create()}><Plus />{t("recipes.newRecipe")}</Button>
      </div>
    </div>
    <div className="p-4 md:p-6">
      {translatedError ? <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{translatedError}</div> : null}
      {recipes === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("common.loading")}</div> : visible.length === 0 ? <div className="rounded-lg border border-dashed border-border p-8 text-center"><BookOpen className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm text-muted-foreground">{query ? t("recipes.noResults") : t("recipes.emptyTitle")}</p>{!query ? <><p className="mt-1 text-xs text-muted-foreground">{t("recipes.emptyDescription")}</p><div className="mt-4 flex justify-center gap-2"><Button size="sm" onClick={() => void create()}><Plus />{t("recipes.newRecipe")}</Button><Button size="sm" variant="outline" onClick={() => void importRecipe()}><FileUp />{t("recipes.importRecipe")}</Button></div></> : null}</div> : view === "cards" ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">{visible.map((recipe) => <RecipeCard key={recipe.id} recipe={recipe} lint={lintBy.get(recipe.id)} locale={i18n.language} blurSensitive={blurSensitive} onOpen={() => recipe.id && onOpenRecipe(recipe.id)} onDuplicate={() => void duplicate(recipe)} onDelete={() => void remove(recipe)} />)}</div> : <RecipeTable recipes={visible} onOpen={onOpenRecipe} onDuplicate={(recipe) => void duplicate(recipe)} onDelete={(recipe) => void remove(recipe)} />}
    </div>
    <LintSheet open={lintOpen} onOpenChange={setLintOpen} rows={lintRows} busy={lintBusy} onRerun={() => void runLint()} onFix={fixSelected} />
  </>;
}

function LintBadge({ row }: { row?: RecipeLintRow }) {
  const { t } = useTranslation();
  if (!row) return null;
  const errors = row.findings.filter(finding => finding.severity === "error").length;
  const warnings = row.findings.filter(finding => finding.severity === "warn").length;
  return <span className="absolute right-1.5 bottom-1.5 flex gap-1">{errors ? <Badge variant="destructive" className="h-4 gap-0.5 px-1 text-[10px]"><CircleAlert className="size-3" />{errors}</Badge> : null}{warnings ? <Badge variant="outline" className="h-4 gap-0.5 bg-background px-1 text-[10px] text-amber-500"><TriangleAlert className="size-3" />{warnings}</Badge> : null}{!errors && !warnings ? <Badge variant="secondary" className="h-4 gap-0.5 px-1 text-[10px]"><CircleCheck className="size-3 text-emerald-500" />{t("common.ready")}</Badge> : null}</span>;
}

function RecipeCard({ recipe, lint, locale, blurSensitive, onOpen, onDuplicate, onDelete }: { recipe: RecipeSummary; lint?: RecipeLintRow; locale: string; blurSensitive: boolean; onOpen: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const [reveal, setReveal] = React.useState(false);
  const latest = recipe.latest;
  const hidden = !!latest && blurSensitive && latest.rating >= 1 && !reveal;
  const date = recipe.updated_at ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(recipe.updated_at)) : "";
  return <div className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/30">
    <div className="relative aspect-3/4 w-full overflow-hidden bg-muted">
      <button type="button" className="block h-full w-full" onClick={onOpen} aria-label={recipe.name || t("common.untitled")}>
        {latest?.url ? <img src={latest.url} alt="" className={cx("h-full w-full object-cover transition", hidden && "blur-xl")} /> : <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground"><ImageOff className="size-6" /><span className="text-[11px]">{t("recipesExtra.generatedNone")}</span></div>}
      </button>
      <LintBadge row={lint} />
      {(recipe.generation_count ?? 0) > 1 ? <Badge variant="secondary" className="pointer-events-none absolute bottom-1.5 left-1.5 h-4 px-1 font-mono text-[10px]">{recipe.generation_count}</Badge> : null}
      {recipe.rating >= 1 ? <Badge variant="destructive" className="pointer-events-none absolute top-1.5 left-1.5 h-4 px-1 text-[10px]">R{recipe.rating}</Badge> : null}
      {latest && blurSensitive && latest.rating >= 1 ? <Button size="icon-xs" variant="secondary" className="absolute top-1.5 right-1.5" aria-label={hidden ? t("common.open") : t("common.close")} onClick={(event) => { event.stopPropagation(); setReveal((value) => !value); }}>{hidden ? <EyeOff /> : <Eye />}</Button> : null}
    </div>
    <div className="flex flex-col gap-1.5 p-2.5"><button type="button" className="truncate text-left text-sm font-medium hover:underline" onClick={onOpen} title={recipe.name}>{recipe.name || t("common.untitled")}</button><div className="flex flex-wrap items-center gap-1">{recipe.tags.slice(0, 2).map((tag) => <Badge key={tag} variant="secondary" className="h-4 px-1 text-[10px]">{tag}</Badge>)}{recipe.tags.length > 2 ? <span className="text-[10px] text-muted-foreground">+{recipe.tags.length - 2}</span> : null}</div><div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground"><span title={recipe.updated_at}>{date}</span><span className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"><Button size="icon-xs" variant="ghost" aria-label={t("common.duplicate")} onClick={onDuplicate}><Copy /></Button><Button size="icon-xs" variant="ghost" aria-label={t("common.delete")} onClick={onDelete}><Trash2 /></Button></span></div></div>
  </div>;
}

function RecipeTable({ recipes, onOpen, onDuplicate, onDelete }: { recipes: RecipeSummary[]; onOpen: (id: number) => void; onDuplicate: (recipe: RecipeSummary) => void; onDelete: (recipe: RecipeSummary) => void }) {
  const { t } = useTranslation();
  return <div className="overflow-x-auto rounded-xl border border-border"><Table><TableHeader><TableRow><TableHead>{t("recipesExtra.name")}</TableHead><TableHead className="hidden md:table-cell">{t("recipesExtra.tags")}</TableHead><TableHead>{t("recipesExtra.rating")}</TableHead><TableHead>{t("recipesExtra.blocks")}</TableHead><TableHead className="text-right">{t("common.edit")}</TableHead></TableRow></TableHeader><TableBody>{recipes.map((recipe) => <TableRow key={recipe.id}><TableCell className="max-w-[18rem] truncate"><button type="button" className="font-medium hover:underline" onClick={() => recipe.id && onOpen(recipe.id)}>{recipe.name || t("common.untitled")}</button></TableCell><TableCell className="hidden md:table-cell"><div className="flex flex-wrap gap-1">{recipe.tags.slice(0, 3).map((tag) => <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>)}</div></TableCell><TableCell><Badge variant={recipe.rating >= 1 ? "destructive" : "outline"}>{recipe.rating}</Badge></TableCell><TableCell>{recipe.blocks.length}</TableCell><TableCell className="text-right whitespace-nowrap"><Button size="icon-xs" variant="ghost" aria-label={t("common.duplicate")} onClick={() => onDuplicate(recipe)}><Copy /></Button><Button size="icon-xs" variant="ghost" aria-label={t("common.delete")} onClick={() => onDelete(recipe)}><Trash2 /></Button></TableCell></TableRow>)}</TableBody></Table></div>;
}
