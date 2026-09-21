import * as React from "react";
import { Check, ExternalLink, ImageOff, Loader2, Search, Sparkles, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GalleryItem as StoredGalleryItem, GenerationJob, GenerationPlan, Recipe, RecipeSummary } from "@/features/shared/types";
import type { StudioClient, StudioEvent } from "@/contracts/studio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/features/shared/ui";
import { readAllPages } from "@/features/shared/pagination";
import { Thumbnail } from "@/features/gallery/Thumbnail";
import { errorMessage, studioCall, subscribeToStudio } from "@/desktop/renderer/studio-client";
import { GenerationResults } from "./GenerationResults";
import { useGenerationTranslation } from "./locale";
import type { GenerationDraftFromImage } from "@/core/recipe/from-generation";

type GenerationProps = { client?: StudioClient; initialRecipe?: Recipe; onOpenGallery: () => void; onBusyChange?: (busy: boolean) => void; onContinueFromGeneration?: (draft: GenerationDraftFromImage) => void };
type BatchRow = { recipe_id: number; name: string; ok: boolean; count: number; error?: string };
type ActiveBatch = { name: string; index: number; total: number };
type BatchQueue = { plans: GenerationPlan[]; index: number; jobId?: string; allowPaid: boolean };

function normalizeRecipe(value: unknown): Recipe {
  const input = (value ?? {}) as Recipe;
  const fallback: Recipe = { name: "", tags: [], rating: 0, blocks: [], source: "manual", notes: "" };
  const merged = { ...fallback, ...input };
  return { ...merged, blocks: Array.isArray(input.blocks) ? input.blocks : fallback.blocks };
}

function isActiveJob(job: GenerationJob | null | undefined) { return !!job && (job.state === "queued" || job.state === "running"); }
function isFinishedJob(job: GenerationJob) { return job.state === "completed" || job.state === "failed" || job.state === "cancelled" || job.state === "interrupted"; }
function settingsOf(recipe: Recipe) { return recipe.blocks.find(block => block.type === "settings"); }
function settingsSummary(recipe: Recipe, stepsLabel: string) {
  const settings = settingsOf(recipe);
  return settings?.type === "settings" ? `${settings.width}×${settings.height} · ${settings.steps}${stepsLabel}` : "";
}
function pendingLabel(plan: GenerationPlan, t: (key: string, options?: Record<string, unknown>) => string) {
  return `${plan.recipe.name || t("untitled")} · ${t("fixedCount", { count: plan.count })}`;
}

