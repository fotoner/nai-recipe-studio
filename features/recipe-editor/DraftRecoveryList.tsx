import * as React from "react";
import { FileClock, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { listDrafts, removeDraft, type RecipeDraft } from "./drafts";

export function DraftRecoveryList({ onOpen }: { onOpen: (draft: RecipeDraft) => void }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = React.useState(listDrafts);
  if (!drafts.length) return null;
  return <section aria-label={t("editor.drafts")} className="border-b border-border px-4 py-3 md:px-6"><h2 className="mb-2 flex items-center gap-2 text-xs font-medium"><FileClock className="size-3.5" />{t("editor.drafts")}</h2><div className="flex flex-col gap-1">{drafts.map(draft => <div key={draft.key} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{draft.recipe.name || t("editor.title")}</span><Button size="xs" variant="outline" onClick={() => onOpen(draft)}>{t("editor.continueDraft")}</Button><Button size="icon-xs" variant="ghost" aria-label={t("editor.discardDraft")} onClick={() => { removeDraft(draft.key); setDrafts(listDrafts()); }}><Trash2 /></Button></div>)}</div></section>;
}
