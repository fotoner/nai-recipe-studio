import * as React from "react";
import { Check, Coins, Loader2, Sparkles, Square, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StudioClient, GenerationJob, GenerationPlan, GalleryItem as StoredGalleryItem } from "@/contracts/studio";
import type { Recipe } from "@/features/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { errorMessage, studioCall } from "@/desktop/renderer/studio-client";
import { GenerationResults } from "./GenerationResults";
import { useGenerationTranslation } from "./locale";
import type { GenerationDraftFromImage } from "@/core/recipe/from-generation";

export type RecipeGenerationState = { recipe: Recipe; busy: boolean; count: number; items: StoredGalleryItem[]; error: string; job?: GenerationJob | null };
export type RecipeGenerateDialogProps = {
  client?: StudioClient;
  recipe: Recipe;
  blocked?: boolean | string;
  label?: string;
  autoOpen?: boolean;
  hideTrigger?: boolean;
  onDone?: () => void;
  onStateChange?: (state: RecipeGenerationState) => void;
  onContinueFromGeneration?: (draft: GenerationDraftFromImage) => void;
};

function isActiveJob(job: GenerationJob | null | undefined) { return !!job && (job.state === "queued" || job.state === "running"); }
function isTerminalJob(job: GenerationJob) { return !isActiveJob(job); }
function settingsOf(recipe: Recipe) { return recipe.blocks.find(block => block.type === "settings"); }
function requestId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }

