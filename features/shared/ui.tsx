import * as React from "react";
import { ArrowLeft, ChevronDown, CircleAlert, CircleCheck, CircleHelp, Info, LoaderCircle, MoreHorizontal, Plus, Search, TriangleAlert, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { BLOCK_LABEL_KEY, type BlockType, type LintFinding } from "./types";
import { useTranslation } from "react-i18next";

export const cx = cn;
export const ButtonBase = Button;
export const InputBase = Input;
export const TextareaBase = Textarea;

export function PageHeader({ title, description, children, onBack }: { eyebrow?: string; title: string; description?: string; children?: React.ReactNode; onBack?: () => void }) {
  const { t } = useTranslation();
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
    <div className="flex min-w-0 items-center gap-2">
      {onBack ? <Button variant="ghost" size="icon-sm" aria-label={t("common.back")} onClick={onBack}><ArrowLeft /></Button> : null}
      <div className="min-w-0"><h1 className="text-base font-semibold tracking-tight">{title}</h1>{description ? <p className="truncate text-xs text-muted-foreground">{description}</p> : null}</div>
    </div>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </div>;
}

export function SectionCard({ title, description, action, children, className }: { title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-xl border border-border bg-card p-3", className)}>
    {title || action ? <div className="mb-3 flex items-start justify-between gap-2"><div>{title ? <h2 className="text-sm font-medium">{title}</h2> : null}{description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}</div>{action}</div> : null}
    {children}
  </section>;
}

export function EmptyState({ title, description, action }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground"><h2 className="text-sm">{title}</h2>{description ? <p className="mt-1 text-xs">{description}</p> : null}{action ? <div className="mt-3 flex justify-center">{action}</div> : null}</div>;
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{label ?? t("common.loading")}</div>;
}

export function InlineNotice({ kind = "info", children }: { kind?: "info" | "warning" | "error" | "success"; children: React.ReactNode }) {
  return <div className={cn("flex items-start gap-2 rounded-lg border border-border p-3 text-xs [&>svg]:size-4 [&>svg]:shrink-0", kind === "error" ? "border-destructive/40 text-destructive" : "text-muted-foreground")} role={kind === "error" ? "alert" : "status"}>{kind === "error" ? <CircleAlert /> : kind === "success" ? <CircleCheck /> : <CircleHelp />}{children}</div>;
}

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <label className={cn("flex flex-col gap-1", className)}><span className="text-[11px] text-muted-foreground">{label}{hint ? <span className="ml-1 font-normal opacity-70">{hint}</span> : null}</span>{children}</label>;
}

/** Original Studio comma-separated field; commit on blur so typing keeps its caret. */
export function TagInput({ value, onChange, placeholder, ariaLabel, className }: { value: string[]; onChange: (value: string[]) => void; placeholder?: string; ariaLabel?: string; className?: string }) {
  const joined = value.join(", ");
  const commit = (text: string) => {
    const next = text.split(",").map(tag => tag.trim()).filter(Boolean);
    if (next.join(", ") !== joined) onChange(next);
  };
  return <Input key={joined} className={cn("h-8 font-mono text-xs", className)} defaultValue={joined} aria-label={ariaLabel} placeholder={placeholder} onBlur={event => commit(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />;
}

export function BlockLabel({ type }: { type: BlockType }) { const { t } = useTranslation(); return <>{t(BLOCK_LABEL_KEY[type])}</>; }

const LINT_ORDER: LintFinding["severity"][] = ["error", "warn", "info"];
const LINT_META = {
  error: { label: "editor.severityError", icon: CircleAlert, className: "text-destructive" },
  warn: { label: "editor.severityWarn", icon: TriangleAlert, className: "text-amber-500" },
  info: { label: "editor.severityInfo", icon: Info, className: "text-muted-foreground" },
} as const;

export function FindingList({ findings, onFix, onFixAll, busy, compact }: { findings: LintFinding[]; onFix?: (finding: LintFinding) => void; onFixAll?: () => void; busy?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const fixable = findings.filter((finding) => finding.fixable).length;
  const counts = LINT_ORDER.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length] as const);
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      {counts.map(([severity, count]) => {
        const meta = LINT_META[severity];
        const Icon = meta.icon;
        return <Badge key={severity} variant={severity === "error" && count > 0 ? "destructive" : "outline"} className="gap-1"><Icon className={meta.className} />{t(meta.label)} {count}</Badge>;
      })}
      {onFixAll ? <Button size="xs" variant="outline" className="ml-auto" disabled={!fixable || busy} onClick={onFixAll}>{busy ? <LoaderCircle className="animate-spin" /> : <Wand2 />}{t("editor.fixAll")} {fixable ? `(${fixable})` : ""}</Button> : null}
    </div>
    {findings.length === 0 ? <p className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground"><CircleCheck className="size-4 text-emerald-500" />{t("editor.noFindings")}</p> : <div className={compact ? "flex flex-col gap-1" : "flex max-h-[60vh] flex-col gap-1 overflow-y-auto"}>
      {LINT_ORDER.flatMap((severity) => findings.filter((finding) => finding.severity === severity)).map((finding, index) => <div className="flex items-start gap-2 rounded-lg border border-border px-2 py-1.5" key={`${finding.code}-${index}`}>
        {(() => { const Icon = LINT_META[finding.severity].icon; return <Icon className={`mt-0.5 size-3.5 shrink-0 ${LINT_META[finding.severity].className}`} />; })()}
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><span className="font-mono text-[11px] font-medium">{finding.code}</span>{finding.block && Object.hasOwn(BLOCK_LABEL_KEY, finding.block) ? <Badge variant="outline" className="h-4 text-[10px]">{t(BLOCK_LABEL_KEY[finding.block as BlockType])}</Badge> : null}{finding.fixable ? <Badge variant="secondary" className="h-4 text-[10px]">{t("editor.autoFix")}</Badge> : null}</div><p className="text-xs leading-5 break-words">{t(finding.messageKey, finding.params)}</p></div>
        {finding.fixable && onFix ? <Button size="xs" variant="outline" onClick={() => onFix(finding)}>{t("editor.fix")}</Button> : null}
      </div>)}
    </div>}
  </div>;
}

export function CollapseButton({ open, onClick, children }: { open: boolean; onClick: () => void; children: React.ReactNode }) { return <button className="flex items-center gap-2 text-xs" type="button" aria-expanded={open} onClick={onClick}><ChevronDown className={cn("size-4", open && "rotate-180")} />{children}</button>; }
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) { return <div className="relative"><Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" /><Input className="h-8 pl-7 text-xs" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></div>; }
export function IconAction({ label, children, onClick }: { label: string; children: React.ReactNode; onClick: () => void }) { return <Button size="icon-xs" variant="ghost" aria-label={label} title={label} onClick={onClick}>{children}</Button>; }
export { Badge, Button, Card, Input, Textarea, MoreHorizontal, Plus };
