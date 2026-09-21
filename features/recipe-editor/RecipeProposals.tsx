import * as React from "react";
import { Check, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import type { Block, Character } from "@/lib/schema";
import type { RecipeProposal, RecipeProposalChange } from "@/contracts/proposals";
import type { StudioClient, StoredRecipe } from "@/contracts/studio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { BLOCK_LABEL_KEY } from "@/features/shared/types";
import { errorMessage, studioCall, subscribeToStudio } from "@/desktop/renderer/studio-client";
import { useTranslation } from "react-i18next";
import { useRecipeProposalsTranslation } from "./proposals-locale";

export type RecipeProposalsProps = {
  client?: StudioClient;
  recipeId: number;
  disabled?: boolean;
  onApplied?: (recipe: StoredRecipe) => void;
  onConflict?: (cause: unknown) => void;
  onBusyChange?: (busy: boolean) => void;
};

function displayValue(value: unknown, empty: string): string {
  if (value === null || value === undefined || value === "") return empty;
  if (Array.isArray(value)) return value.length ? value.map(item => String(item)).join(", ") : empty;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function changeLabel(change: RecipeProposalChange, translate: (key: string, options?: Record<string, unknown>) => string, central: (key: string, options?: Record<string, unknown>) => string) {
  if (change.scope === "metadata") {
    if (change.field === "name") return central("editor.name");
    if (change.field === "tags") return central("editor.tags");
    if (change.field === "notes") return central("editor.notes");
    if (change.field === "rating") return central("recipesExtra.rating");
    return translate("fields.source");
  }
  if (change.scope === "block") return translate("changeBlock", { name: central(BLOCK_LABEL_KEY[change.blockType]), index: change.index + 1 });
  return translate("allBlocks");
}

function describeBlock(block: Block, translate: (key: string, options?: Record<string, unknown>) => string, central: (key: string, options?: Record<string, unknown>) => string): string {
  const empty = translate("emptyValue");
  const value = (input: unknown) => displayValue(input, empty);
  const line = (key: string, input: unknown) => `${translate(`fields.${key}`)}: ${value(input)}`;
  const lines: string[] = [];
  if (block.preset_id !== undefined) lines.push(line("presetRef", `#${block.preset_id}`));

  if (block.type === "style") {
    lines.push(line("artists", block.artists.map(artist => `${artist.name} (${artist.weight})`)));
    lines.push(line("year", block.year));
    lines.push(line("quality", block.quality));
    lines.push(line("minus", block.minus));
  } else if (block.type === "cast") {
    lines.push(line("layout", central(`layout.${block.layout_preset}`, { defaultValue: block.layout_preset })));
    lines.push(line("members", block.members.length));
    lines.push(line("autoLeakGuard", translate(block.auto_leak_guard ? "enabled" : "disabled")));
    block.members.forEach((member, index) => {
      const snapshot = (member as typeof member & { character_snapshot?: Character }).character_snapshot;
      const identity = snapshot?.display_name || snapshot?.tag || `#${member.character_id}`;
      lines.push(`${translate("fields.character", { index: index + 1 })}: ${identity} · ${translate("fields.position")}: ${member.x.toFixed(2)}, ${member.y.toFixed(2)}`);
      if (snapshot) {
        lines.push(`${translate("fields.characterSnapshot")}:`);
        lines.push(`${central("characters.displayName")}: ${value(snapshot.display_name)}`);
        lines.push(`${central("characters.tag")}: ${value(snapshot.tag)}`);
        lines.push(`${central("characters.series")}: ${value(snapshot.series)}`);
        lines.push(`${central("characters.gender")}: ${value(snapshot.gender)}`);
        lines.push(`${central("characters.age")}: ${central(`characters.${snapshot.age_flag}`)}`);
        lines.push(`${central("characters.locked")}: ${translate(snapshot.locked ? "enabled" : "disabled")}`);
        lines.push(`${central("characters.fixedTraits")}: ${value(snapshot.fixed_traits)}`);
        lines.push(`${translate("fields.defaultPosition")}: ${snapshot.default_x.toFixed(2)}, ${snapshot.default_y.toFixed(2)}`);
        lines.push(`${central("characters.characterNotes")}: ${value(snapshot.notes)}`);
      }
      lines.push(line("traits", member.traits));
      lines.push(line("outfit", member.outfit));
      lines.push(line("expression", member.expression));
      lines.push(line("memberNegative", member.uc));
      lines.push(line("interactions", member.interactions));
    });
  } else if (block.type === "negative") {
    const rating = block.rating ?? 0;
    lines.push(line("basePreset", block.base_preset));
    lines.push(`${translate("fields.rating")}: ${central(`blocks.rating${rating}`, { defaultValue: String(rating) })}`);
    lines.push(line("extraNegative", block.extra));
  } else if (block.type === "settings") {
    lines.push(line("width", block.width));
    lines.push(line("height", block.height));
    lines.push(line("steps", block.steps));
    lines.push(line("scale", block.scale));
    lines.push(line("rescale", block.rescale));
    lines.push(line("sampler", block.sampler));
    lines.push(line("schedule", block.schedule));
    lines.push(line("seedPolicy", block.seed_policy));
    lines.push(line("seed", block.seed));
    lines.push(line("qualityPreset", block.quality_preset));
    lines.push(line("ucPreset", block.uc_preset));
  } else if (block.type === "nsfw") {
    lines.push(line("explicitTags", block.explicit_tags));
  } else if (block.type === "text") {
    lines.push(line("entries", block.entries.map(entry => `${translate(`fields.${entry.kind}`)}: ${entry.text}`)));
  } else {
    lines.push(line("tags", block.tags));
    lines.push(line("text", block.text));
  }
  return lines.join("\n");
}

function describeChangeValue(value: unknown, change: RecipeProposalChange, translate: (key: string, options?: Record<string, unknown>) => string, central: (key: string, options?: Record<string, unknown>) => string): string {
  if (change.scope === "block") return describeBlock(value as Block, translate, central);
  if (change.scope === "blocks") {
    const blocks = value as Block[];
    return blocks.length ? blocks.map((block, index) => `${translate("changeBlock", { name: central(BLOCK_LABEL_KEY[block.type]), index: index + 1 })}\n${describeBlock(block, translate, central)}`).join("\n\n") : translate("emptyValue");
  }
  if (change.field === "rating") {
    const rating = Number(value);
    return central(`blocks.rating${rating}`, { defaultValue: String(rating) });
  }
  return displayValue(value, translate("emptyValue"));
}

export function RecipeProposals({ client, recipeId, disabled = false, onApplied, onConflict, onBusyChange }: RecipeProposalsProps) {
  const { t: centralT } = useTranslation();
  const { t: proposalT } = useRecipeProposalsTranslation();
  const [proposals, setProposals] = React.useState<RecipeProposal[] | null>(null);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const sequence = React.useRef(0);
  const alive = React.useRef(true);
  const busyCallback = React.useRef(onBusyChange);
  busyCallback.current = onBusyChange;

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      busyCallback.current?.(false);
    };
  }, []);

  const load = React.useCallback(async () => {
    const request = ++sequence.current;
    if (!client) { setProposals([]); return; }
    setError(null);
    try {
      const result = await studioCall(client, "recipes.proposals.list", { recipeId });
      if (alive.current && request === sequence.current) setProposals(Array.isArray(result) ? result : []);
    } catch (cause) {
      if (alive.current && request === sequence.current) {
        setError(errorMessage(cause, "errors.load"));
        setProposals(current => current ?? []);
      }
    }
  }, [client, recipeId]);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => subscribeToStudio(client, event => {
    if (event.type === "proposal.changed" && event.recipeId === recipeId) void load();
  }), [client, load, recipeId]);

  const mutate = async (operation: "apply" | "undo", proposal: RecipeProposal, changeIds: string[]) => {
    if (!client || busy || disabled || !changeIds.length) return;
    setBusy(true);
    setError(null);
    busyCallback.current?.(true);
    try {
      const result = await studioCall(client, `recipes.proposals.${operation}`, {
        proposalId: proposal.id,
        changeIds,
        expectedVersion: proposal.applicationVersion,
      });
      if (!alive.current) return;
      onApplied?.(result.recipe);
      setSelection(current => {
        const next = new Set(current);
        for (const id of changeIds) next.delete(id);
        return next;
      });
      await load();
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause, "errors.save"));
      if (errorMessage(cause).includes("VERSION_CONFLICT")) onConflict?.(cause);
    } finally {
      busyCallback.current?.(false);
      if (alive.current) setBusy(false);
    }
  };

  const errorLabel = error?.startsWith("errors.") ? centralT(error) : error ? proposalT("loadError") : null;
  return <section className="flex flex-col gap-3" aria-labelledby="recipe-proposals-title">
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1"><h2 id="recipe-proposals-title" className="text-sm font-semibold">{proposalT("title")}</h2><p className="mt-1 text-xs text-muted-foreground">{proposalT("description")}</p></div>
      <Button size="icon-xs" variant="ghost" onClick={() => void load()} disabled={busy} title={proposalT("refresh")} aria-label={proposalT("refresh")}>
        {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      </Button>
    </div>
    {disabled ? <p role="status" className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">{proposalT("dirtyNotice")}</p> : null}
    {errorLabel ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errorLabel}</p> : null}
    {proposals === null ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{proposalT("loading")}</div> : proposals.length === 0 ? <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{proposalT("empty")}</p> : <div className="flex flex-col gap-3">{proposals.map(proposal => {
      const selected = proposal.changes.filter(change => selection.has(change.id));
      const applyIds = selected.filter(change => change.state !== "applied").map(change => change.id);
      const undoIds = selected.filter(change => change.state === "applied").map(change => change.id);
      const canApply = proposal.status !== "expired" && Date.parse(proposal.expiresAt) > Date.now();
      return <Card key={proposal.id} size="sm">
        <CardHeader className="gap-2 border-b border-border pb-3">
          <div className="flex items-start gap-2">
            <CardTitle className="min-w-0 flex-1 text-sm">{proposal.reason}</CardTitle>
            <Badge variant={proposal.status === "expired" ? "outline" : proposal.status === "applied" ? "secondary" : "outline"}>{proposalT(`statuses.${proposal.status}`)}</Badge>
          </div>
          <CardDescription className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>{proposalT("baseVersion", { version: proposal.baseVersion })}</span>
            <span>{proposalT("applicationVersion", { version: proposal.applicationVersion })}</span>
            {proposal.connectionName ? <span>{proposal.connectionName}</span> : null}
            <span>{proposalT("expiresAt", { date: new Date(proposal.expiresAt).toLocaleString() })}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-3">
          {proposal.changes.map(change => {
            const label = changeLabel(change, proposalT, centralT);
            return <div key={change.id} className="rounded-lg border border-border p-2">
              <div className="flex items-start gap-2">
                <Checkbox aria-label={proposalT("selectChange", { name: label })} checked={selection.has(change.id)} onCheckedChange={checked => setSelection(current => {
                  const next = new Set(current);
                  if (checked === true) next.add(change.id); else next.delete(change.id);
                  return next;
                })} disabled={busy} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-medium">{label}<Badge variant="outline" className="h-4 px-1 text-[10px]">{proposalT(`changeState.${change.state}`)}</Badge></div>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="min-w-0 rounded bg-muted/40 p-2"><span className="mb-1 block text-[10px] text-muted-foreground">{proposalT("before")}</span><span className="block max-h-40 overflow-y-auto font-mono text-[11px] leading-4 whitespace-pre-wrap break-words">{describeChangeValue(change.before, change, proposalT, centralT)}</span></div>
                    <div className="min-w-0 rounded bg-muted/40 p-2"><span className="mb-1 block text-[10px] text-muted-foreground">{proposalT("after")}</span><span className="block max-h-40 overflow-y-auto font-mono text-[11px] leading-4 whitespace-pre-wrap break-words">{describeChangeValue(change.after, change, proposalT, centralT)}</span></div>
                  </div>
                </div>
              </div>
            </div>;
          })}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2 border-t border-border py-3">
          <Button size="sm" variant="outline" disabled={disabled || busy || !undoIds.length} onClick={() => void mutate("undo", proposal, undoIds)}><RotateCcw />{proposalT("undoSelected")}</Button>
          <Button size="sm" disabled={disabled || busy || !canApply || !applyIds.length} onClick={() => void mutate("apply", proposal, applyIds)}><Check />{proposalT("applySelected")}</Button>
        </CardFooter>
      </Card>;
    })}</div>}
  </section>;
}

export default RecipeProposals;
