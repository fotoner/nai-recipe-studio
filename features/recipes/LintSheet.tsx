"use client";

import * as React from "react";
import { CircleAlert, CircleCheck, Info, Loader2, RefreshCw, TriangleAlert, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Finding } from "@/contracts/studio";
import { useRecipeLintTranslation } from "./locale";
import { BLOCK_LABEL_KEY, type BlockType, type Recipe } from "@/features/shared/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export type RecipeLintRow = { recipe: Recipe & { id: number }; findings: Finding[] };
export type RecipeLintFixItem = { recipe_id: number; rules: string[] };

const ORDER: Finding["severity"][] = ["error", "warn", "info"];
const META: Record<Finding["severity"], { icon: typeof Info; cls: string }> = {
  error: { icon: CircleAlert, cls: "text-destructive" },
  warn: { icon: TriangleAlert, cls: "text-amber-500" },
  info: { icon: Info, cls: "text-muted-foreground" },
};

/** One row per (recipe, rule): the same rule can fire several times, but a fix is applied per rule. */
type Item = { key: string; recipe_id: number; rule: string; severity: Finding["severity"]; fixable: boolean; messages: Array<Pick<Finding, "messageKey" | "params">>; block?: string };

function itemsOf(row: RecipeLintRow): Item[] {
  const by = new Map<string, Item>();
  for (const finding of ORDER.flatMap(severity => row.findings.filter(item => item.severity === severity))) {
    const key = `${row.recipe.id}:${finding.code}`;
    const current = by.get(key);
    if (current) current.messages.push(finding);
    else by.set(key, { key, recipe_id: row.recipe.id, rule: finding.code, severity: finding.severity, fixable: finding.fixable, messages: [finding], block: finding.block });
  }
  return [...by.values()];
}

function blockLabel(block: string | undefined, t: (key: string) => string) {
  if (!block || !Object.hasOwn(BLOCK_LABEL_KEY, block)) return "";
  return t(BLOCK_LABEL_KEY[block as BlockType]);
}