export function GenerationFeature({ client, initialRecipe, onOpenGallery, onBusyChange, onContinueFromGeneration }: GenerationProps) {
  const { t } = useGenerationTranslation();
  const { t: centralT } = useTranslation();
  const [recipes, setRecipes] = React.useState<RecipeSummary[] | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<number[]>(initialRecipe?.id ? [initialRecipe.id] : []);
  const [count, setCount] = React.useState(1);
  const [paidForKey, setPaidForKey] = React.useState<string | null>(null);
  const [planning, setPlanning] = React.useState(false);
  const [planRevision, setPlanRevision] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [active, setActive] = React.useState<ActiveBatch | null>(null);
  const [rows, setRows] = React.useState<BatchRow[]>([]);
  const [images, setImages] = React.useState<StoredGalleryItem[]>([]);
  const [plans, setPlans] = React.useState<GenerationPlan[]>([]);
  const [preparedInputKey, setPreparedInputKey] = React.useState("");
  const [pendingPlans, setPendingPlans] = React.useState<GenerationPlan[]>([]);
  const [pendingId, setPendingId] = React.useState("");
  const [pendingPlan, setPendingPlan] = React.useState<GenerationPlan | null>(null);
  const [pendingPaid, setPendingPaid] = React.useState(false);
  const [job, setJob] = React.useState<GenerationJob | null>(null);
  const [jobs, setJobs] = React.useState<GenerationJob[]>([]);
  const [dryRun, setDryRun] = React.useState(false);
  const [error, setError] = React.useState("");
  const stop = React.useRef(false);
  const running = React.useRef(false);
  const mounted = React.useRef(true);
  const queue = React.useRef<BatchQueue | null>(null);
  const planSequence = React.useRef(0);
  const handledJobs = React.useRef(new Set<string>());
  const activeJob = React.useRef<GenerationJob | null>(null);
  const startNextRef = React.useRef<(() => Promise<void>) | null>(null);
  const busyCallbackRef = React.useRef(onBusyChange);
  busyCallbackRef.current = onBusyChange;

  React.useEffect(() => {
    mounted.current = true;
    stop.current = false;
    return () => { mounted.current = false; stop.current = true; };
  }, []);

  React.useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  React.useEffect(() => {
    busyCallbackRef.current?.(busy && queue.current !== null);
    return () => busyCallbackRef.current?.(false);
  }, [busy]);

  const updateJob = React.useCallback((next: GenerationJob) => {
    activeJob.current = next;
    if (!mounted.current) return;
    setJob(next);
    setJobs(current => [next, ...current.filter(item => item.id !== next.id)].slice(0, 20));
  }, []);

  const appendImages = React.useCallback(async (ids: number[]) => {
    if (!client || !ids.length) return;
    const results = await Promise.allSettled(ids.map(id => studioCall(client, "gallery.get", { id })));
    const next = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []) as StoredGalleryItem[];
    if (mounted.current && next.length) setImages(current => [...current, ...next.filter(item => !current.some(existing => existing.id === item.id))]);
  }, [client]);

  const finishBatch = React.useCallback(() => {
    queue.current = null;
    running.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setStopping(false);
    setPlans([]);
    setPreparedInputKey("");
    setPaidForKey(null);
    setPlanRevision(value => value + 1);
  }, []);

  const finishJob = React.useCallback(async (finished: GenerationJob) => {
    if (handledJobs.current.has(finished.id)) return;
    handledJobs.current.add(finished.id);
    const currentQueue = queue.current;
    if (!currentQueue || currentQueue.jobId !== finished.id) return;
    const plan = currentQueue.plans[currentQueue.index];
    if (plan) {
      await appendImages(finished.generationIds);
      if (mounted.current) setRows(current => [...current, {
        recipe_id: plan.recipe.id ?? 0,
        name: plan.recipe.name,
        ok: finished.state === "completed",
        count: finished.completed,
        ...(finished.error ? { error: finished.error.messageKey } : {}),
      }]);
    }
    currentQueue.index += 1;
    currentQueue.jobId = undefined;
    if (stop.current || currentQueue.index >= currentQueue.plans.length) {
      finishBatch();
      return;
    }
    await startNextRef.current?.();
  }, [appendImages, finishBatch]);

  const startNext = React.useCallback(async () => {
    if (!client || !queue.current || queue.current.jobId) return;
    const currentQueue = queue.current;
    if (stop.current || currentQueue.index >= currentQueue.plans.length) { finishBatch(); return; }
    const plan = currentQueue.plans[currentQueue.index];
    if (!plan) { finishBatch(); return; }
    if (mounted.current) setActive({ name: plan.recipe.name, index: currentQueue.index, total: currentQueue.plans.length });
    try {
      const approved = plan.approved ? plan : await studioCall(client, "generation.approve", { planId: plan.id, ...(plan.estimatedAnlas !== null && plan.estimatedAnlas > 0 && currentQueue.allowPaid ? { allowPaid: true } : {}) });
      if (stop.current || !mounted.current) { finishBatch(); return; }
      if (mounted.current) setPlans(current => current.map(item => item.id === approved.id ? approved : item));
      const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const next = await studioCall(client, "generation.start", { planId: approved.id, requestId });
      currentQueue.jobId = next.id;
      handledJobs.current.delete(next.id);
      updateJob(next);
      if (stop.current && isActiveJob(next)) {
        try {
          const cancelled = await studioCall(client, "generation.cancel", { id: next.id });
          updateJob(cancelled);
          if (isFinishedJob(cancelled)) await finishJob(cancelled);
        } catch (cause) {
          if (mounted.current) setError(errorMessage(cause, "errors.generation"));
        }
        return;
      }
      if (isFinishedJob(next)) await finishJob(next);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, "errors.generation"));
      stop.current = true;
      if (mounted.current) setStopping(true);
      finishBatch();
    }
  }, [client, finishBatch, finishJob, updateJob]);
  startNextRef.current = startNext;

  const load = React.useCallback(async () => {
    if (!client) { setRecipes([]); return; }
    setLoadError("");
    const results = await Promise.allSettled([
      readAllPages(request => studioCall(client, "recipes.list", request)),
      studioCall(client, "generation.pending", {}),
      studioCall(client, "generation.list", {}),
      studioCall(client, "status.read", {}),
    ]);
    const recipeResult = results[0];
    if (recipeResult.status === "rejected") setLoadError(errorMessage(recipeResult.reason, "generationView.loadFailed"));
    else {
      const listed: RecipeSummary[] = recipeResult.value.map(recipe => ({ ...recipe }));
      if (initialRecipe?.id) {
        const index = listed.findIndex(recipe => recipe.id === initialRecipe.id);
        const initial = { ...initialRecipe, latest: index >= 0 ? listed[index].latest : undefined } as RecipeSummary;
        if (index >= 0) listed[index] = { ...listed[index], ...initial, latest: listed[index].latest };
        else listed.unshift(initial);
      }
      setRecipes(listed);
    }
    if (results[1].status === "fulfilled") setPendingPlans(Array.isArray(results[1].value) ? results[1].value.filter(plan => Boolean(plan.connectionId)) : []);
    if (results[2].status === "fulfilled") {
      const listedJobs = Array.isArray(results[2].value) ? results[2].value : [];
      setJobs(listedJobs);
      const current = listedJobs.find(isActiveJob);
      if (current) updateJob(current);
    }
    if (results[3].status === "fulfilled") setDryRun(results[3].value.dryRun === true);
  }, [client, initialRecipe, updateJob]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (!client) return;
    return subscribeToStudio(client, (event: StudioEvent) => {
      if (event.type === "generation.prepared" && event.plan.connectionId) {
        setPendingPlans(current => [event.plan, ...current.filter(item => item.id !== event.plan.id)]);
        if (!pendingPlan) { setPendingId(event.plan.id); setPendingPlan(event.plan); setPendingPaid(false); }
      }
      if (event.type === "job.changed") updateJob(event.job);
    });
  }, [client, pendingPlan, updateJob]);

  React.useEffect(() => {
    if (!client || !job || !isActiveJob(job)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void studioCall(client, "generation.status", { id: job.id }).then(next => {
        if (cancelled) return;
        updateJob(next);
        if (isFinishedJob(next)) void finishJob(next);
      }).catch(() => undefined);
    }, 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client, finishJob, job, updateJob]);

  React.useEffect(() => {
    if (job && isFinishedJob(job)) void finishJob(job);
  }, [finishJob, job]);

  const visible = React.useMemo(() => {
    const search = query.trim().toLowerCase();
    return (recipes ?? []).filter(recipe => !search || [recipe.name, ...recipe.tags].join(" ").toLowerCase().includes(search));
  }, [query, recipes]);
  const selected = React.useMemo(() => (recipes ?? []).filter(recipe => picked.includes(recipe.id)), [picked, recipes]);
  const selectedCount = selected.length;
  const total = selectedCount * count;
  const missingSettings = selected.some(recipe => !settingsOf(recipe));
  const planInputKey = JSON.stringify({ recipes: selected.map(recipe => ({ id: recipe.id, version: recipe.version, recipe: normalizeRecipe(recipe) })), count });
  const allPlansReady = selectedCount > 0 && preparedInputKey === planInputKey && plans.length === selectedCount && plans.every(plan => plan.count === count && selected.some(recipe => recipe.id === plan.recipe.id));
  const estimated = allPlansReady ? plans.reduce<number | null>((sum, plan) => plan.estimatedAnlas === null || sum === null ? null : sum + plan.estimatedAnlas, 0) : null;
  const hasValidationErrors = plans.some(plan => plan.findings.some(finding => finding.severity === "error"));
  const pending = pendingPlans.find(plan => plan.id === pendingId) ?? pendingPlan;
  const pendingFindings = pending?.findings ?? [];
  const pendingHasValidationErrors = pendingFindings.some(finding => finding.severity === "error");
  const pendingEstimateUnknown = !!pending && pending.estimatedAnlas === null && !dryRun;
  const pendingNeedsPaidConfirmation = !!pending && !dryRun && pending.estimatedAnlas !== null && pending.estimatedAnlas > 0 && !pendingPaid;
  const pendingApprovalBlocked = pendingHasValidationErrors || pendingEstimateUnknown || pendingNeedsPaidConfirmation;
  const paidConsentKey = allPlansReady ? JSON.stringify({ input: planInputKey, plans: plans.map(plan => ({ id: plan.id, estimatedAnlas: plan.estimatedAnlas })) }) : "";
  const paid = Boolean(paidConsentKey && paidForKey === paidConsentKey);
  const canRun = allPlansReady && !planning && !busy && !missingSettings && !hasValidationErrors && (dryRun || estimated !== null) && (dryRun || estimated === 0 || paid);

  const clearRunState = () => { setPlans([]); setPreparedInputKey(""); setPaidForKey(null); setRows([]); setImages([]); setActive(null); setJob(null); setStopping(false); setError(""); stop.current = false; };
  const choose = (ids: number[]) => { setPicked(ids); clearRunState(); };
  const chooseRecipe = (recipe: RecipeSummary) => choose(picked.includes(recipe.id) ? picked.filter(id => id !== recipe.id) : [...picked, recipe.id]);

  React.useEffect(() => {
    const sequence = ++planSequence.current;
    let current = true;
    if (!client || !selectedCount || pending || missingSettings) {
      setPlans([]);
      setPreparedInputKey("");
      setPaidForKey(null);
      setPlanning(false);
      return () => { current = false; };
    }
    setPlanning(true);
    setPlans([]);
    setPreparedInputKey("");
    setPaidForKey(null);
    setError("");
    stop.current = false;
    void Promise.allSettled(selected.map(recipe => studioCall(client, "generation.prepare", { recipe: normalizeRecipe(recipe), count })))
      .then(results => {
        if (!current || sequence !== planSequence.current) return;
        const successful = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []) as GenerationPlan[];
        setPlans(successful);
        if (successful.length === selectedCount) setPreparedInputKey(planInputKey);
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") setError(errorMessage(failed.reason, "errors.generation"));
      })
      .finally(() => { if (current && sequence === planSequence.current) setPlanning(false); });
    return () => { current = false; };
  }, [client, count, missingSettings, pending, planInputKey, planRevision, selected, selectedCount]);

  const run = async () => {
    if (!client || !canRun || running.current || pending) return;
    running.current = true;
    stop.current = false;
    setBusy(true); setStopping(false); setError("");
    setPaidForKey(null);
    queue.current = { plans: [...plans], index: 0, allowPaid: paid };
    await startNext();
  };

  const selectPending = (id: string) => {
    const next = pendingPlans.find(plan => plan.id === id) ?? null;
    setPendingId(id); setPendingPlan(next); setPendingPaid(false); setPlans([]); setPreparedInputKey(""); setPaidForKey(null); setPicked(next?.recipe.id ? [next.recipe.id] : []); setError("");
  };
  const approvePending = async () => {
    if (!client || !pending || busy || pending.approved || pendingApprovalBlocked) return;
    setBusy(true); setError("");
    try {
      const allowPaid = pending.estimatedAnlas !== null && pending.estimatedAnlas > 0 && pendingPaid;
      const approved = await studioCall(client, "generation.approve", { planId: pending.id, ...(allowPaid ? { allowPaid: true } : {}) });
      setPendingPlan(approved); setPendingPlans(current => current.map(item => item.id === approved.id ? approved : item));
    } catch (cause) { setError(errorMessage(cause, "errors.generation")); }
    finally { setBusy(false); }
  };
  const requestStop = () => {
    stop.current = true;
    setStopping(true);
    const current = activeJob.current ?? job;
    if (!client || !current || !isActiveJob(current)) return;
    void studioCall(client, "generation.cancel", { id: current.id })
      .then(updateJob)
      .catch(cause => { if (mounted.current) setError(errorMessage(cause, "errors.generation")); });
  };

  const translatedError = error
    ? error.startsWith("generationView.") ? t(error.replace(/^generationView\./, "")) : error.startsWith("errors.") ? centralT(error) : error
    : "";
  const activeProgress = active && selectedCount ? Math.round((rows.length / active.total) * 100) : 0;
  const resultStatus = active ? (busy ? t("active", { name: active.name, done: rows.length, total: active.total }) : rows.length < active.total ? t("stopped") : t("completed")) : "";
  const pendingCost = pending ? pending.estimatedAnlas === null ? dryRun ? t("dryRunCost") : t("estimateUnknown") : pending.estimatedAnlas === 0 ? dryRun ? t("dryRunCost") : t("freeCost") : t("paidCost", { anlas: pending.estimatedAnlas.toLocaleString() }) : "";
  return <>
    <PageHeader title={t("title")} description={t("description")}>
      <a href="#/recipes" className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted">{t("recipeManagement")}</a>
    </PageHeader>

    {pendingPlans.length ? <section className="border-b border-border px-4 py-3 md:px-6">
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-sm font-semibold">{t("pendingTitle")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("pendingDescription")}</p></div><Badge variant="secondary">{pendingPlans.length}</Badge></div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-56 flex-1 flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{t("pendingPlan")}</span>
            <select className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" value={pendingId} onChange={event => selectPending(event.target.value)}>
              <option value="">{t("choosePending")}</option>
              {pendingPlans.map(item => <option key={item.id} value={item.id}>{pendingLabel(item, t)}</option>)}
            </select>
          </label>
          {pending ? <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            <strong className="text-foreground">{pending.connectionName ? t("preparedBy", { name: pending.connectionName }) : t("pendingReview")}</strong>
            <span>{t("fixedRecipe", { name: pending.recipe.name || t("untitled") })} · {t("fixedSettings", { settings: settingsSummary(normalizeRecipe(pending.recipe), t("steps")) || t("unknown") })}</span>
            <span>{t("fixedCount", { count: pending.count })} · {pending.seeds.length ? t("fixedSeeds", { seeds: pending.seeds.join(", ") }) : t("randomSeeds")}</span>
            <span>{t("estimatedCost")}: {pendingCost}</span>
          </div> : null}
          {pending && !pending.approved ? <Button size="sm" onClick={() => void approvePending()} disabled={busy || pendingApprovalBlocked}><Check />{t("approvePlan")}</Button> : pending ? <span role="status" className="text-xs text-muted-foreground">{t("approvedForMcp")}</span> : null}
        </div>
        {pending && !pending.approved && !dryRun && pending.estimatedAnlas !== null && pending.estimatedAnlas > 0 ? <label className="mt-2 flex items-start gap-2 text-xs leading-5"><Checkbox checked={pendingPaid} disabled={busy} onCheckedChange={value => setPendingPaid(Boolean(value))} className="mt-0.5" />{t("paidConfirm", { anlas: pending.estimatedAnlas.toLocaleString() })}</label> : null}
        {pending && pendingHasValidationErrors ? <div role="alert" className="mt-2 space-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{pendingFindings.filter(finding => finding.severity === "error").map(finding => <p key={`${pending.id}-${finding.code}`}>{centralT(finding.messageKey, finding.params)}</p>)}</div> : null}
      </div>
    </section> : null}

    <div className="grid grid-cols-1 items-start gap-5 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-label={t("recipeSelection")} className="min-w-0 rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold"><span className="mr-2 text-muted-foreground">01</span>{t("recipes")}</h2><Badge variant="secondary">{t("selected", { count: selectedCount })}</Badge></div>
        <div className="relative"><Search className="absolute top-2.5 left-3 size-3.5 text-muted-foreground" /><Input aria-label={t("search")} placeholder={t("search")} value={query} onChange={event => setQuery(event.target.value)} className="pl-8" /></div>
        <div className="my-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t("recipeCount", { count: visible.length })}</span><div className="flex gap-1"><Button size="xs" variant="ghost" disabled={busy || !visible.length || !!pending} onClick={() => choose([...new Set([...picked, ...visible.map(recipe => recipe.id)])])}>{query ? t("selectResults") : t("selectAll")}</Button><Button size="xs" variant="ghost" disabled={busy || !picked.length || !!pending} onClick={() => choose([])}>{t("clear")}</Button></div></div>
        {loadError ? <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-xs"><p>{t("loadFailed")}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>{t("retry")}</Button></div> : recipes === null ? <p role="status" className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("loading")}</p> : !visible.length ? <p className="py-12 text-center text-xs text-muted-foreground">{query ? t("noSearchResults") : t("noRecipes")}</p> : <div className="grid max-h-[28rem] grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-2 overflow-y-auto pr-1">{visible.map(recipe => {
          const checked = picked.includes(recipe.id);
          const latest = recipe.latest;
          return <div key={recipe.id} className={checked ? "relative overflow-hidden rounded-lg border border-primary bg-primary/5 transition-colors" : "relative overflow-hidden rounded-lg border border-border transition-colors hover:border-foreground/30"}>
            <button type="button" aria-pressed={checked} aria-label={`${recipe.name} ${t("select")}`} disabled={busy || !!pending} onClick={() => chooseRecipe(recipe)} className="flex w-full items-center gap-3 p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-60">
              <span className="relative flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">{latest?.url ? <Thumbnail src={latest.url} alt="" className="h-full w-full object-cover" /> : <span className="flex flex-col items-center gap-1 text-muted-foreground"><ImageOff className="size-5" /><span className="text-[10px]">{t("noLatest")}</span></span>}{checked ? <span className="absolute top-1 left-1 rounded-full bg-primary p-0.5 text-primary-foreground"><Check className="size-3" /></span> : null}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-1.5 pb-5"><span className="line-clamp-2 text-xs font-medium" title={recipe.name}>{recipe.name || t("untitled")}</span><span className="flex gap-1"><Badge variant="secondary">{t("rating", { rating: recipe.rating })}</Badge></span><span className="text-[10px] text-muted-foreground">{settingsOf(recipe)?.type === "settings" ? `${settingsOf(recipe)?.width}×${settingsOf(recipe)?.height} · ${settingsOf(recipe)?.steps}${t("steps")}` : t("missingSettings")}</span></span>
            </button>
            <a href={`#/recipe/${recipe.id}`} aria-label={`${recipe.name} ${t("edit")}`} className="absolute right-2 bottom-2 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground">{t("edit")} <ExternalLink className="size-3" /></a>
          </div>;
        })}</div>}
      </section>

      <section aria-label={t("settingsLabel")} className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 lg:sticky lg:top-6">
        <h2 className="text-sm font-semibold"><span className="mr-2 text-muted-foreground">02</span>{t("settings")}</h2>
        <GenerationCount value={count} onChange={value => { setCount(value); clearRunState(); }} disabled={busy || !!pending} label={t("countPerRecipe")} quickLabel={t("quickCount")} unit={t("images")} hint={t("countHint")} />
        <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 text-xs"><div className="flex items-baseline justify-between"><span className="text-muted-foreground">{t("total", { recipes: selectedCount, count })}</span><strong className="text-xl tabular-nums">{total}<span className="ml-1 text-xs font-normal">{t("images")}</span></strong></div><div className="flex justify-between gap-2 border-t border-border pt-2"><span className="text-muted-foreground">{t("estimatedCost")}</span><span className="font-medium">{!selectedCount || !allPlansReady ? "—" : estimated === null ? dryRun ? t("dryRunCost") : t("estimateUnknown") : estimated === 0 ? dryRun ? t("dryRunCost") : t("freeCost") : t("paidCost", { anlas: estimated.toLocaleString() })}</span></div></div>
        {selectedCount ? <ul className="max-h-28 space-y-1.5 overflow-y-auto text-xs text-muted-foreground">{selected.map(recipe => <li key={recipe.id} className="truncate" title={recipe.name}>· {recipe.name}</li>)}</ul> : <p className="text-xs text-muted-foreground">{t("selectRecipeHint")}</p>}
        {!dryRun && allPlansReady && estimated !== null && estimated > 0 ? <label className="flex items-start gap-2 text-xs leading-5"><Checkbox checked={paid} disabled={busy || !!pending || planning} onCheckedChange={value => setPaidForKey(value ? paidConsentKey : null)} className="mt-0.5" />{t("paidConfirm", { anlas: estimated.toLocaleString() })}</label> : null}
        {missingSettings ? <p className="text-xs text-amber-500">{t("missingSettings")}</p> : null}
        {plans.some(plan => plan.findings.length) ? <div className="space-y-1 rounded-lg border border-amber-500/30 p-3 text-xs text-amber-600">{plans.flatMap(plan => plan.findings.filter(finding => finding.severity === "error").map(finding => <p key={`${plan.id}-${finding.code}`}>{centralT(finding.messageKey, finding.params)}</p>))}</div> : null}
        {translatedError ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{translatedError}</div> : null}
        <Button size="lg" className="w-full" disabled={!canRun || !!pending} onClick={() => void run()}>{busy || planning ? <Loader2 className="animate-spin" /> : <Sparkles />}{busy ? t("preparing") : planning ? t("preparingSingle") : t(total === 1 ? "generateOneImage" : "generateImages", { count: total })}</Button>
        {busy && active ? <Button variant="outline" size="sm" disabled={stopping} onClick={requestStop}><Square />{stopping ? t("stopping") : t("stop")}</Button> : null}
        <p className="text-[11px] leading-5 text-muted-foreground">{t("countHint")}</p>
      </section>

      <section aria-label={t("results")} className="min-w-0 lg:col-span-2">
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold"><span className="mr-2 text-muted-foreground">03</span>{t("results")} {images.length ? <span className="ml-1 text-muted-foreground">{images.length}{t("images")}</span> : null}{jobs.length ? <span className="ml-1 text-muted-foreground">· {t("job")} {jobs.length}</span> : null}</h2><button type="button" onClick={onOpenGallery} className="text-xs text-muted-foreground hover:text-foreground">{t("viewGallery")}</button></div>
        {active ? <div className="mb-3 rounded-xl border border-border p-3 text-xs" role="status" aria-live="polite"><div className="mb-2 flex flex-wrap justify-between gap-2"><span>{resultStatus}</span><span className="text-muted-foreground">{rows.length}/{active.total}</span></div><Progress aria-label={t("active", { name: active.name, done: rows.length, total: active.total })} value={activeProgress} />{busy ? <p className="mt-2 text-muted-foreground">{stopping ? t("stopping") : t("keepOpen")}</p> : null}</div> : null}
        {rows.length ? <div className="mb-3 space-y-2">{rows.map(row => <div key={row.recipe_id} className="flex flex-wrap items-start gap-2 rounded-lg border border-border p-2 text-xs"><Badge variant={row.ok ? "secondary" : "destructive"}>{row.ok ? `${row.count}${t("images")}` : t("failed")}</Badge><a href={`#/recipe/${row.recipe_id}`} className="min-w-0 break-words hover:underline">{row.name}</a>{row.error ? <p className="w-full break-words text-destructive">{centralT(row.error)}</p> : null}</div>)}</div> : null}
        {images.length ? <GenerationResults client={client} items={images} onContinueFromGeneration={onContinueFromGeneration} /> : <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">{busy ? t("firstResult") : t("emptyResults")}</p>}
      </section>
    </div>
  </>;
}

function GenerationCount({ value, onChange, disabled, label, quickLabel, unit, hint }: { value: number; onChange: (value: number) => void; disabled?: boolean; label: string; quickLabel: string; unit: string; hint: string }) {
  const id = React.useId();
  return <div className="flex flex-col gap-2"><div className="flex items-center justify-between gap-3"><label htmlFor={id} className="text-xs font-medium">{label}</label><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Input id={id} type="number" min={1} max={8} step={1} value={value} disabled={disabled} className="h-8 w-16 text-center font-mono" onChange={event => onChange(Math.max(1, Math.min(8, Math.trunc(Number(event.target.value) || 1))))} /><span>{unit}</span></div></div><div className="grid grid-cols-4 gap-1.5" role="group" aria-label={`${label} ${quickLabel}`}>{[1, 2, 4, 8].map(item => <Button key={item} size="sm" variant={value === item ? "default" : "outline"} aria-pressed={value === item} disabled={disabled} onClick={() => onChange(item)}>{item}{unit}</Button>)}</div><p className="text-[11px] leading-5 text-muted-foreground">{hint}</p></div>;
}