export function RecipeGenerateDialog({ client, recipe, blocked, label, autoOpen, hideTrigger, onDone, onStateChange, onContinueFromGeneration }: RecipeGenerateDialogProps) {
  const { t } = useGenerationTranslation();
  const { t: centralT } = useTranslation();
  const [open, setOpen] = React.useState(Boolean(autoOpen));
  const [count, setCount] = React.useState(1);
  const [paidFor, setPaidFor] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<GenerationPlan | null>(null);
  const [preparedKey, setPreparedKey] = React.useState("");
  const [preparing, setPreparing] = React.useState(false);
  const [dryRun, setDryRun] = React.useState(false);
  const [planRevision, setPlanRevision] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [job, setJob] = React.useState<GenerationJob | null>(null);
  const [error, setError] = React.useState("");
  const [items, setItems] = React.useState<StoredGalleryItem[]>([]);
  const prepareSequence = React.useRef(0);
  const busyRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const currentJobRef = React.useRef<GenerationJob | null>(null);
  const runRef = React.useRef<{ recipe: Recipe; count: number; planId: string; jobId?: string } | null>(null);
  const handledJobsRef = React.useRef(new Set<string>());
  const preservePrepareErrorRef = React.useRef(false);
  const stateCallbackRef = React.useRef(onStateChange);
  const doneCallbackRef = React.useRef(onDone);
  stateCallbackRef.current = onStateChange;
  doneCallbackRef.current = onDone;

  const recipeJson = React.useMemo(() => JSON.stringify(recipe), [recipe]);
  const inputKey = JSON.stringify({ recipe: recipeJson, count });
  const planReady = Boolean(plan && preparedKey === inputKey);
  const estimatedAnlas = planReady ? plan?.estimatedAnlas ?? null : null;
  const requiresPaidConsent = estimatedAnlas !== null && estimatedAnlas > 0;
  const consentKey = planReady ? JSON.stringify({ recipe: recipeJson, count, planId: plan?.id, estimatedAnlas }) : "";
  const paid = Boolean(consentKey && paidFor === consentKey);
  const findings = planReady ? plan?.findings ?? [] : [];
  const hasErrors = findings.some(finding => finding.severity === "error");
  const hasSettings = Boolean(settingsOf(recipe));
  const canStart = Boolean(client && planReady && !preparing && !busy && !blocked && hasSettings && !hasErrors && estimatedAnlas !== null && (!requiresPaidConsent || paid));

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    if (!client) return;
    let active = true;
    void studioCall(client, "status.read", {}).then(status => { if (active) setDryRun(status.dryRun); }).catch(() => undefined);
    return () => { active = false; };
  }, [client]);

  React.useEffect(() => {
    if (!open) return;
    const sequence = ++prepareSequence.current;
    let current = true;
    setPlan(null);
    setPreparedKey("");
    setPaidFor(null);
    if (preservePrepareErrorRef.current) preservePrepareErrorRef.current = false;
    else setError("");
    if (blocked || !hasSettings) {
      setPreparing(false);
      setError(blocked ? (typeof blocked === "string" ? blocked : "generationView.blockedDescription") : "generationView.missingSettings");
      return () => { current = false; };
    }
    if (!client) {
      setPreparing(false);
      setError("generationView.planFailed");
      return () => { current = false; };
    }
    setPreparing(true);
    void studioCall(client, "generation.prepare", { recipe: JSON.parse(recipeJson) as Recipe, count })
      .then(next => {
        if (!current || sequence !== prepareSequence.current) return;
        setPlan(next);
        setPreparedKey(inputKey);
      })
      .catch(cause => {
        if (current && sequence === prepareSequence.current) setError(errorMessage(cause, "generationView.planFailed"));
      })
      .finally(() => { if (current && sequence === prepareSequence.current) setPreparing(false); });
    return () => { current = false; };
  }, [blocked, client, count, hasSettings, inputKey, open, planRevision, recipeJson]);

  const updateJob = React.useCallback((next: GenerationJob) => {
    currentJobRef.current = next;
    if (mountedRef.current) setJob(next);
  }, []);

  const publish = React.useCallback((state: RecipeGenerationState) => { stateCallbackRef.current?.(state); }, []);

  const handleTerminalJob = React.useCallback(async (finished: GenerationJob) => {
    if (handledJobsRef.current.has(finished.id)) return;
    const run = runRef.current;
    if (!run || run.jobId !== finished.id) return;
    handledJobsRef.current.add(finished.id);
    const resultRows = await Promise.allSettled(finished.generationIds.map(id => client ? studioCall(client, "gallery.get", { id }) : Promise.reject(new Error("STUDIO_CLIENT_UNAVAILABLE"))));
    const completedItems = resultRows.flatMap(result => result.status === "fulfilled" ? [result.value] : []) as StoredGalleryItem[];
    const uniqueItems = completedItems.filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    let resultError = finished.error?.messageKey ?? "";
    if (!resultError && finished.state === "failed") resultError = "generationView.jobFailed";
    if (!resultError && finished.state === "interrupted") resultError = "generationView.jobInterrupted";
    if (!resultError && finished.state === "cancelled") resultError = "generationView.jobCancelled";
    if (mountedRef.current) {
      setItems(uniqueItems);
      setError(resultError);
      setBusy(false);
      setCancelling(false);
      setPlan(null);
      setPreparedKey("");
      setPaidFor(null);
      preservePrepareErrorRef.current = !stateCallbackRef.current && Boolean(resultError);
      setPlanRevision(value => value + 1);
    }
    busyRef.current = false;
    publish({ recipe: run.recipe, busy: false, count: run.count, items: uniqueItems, error: resultError, job: finished });
    await doneCallbackRef.current?.();
  }, [client, publish]);

  React.useEffect(() => {
    if (!job || !isTerminalJob(job)) return;
    void handleTerminalJob(job);
  }, [handleTerminalJob, job]);

  React.useEffect(() => {
    if (!client || !job || !isActiveJob(job)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void studioCall(client, "generation.status", { id: job.id }).then(next => {
        if (active) updateJob(next);
      }).catch(() => undefined);
    }, 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, job, updateJob]);

  React.useEffect(() => {
    if (!client) return;
    return client.subscribe(event => {
      if (event.type === "job.changed" && event.job.id === currentJobRef.current?.id) updateJob(event.job);
    });
  }, [client, updateJob]);

  React.useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const run = async () => {
    if (!client || !canStart || !plan || busyRef.current) return;
    busyRef.current = true;
    handledJobsRef.current.clear();
    const snapshot = JSON.parse(recipeJson) as Recipe;
    const runCount = count;
    runRef.current = { recipe: snapshot, count: runCount, planId: plan.id };
    setBusy(true);
    setCancelling(false);
    setError("");
    setItems([]);
    setPaidFor(null);
    if (stateCallbackRef.current) {
      setOpen(false);
      publish({ recipe: snapshot, busy: true, count: runCount, items: [], error: "", job: null });
    }
    try {
      const allowPaid = plan.estimatedAnlas !== null && plan.estimatedAnlas > 0 && paid;
      const approved = plan.approved ? plan : await studioCall(client, "generation.approve", { planId: plan.id, ...(allowPaid ? { allowPaid: true } : {}) });
      const started = await studioCall(client, "generation.start", { planId: approved.id, requestId: requestId() });
      runRef.current.jobId = started.id;
      updateJob(started);
    } catch (cause) {
      const message = errorMessage(cause, "errors.generation");
      busyRef.current = false;
      if (mountedRef.current) { setBusy(false); setError(message); setJob(null); setPlan(null); setPreparedKey(""); preservePrepareErrorRef.current = true; setPlanRevision(value => value + 1); }
      publish({ recipe: snapshot, busy: false, count: runCount, items: [], error: message, job: null });
    }
  };

  const cancel = async () => {
    const current = currentJobRef.current;
    if (!client || !current || !isActiveJob(current) || cancelling) return;
    setCancelling(true);
    try { updateJob(await studioCall(client, "generation.cancel", { id: current.id })); }
    catch (cause) { if (mountedRef.current) { setCancelling(false); setError(errorMessage(cause, "errors.generation")); } }
  };

  const openDialog = () => {
    if (blocked) {
      toast.add({ title: t("blockedTitle"), description: typeof blocked === "string" ? blocked : t("blockedDescription"), type: "warning" });
      return;
    }
    if (busyRef.current) return;
    setError("");
    setPaidFor(null);
    setOpen(true);
  };
  const settings = settingsOf(recipe);
  const perImage = estimatedAnlas !== null && plan?.count ? Math.round(estimatedAnlas / plan.count) : null;
  const errorText = error.startsWith("errors.") ? centralT(error) : error.startsWith("generationView.") ? t(error.replace(/^generationView\./, "")) : error;
  const busyLabel = job?.state === "queued" ? t("jobQueued") : t("jobRunning");

  return <>
    {hideTrigger ? null : <div className="flex items-center gap-1.5">
      <Button size="sm" disabled={busy} onClick={openDialog}>{busy ? <Loader2 className="animate-spin" /> : <Sparkles />}{busy ? t("jobRunning") : label ?? t("dialogTrigger")}</Button>
      {busy && stateCallbackRef.current ? <Button type="button" size="sm" variant="outline" disabled={cancelling || !isActiveJob(job)} onClick={() => void cancel()}>{cancelling ? <Loader2 className="animate-spin" /> : <Square />}{cancelling ? t("cancellingGeneration") : t("cancelGeneration")}</Button> : null}
    </div>}
    <Dialog open={open} onOpenChange={next => { if (!busyRef.current) setOpen(next); }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { name: recipe.name })}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <GenerationCount value={count} onChange={next => { setCount(next); setError(""); }} disabled={busy} label={t("countPerRun")} />

          <div className="rounded-lg border border-border p-2 text-xs">
            <div className="flex items-center gap-1 text-muted-foreground"><Coins className="size-3.5" />{t("estimatedCost")}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {preparing ? <span role="status" className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("preparingSingle")}</span>
                : !planReady ? <span className="text-destructive">{t("unknownCost")}</span>
                  : estimatedAnlas === null ? <span className="text-destructive">{t("unknownCost")}</span>
                    : estimatedAnlas === 0 ? <Badge variant="secondary">{dryRun ? t("dryRunCost") : t("freeCost")}</Badge>
                      : <><span className="font-mono">{t("paidEstimate", { anlas: estimatedAnlas.toLocaleString() })}</span><span className="font-mono text-muted-foreground">{t("perImageEstimate", { anlas: perImage?.toLocaleString() ?? "—" })}</span></>}
            </div>
            {settings?.type === "settings" ? <p className="mt-1 text-[11px] text-muted-foreground">{t("settingsPreview", { settings: `${settings.width}×${settings.height} · ${settings.steps}${t("steps")}` })}</p> : null}
            {planReady && plan?.seeds.length ? <p className="mt-1 text-[11px] text-muted-foreground">{t("seedsPreview", { seeds: plan.seeds.join(", ") })}</p> : null}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("countHint")}</p>
          {requiresPaidConsent ? <label className="flex items-start gap-2 text-xs leading-5"><Checkbox checked={paid} disabled={busy || !planReady} onCheckedChange={value => setPaidFor(value ? consentKey : null)} className="mt-0.5" />{t("paidConfirm", { anlas: estimatedAnlas?.toLocaleString() ?? "—" })}</label> : null}
          {blocked || !hasSettings ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>{t("blockedTitle")}</AlertTitle><AlertDescription>{blocked ? typeof blocked === "string" ? blocked : t("blockedDescription") : t("missingSettings")}</AlertDescription></Alert> : null}
          {findings.length ? <div className="space-y-1 rounded-lg border border-amber-500/30 p-3 text-xs">{findings.map(finding => <p key={`${finding.code}-${finding.block ?? ""}`} className={finding.severity === "error" ? "text-destructive" : "text-muted-foreground"}>{centralT(finding.messageKey, finding.params)}</p>)}</div> : null}
          {errorText ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>{t("jobFailed")}</AlertTitle><AlertDescription>{errorText}</AlertDescription></Alert> : null}
          {busy ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{busyLabel}{job ? ` · ${job.completed}/${job.total}` : null}</p> : null}
          {items.length ? <GenerationResults client={client} items={items} large onContinueFromGeneration={onContinueFromGeneration} /> : null}
        </div>

        <DialogFooter>
          {busy ? <Button size="sm" variant="outline" disabled={cancelling || !isActiveJob(job)} onClick={() => void cancel()}>{cancelling ? <Loader2 className="animate-spin" /> : <Square />}{cancelling ? t("cancellingGeneration") : t("cancelGeneration")}</Button>
            : <Button size="sm" disabled={!canStart} onClick={() => void run()}>{preparing ? <Loader2 className="animate-spin" /> : <Check />}{preparing ? t("preparingSingle") : t(count === 1 ? "generateOneImage" : "generateImages", { count })}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function GenerationCount({ value, onChange, disabled, label }: { value: number; onChange: (value: number) => void; disabled?: boolean; label: string }) {
  const { t } = useGenerationTranslation();
  const id = React.useId();
  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-xs font-medium">{label}</label>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Input id={id} type="number" min={1} max={8} step={1} value={value} disabled={disabled} className="h-8 w-16 text-center font-mono" onChange={event => onChange(Math.max(1, Math.min(8, Math.trunc(Number(event.target.value) || 1))))} />
        <span>{t("images")}</span>
      </div>
    </div>
    <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={`${label} ${t("quickCount")}`}>{[1, 2, 4, 8].map(item => <Button key={item} size="sm" variant={value === item ? "default" : "outline"} aria-pressed={value === item} disabled={disabled} onClick={() => onChange(item)}>{item}{t("images")}</Button>)}</div>
  </div>;
}