export function LintSheet({ open, onOpenChange, rows, busy, onRerun, onFix }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: RecipeLintRow[] | null;
  busy: boolean;
  onRerun: () => void;
  onFix: (items: RecipeLintFixItem[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { t: lintT } = useRecipeLintTranslation();
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [hidePass, setHidePass] = React.useState(true);
  const [fixing, setFixing] = React.useState(false);

  const groups = React.useMemo(() => (rows ?? []).map(row => ({ row, items: itemsOf(row) })), [rows]);
  const fixableKeys = React.useMemo(() => groups.flatMap(group => group.items.filter(item => item.fixable).map(item => item.key)), [groups]);
  // selections that vanished after a re-run or a fix are simply ignored: everything below reads through `groups`

  const totals = groups.reduce((acc, group) => {
    for (const finding of group.row.findings) acc[finding.severity]++;
    return acc;
  }, { error: 0, warn: 0, info: 0 } as Record<Finding["severity"], number>);
  const visible = hidePass ? groups.filter(group => group.items.length > 0) : groups;
  const selectedItems = groups.flatMap(group => group.items.filter(item => selection.has(item.key)));
  const selectedRecipes = new Set(selectedItems.map(item => item.recipe_id)).size;

  const toggle = (keys: string[], checked: boolean) => setSelection(current => {
    const next = new Set(current);
    for (const key of keys) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    return next;
  });
  const selectErrors = () => setSelection(new Set(groups.flatMap(group => group.items.filter(item => item.fixable && item.severity === "error").map(item => item.key))));

  const fix = async () => {
    const byRecipe = new Map<number, string[]>();
    for (const item of selectedItems) byRecipe.set(item.recipe_id, [...(byRecipe.get(item.recipe_id) ?? []), item.rule]);
    if (!byRecipe.size) return;
    setFixing(true);
    try { await onFix([...byRecipe].map(([recipe_id, rules]) => ({ recipe_id, rules }))); }
    finally { setFixing(false); }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            {lintT("title")}
            <Badge variant={totals.error ? "destructive" : "outline"}>{lintT("errorCount", { count: totals.error })}</Badge>
            <Badge variant="outline">{lintT("warnCount", { count: totals.warn })}</Badge>
            <Badge variant="outline">{lintT("infoCount", { count: totals.info })}</Badge>
          </SheetTitle>
          <SheetDescription>{lintT("description")}</SheetDescription>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Button size="xs" variant="outline" onClick={() => setSelection(new Set(fixableKeys))} disabled={!fixableKeys.length}>{lintT("selectAll", { count: fixableKeys.length })}</Button>
            <Button size="xs" variant="outline" onClick={selectErrors}>{lintT("errorsOnly")}</Button>
            <Button size="xs" variant="ghost" onClick={() => setSelection(new Set())} disabled={!selectedItems.length}>{lintT("clearSelection")}</Button>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch checked={hidePass} onCheckedChange={setHidePass} /> {lintT(hidePass ? "hidePassed" : "showPassed")}
            </label>
            <Button size="icon-xs" variant="ghost" onClick={onRerun} disabled={busy} title={lintT("rerun")} aria-label={lintT("rerun")}>{busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}</Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-3">
          {rows === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {lintT("checking")}</div>
          ) : visible.length === 0 ? (
            <p className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              <CircleCheck className="size-4 text-emerald-500" /> {lintT("allPassed")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {visible.map(({ row, items }) => {
                const fixable = items.filter(item => item.fixable).map(item => item.key);
                const selected = fixable.filter(key => selection.has(key)).length;
                const errors = row.findings.filter(finding => finding.severity === "error").length;
                const warnings = row.findings.filter(finding => finding.severity === "warn").length;
                return (
                  <div key={row.recipe.id} className="rounded-xl border border-border">
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      <Checkbox checked={fixable.length > 0 && selected === fixable.length} indeterminate={selected > 0 && selected < fixable.length} disabled={!fixable.length}
                        onCheckedChange={checked => toggle(fixable, checked === true)} aria-label={lintT("selectFixable", { name: row.recipe.name })} />
                      <a href={`#/recipe/${row.recipe.id}`} className="min-w-0 truncate text-sm font-medium hover:underline" aria-label={lintT("recipeLink", { name: row.recipe.name })}>{row.recipe.name}</a>
                      <span className="ml-auto flex shrink-0 gap-1">
                        {errors ? <Badge variant="destructive" className="h-4 px-1 text-[10px]">{lintT("errorCount", { count: errors })}</Badge> : null}
                        {warnings ? <Badge variant="outline" className="h-4 px-1 text-[10px]">{lintT("warnCount", { count: warnings })}</Badge> : null}
                        {!items.length ? <Badge variant="secondary" className="h-4 px-1 text-[10px]">{t("common.ready")}</Badge> : null}
                      </span>
                    </div>
                    {items.length ? (
                      <div className="flex flex-col gap-1 border-t border-border p-2">
                        {items.map(item => {
                          const meta = META[item.severity];
                          const ruleTitle = lintT(`ruleTitle_${item.rule}`, { defaultValue: "" });
                          return (
                            <label key={item.key} className={cn("flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-muted/60", !item.fixable && "cursor-default")}>
                              <Checkbox className="mt-0.5" checked={selection.has(item.key)} disabled={!item.fixable} onCheckedChange={checked => toggle([item.key], checked === true)} />
                              <meta.icon className={cn("mt-0.5 size-3.5 shrink-0", meta.cls)} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono text-[11px] font-medium">{item.rule}</span>
                                  {ruleTitle ? <span className="text-[11px] text-muted-foreground">{ruleTitle}</span> : null}
                                  {item.block ? <Badge variant="outline" className="h-4 text-[10px]">{blockLabel(item.block, t)}</Badge> : null}
                                  {item.fixable ? null : <Badge variant="outline" className="h-4 text-[10px] text-muted-foreground">{lintT("manual")}</Badge>}
                                  {item.messages.length > 1 ? <span className="text-[10px] text-muted-foreground">{lintT("duplicateCount", { count: item.messages.length })}</span> : null}
                                </div>
                                <p className="text-xs leading-5 break-words">{item.messages.map(message => t(message.messageKey, message.params)).join(" · ")}</p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border p-3">
          <span className="text-xs text-muted-foreground">{lintT("selectedSummary", { count: selectedItems.length, recipes: selectedRecipes })}</span>
          <Button size="sm" className="ml-auto" disabled={!selectedItems.length || fixing || busy} onClick={() => void fix()}>
            {fixing ? <Loader2 className="animate-spin" /> : <Wand2 />} {lintT("applySelected")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default LintSheet;
