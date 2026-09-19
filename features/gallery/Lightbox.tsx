"use client";

import * as React from "react";
import { useGalleryTranslation } from "./locale";
import { Heart, Star } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft, ChevronRight, ClipboardCopy, Copy, Download, Eye, EyeOff, Loader2, Notebook, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
async function copyText(value: string) { try { await navigator.clipboard.writeText(value); return true; } catch { return false; } }
import type { GalleryItem } from "./types";

/** Copy a same-origin PNG to the clipboard. Chrome and Safari both want image/png; Safari also wants the blob as a promise inside the gesture. */
async function copyImage(url: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("CLIPBOARD_UNAVAILABLE");
  const blobP = fetch(url, { cache: "force-cache" }).then(async r => {
    if (!r.ok) throw new Error("IMAGE_UNAVAILABLE");
    const b = await r.blob();
    return b.type === "image/png" ? b : new Blob([await b.arrayBuffer()], { type: "image/png" });
  });
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]);
  } catch {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": await blobP })]);
  }
}

export function Lightbox({ items, index, blur, onClose, onIndex, onDelete, onExport, onRate, onOpenRecipe }: {
  items: GalleryItem[];
  onExport: (item: GalleryItem, includeMetadata: boolean) => Promise<void>;
  onRate: (item: GalleryItem, patch: { score?: number | null; liked?: boolean; note?: string }) => Promise<void>;
  onOpenRecipe: (id: number) => void;
  index: number | null;
  blur: boolean;
  onClose: () => void;
  onIndex: (i: number) => void;
  /** when given, a delete button appears; the parent removes the item (and moves/closes the index) */
  onDelete?: (item: GalleryItem) => Promise<void> | void;
}) {
  const { t } = useGalleryTranslation();
  const [metadata, setMetadata] = React.useState(false);
  const [showReview, setShowReview] = React.useState(false);
  const item = index !== null ? items[index] : undefined;
  const [revealFor, setRevealFor] = React.useState<number | null>(null); // index whose blur was lifted; moving on re-blurs
  const reveal = revealFor === index;
  const setReveal = (on: boolean) => setRevealFor(on ? index : null);
  const [busy, setBusy] = React.useState<"copy" | "download" | null>(null);
  const [showPrompt, setShowPrompt] = React.useState(false);

  const prev = React.useCallback(() => { if (index !== null && index > 0) onIndex(index - 1); }, [index, onIndex]);
  const next = React.useCallback(() => { if (index !== null && index < items.length - 1) onIndex(index + 1); }, [index, items.length, onIndex]);
  React.useEffect(() => {
    if (index === null) return;
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && (e.target.closest("input, textarea, [contenteditable=true]") !== null)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [index, prev, next]);

  if (!item) return <Dialog open={false} onOpenChange={() => onClose()} />;
  const url = item.url;
  const hidden = blur && item.rating >= 1 && !reveal;
  const fileName = `studio_${item.id}_${item.seed}.png`;

  const doCopy = async () => {
    setBusy("copy");
    try { await copyImage(url); toast.add({ title: t("copied"), description: fileName, type: "success" }); }
    catch { toast.add({ title: t("copyFailed"), type: "error" }); }
    finally { setBusy(null); }
  };
  const doDownload = async () => { setBusy("download"); try { await onExport(item, metadata); } catch { toast.add({ title: t("exportFailed"), type: "error" }); } finally { setBusy(null); } };
  const copyPrompt = async () => {
    const text = [item.base_prompt, item.negative ? `\n[negative]\n${item.negative}` : "", item.characters.length ? `\n[characters]\n${item.characters.map((c, i) => `${i + 1}. ${c.prompt} @${c.x},${c.y}${c.uc ? ` | uc: ${c.uc}` : ""}`).join("\n")}` : ""].join("");
    toast.add((await copyText(text)) ? { title: t("promptCopied"), type: "success" } : { title: t("copyFailed"), type: "error" });
  };

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false} className="flex h-[94svh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-[96vw]">
        <DialogTitle className="sr-only">{t("imageTitle", { id: item.id })}</DialogTitle>

        <div role="group" aria-label={t("info")} className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">#{item.id}</span>
          {item.recipe_id ? <button type="button" onClick={() => onOpenRecipe(item.recipe_id!)} className="truncate hover:underline">{item.recipe_name}</button> : <span>{item.recipe_name || t("adhoc")}</span>}
          <span>seed {item.seed}</span>
          <span>{item.width}×{item.height}</span>
          <span>{item.created_at.slice(0, 16)}</span>
          {item.rating >= 1 ? <Badge variant="destructive" className="h-4 text-[10px]">R{item.rating}</Badge> : null}
          {item.anlas_cost ? <Badge variant="outline" className="h-4 text-[10px]">{item.anlas_cost} anlas</Badge> : null}
          <span className="ml-auto">{(index ?? 0) + 1} / {items.length}</span>
          </div>
          <DialogClose render={<Button size="icon-sm" variant="ghost" aria-label={t("close")} />}><X /></DialogClose>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/90">
          <img src={url} alt={`#${item.id}`} className={cn("max-h-full max-w-full object-contain select-none", hidden && "blur-2xl")} draggable={false} />
          {item.rating >= 1 && blur ? (
            <Button size="sm" variant="secondary" className="absolute top-2 left-2" onClick={() => setReveal(!reveal)}>
              {hidden ? <EyeOff /> : <Eye />} {t(hidden ? "show" : "hide")}
            </Button>
          ) : null}
          <Button size="icon" variant="secondary" className="absolute top-1/2 left-2 -translate-y-1/2 opacity-80" disabled={index === 0} onClick={prev} title={t("previous")}><ChevronLeft /></Button>
          <Button size="icon" variant="secondary" className="absolute top-1/2 right-2 -translate-y-1/2 opacity-80" disabled={index === items.length - 1} onClick={next} title={t("next")}><ChevronRight /></Button>
        </div>

        {showPrompt ? (
          <div className="max-h-40 overflow-y-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap">
            <div>{item.base_prompt}</div>
            {item.negative ? <div className="mt-1 text-muted-foreground">[negative] {item.negative}</div> : null}
            {item.characters.map((c, i) => <div key={i} className="mt-1 text-muted-foreground">[char {i + 1} @{c.x},{c.y}] {c.prompt}{c.uc ? ` | uc: ${c.uc}` : ""}</div>)}
          </div>
        ) : null}

        {showReview ? <ImageReview key={item.id} item={item} onRate={onRate} /> : null}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
          <Button size="sm" onClick={doCopy} disabled={busy !== null || hidden} title={t("copyTitle")}>
            {busy === "copy" ? <Loader2 className="animate-spin" /> : <ClipboardCopy />} {t("copy")}
          </Button>
          <Button size="sm" variant="outline" onClick={doDownload} disabled={busy !== null} title={fileName}>
            {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />} {t("download")}
          </Button>
          <Button size="sm" variant="ghost" onClick={copyPrompt} title={t("copyPromptTitle")}><Copy /> {t("copyPrompt")}</Button>
          <Button size="sm" variant="ghost" onClick={async () => toast.add((await copyText(String(item.seed))) ? { title: t("seedCopied", { seed: item.seed }), type: "success" } : { title: t("copyFailed"), type: "error" })}>
            seed
          </Button>
          <Button size="sm" variant={showPrompt ? "secondary" : "ghost"} onClick={() => setShowPrompt(v => !v)}><Notebook /> {t("prompt")}</Button>
          <Button size="sm" variant={showReview ? "secondary" : "ghost"} onClick={() => setShowReview(value => !value)}><Star /> {t("review")}</Button>
          <label className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground"><Checkbox checked={metadata} onCheckedChange={checked => setMetadata(checked === true)} />{t("metadata")}</label>
          {onDelete ? (
            <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={busy !== null}
              onClick={() => { if (confirm(t("deleteOne", { id: item.id }))) void onDelete(item); }}><Trash2 /> {t("delete")}</Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default Lightbox;

function ImageReview({ item, onRate }: { item: GalleryItem; onRate: (item: GalleryItem, patch: { score?: number | null; liked?: boolean; note?: string }) => Promise<void> }) {
  const { t } = useGalleryTranslation();
  const [note, setNote] = React.useState(item.note);
  const [busy, setBusy] = React.useState(false);
  const save = async (patch: { score?: number | null; liked?: boolean; note?: string }) => {
    setBusy(true);
    try { await onRate(item, patch); } catch { toast.add({ title: t("saveFailed"), type: "error" }); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
    <div className="flex items-center gap-0.5">{[1, 2, 3, 4, 5].map(score => <Button key={score} size="icon-xs" variant="ghost" aria-label={String(score)} aria-pressed={(item.score ?? 0) >= score} disabled={busy} onClick={() => void save({ score: item.score === score ? null : score })}><Star fill={(item.score ?? 0) >= score ? "currentColor" : "none"} /></Button>)}</div>
    <Button size="icon-xs" variant="ghost" aria-label={t("liked")} aria-pressed={item.liked} disabled={busy} onClick={() => void save({ liked: !item.liked })}><Heart fill={item.liked ? "currentColor" : "none"} /></Button>
    <Textarea aria-label={t("note")} value={note} onChange={event => setNote(event.target.value)} className="min-h-8 flex-1 text-xs" rows={1} />
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ note })}>{t("saveNote")}</Button>
  </div>;
}
