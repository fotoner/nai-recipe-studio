import * as React from "react";
import { Archive, Download, RotateCcw, Upload } from "lucide-react";
import type { StudioClient } from "@/contracts/studio";
import type { WorkspaceBackupCounts, WorkspaceBackupPreview } from "@/contracts/workspace-backup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { InlineNotice } from "@/features/shared/ui";
import { errorMessage, studioCall } from "@/desktop/renderer/studio-client";
import { useTranslation } from "react-i18next";

type WorkspaceBackupProps = { client?: StudioClient };
type BusyAction = "export" | "inspect" | "restore" | null;

const COUNT_KEYS: Array<[keyof WorkspaceBackupCounts, string]> = [
  ["recipes", "workspaceBackup.countRecipes"],
  ["recipeVersions", "workspaceBackup.countRecipeVersions"],
  ["characters", "workspaceBackup.countCharacters"],
  ["presets", "workspaceBackup.countPresets"],
  ["galleryItems", "workspaceBackup.countGalleryItems"],
  ["images", "workspaceBackup.countImages"],
];

export function WorkspaceBackup({ client }: WorkspaceBackupProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = React.useState<WorkspaceBackupPreview | null>(null);
  const [busy, setBusy] = React.useState<BusyAction>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [needsReview, setNeedsReview] = React.useState(false);

  const review = async (stagingId?: string) => {
    if (!client || busy) return;
    setBusy("inspect"); setError(null); setNotice(null); setNeedsReview(false);
    try {
      const result = await studioCall(client, "workspace.backup.inspect", stagingId ? { stagingId } : {});
      if (result.preview) setPreview(result.preview);
      else if (!stagingId) setPreview(null);
    } catch (cause) { setError(errorMessage(cause, "workspaceBackup.inspectError")); }
    finally { setBusy(null); }
  };

  const exportBackup = async () => {
    if (!client || busy) return;
    setBusy("export"); setError(null); setNotice(null);
    try {
      const result = await studioCall(client, "workspace.backup.export", {});
      if (result.saved) setNotice(t("workspaceBackup.exported", { missingFiles: result.missingFiles ?? 0 }));
    } catch (cause) { setError(errorMessage(cause, "workspaceBackup.exportError")); }
    finally { setBusy(null); }
  };

  const restore = async () => {
    if (!client || !preview || busy || preview.alreadyImported) return;
    setBusy("restore"); setError(null); setNotice(null); setNeedsReview(false);
    try {
      const result = await studioCall(client, "workspace.backup.restore", { stagingId: preview.stagingId });
      if (result.alreadyImported) setNotice(t("workspaceBackup.alreadyImported"));
      else setNotice(t("workspaceBackup.restored"));
      setPreview(null);
    } catch (cause) {
      const message = errorMessage(cause, "workspaceBackup.restoreError");
      setError(message);
      setNeedsReview(message === "errors.BACKUP_PREVIEW_STALE");
    } finally { setBusy(null); }
  };

  return <Card className="gap-0 py-0" data-testid="workspace-backup">
    <CardHeader className="px-4 py-4">
      <h2 className="flex items-center gap-2 text-sm font-medium"><Archive className="size-4" />{t("workspaceBackup.title")}</h2>
      <CardDescription className="text-xs">{t("workspaceBackup.description")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-3 px-4 pb-4">
      <p className="text-xs text-muted-foreground">{t("workspaceBackup.scope")}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void exportBackup()} disabled={!client || busy !== null}>
          <Download />{busy === "export" ? t("workspaceBackup.exporting") : t("workspaceBackup.export")}
        </Button>
        <Button size="sm" onClick={() => void review(needsReview ? preview?.stagingId : undefined)} disabled={!client || busy !== null}>
          <Upload />{busy === "inspect" ? t("workspaceBackup.inspecting") : needsReview ? t("workspaceBackup.reviewAgain") : t("workspaceBackup.inspect")}
        </Button>
      </div>

      {error ? <InlineNotice kind="error">{t(error.startsWith("errors.") || error.startsWith("workspaceBackup.") ? error : "workspaceBackup.unknownError")}</InlineNotice> : null}
      {notice ? <InlineNotice kind="success">{notice}</InlineNotice> : null}

      {preview ? <section aria-label={t("workspaceBackup.previewTitle")} className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium">{t("workspaceBackup.previewTitle")}</h3>
          <span className="text-[11px] text-muted-foreground">{formatBytes(preview.archiveBytes)}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("workspaceBackup.createdAt", { date: new Date(preview.createdAt).toLocaleString(), version: preview.appVersion })}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <Count value={preview.counts.recipes} translationKey="workspaceBackup.countRecipes" />
          <Count value={preview.counts.recipeVersions} translationKey="workspaceBackup.countRecipeVersions" />
          <Count value={preview.counts.characters} translationKey="workspaceBackup.countCharacters" />
          <Count value={preview.counts.presets} translationKey="workspaceBackup.countPresets" />
          <Count value={preview.counts.galleryItems} translationKey="workspaceBackup.countGalleryItems" />
          <Count value={preview.counts.images} translationKey="workspaceBackup.countImages" />
        </dl>
        {COUNT_KEYS.some(([key]) => preview.duplicates[key] > 0) ? <div className="flex flex-col gap-1 text-xs text-amber-700 dark:text-amber-400">
          <strong>{t("workspaceBackup.duplicatesTitle")}</strong>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {COUNT_KEYS.filter(([key]) => preview.duplicates[key] > 0).map(([key]) => <span key={key}>{t(duplicateKey(key), { count: preview.duplicates[key] })}</span>)}
          </div>
        </div> : null}
        {preview.missingFiles > 0 ? <InlineNotice kind="error">{t("workspaceBackup.missingFiles", { count: preview.missingFiles })}</InlineNotice> : null}
        {preview.alreadyImported ? <InlineNotice kind="success">{t("workspaceBackup.alreadyImported")}</InlineNotice> : <p className="text-[11px] text-muted-foreground">{t("workspaceBackup.restoreHint")}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void restore()} disabled={!client || busy !== null || preview.alreadyImported}>
            <RotateCcw />{busy === "restore" ? t("workspaceBackup.restoring") : t("workspaceBackup.restore")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPreview(null)} disabled={busy !== null}>{t("common.cancel")}</Button>
        </div>
      </section> : null}
    </CardContent>
  </Card>;
}

function Count({ value, translationKey }: { value: number; translationKey: string }) {
  const { t } = useTranslation();
  return <div className="text-muted-foreground">{t(translationKey, { count: value })}</div>;
}

function duplicateKey(key: keyof WorkspaceBackupCounts) {
  switch (key) {
    case "recipes": return "workspaceBackup.duplicateRecipes";
    case "recipeVersions": return "workspaceBackup.duplicateRecipeVersions";
    case "characters": return "workspaceBackup.duplicateCharacters";
    case "presets": return "workspaceBackup.duplicatePresets";
    case "galleryItems": return "workspaceBackup.duplicateGalleryItems";
    case "images": return "workspaceBackup.duplicateImages";
  }
}

function formatBytes(bytes: number) {
  return new Intl.NumberFormat(undefined, { style: "unit", unit: "byte", unitDisplay: "narrow", maximumFractionDigits: 1 }).format(bytes);
}
