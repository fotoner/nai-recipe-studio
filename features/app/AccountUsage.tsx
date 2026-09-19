import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { AccountStatus, StudioClient } from "@/contracts/studio";
import { studioCall } from "@/desktop/renderer/studio-client";
import { i18n } from "@/i18n";
import { useTranslation } from "react-i18next";
import en from "./locales/en.json";
import ko from "./locales/ko.json";
import ja from "./locales/ja.json";
for (const [language, resource] of Object.entries({ en, ko, ja })) i18n.addResourceBundle(language, "account", resource, true, true);

export function AccountUsage({ client, connected }: { client?: StudioClient; connected: boolean }) {
  const { t } = useTranslation("account");
  const [account, setAccount] = React.useState<AccountStatus | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const refresh = React.useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try { const status = await studioCall(client, "status.read", {}); setAccount(status.account); setFailed(false); }
    catch { setFailed(true); }
    finally { setLoading(false); }
  }, [client]);
  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => client?.subscribe(event => { if (event.type === "job.changed" && ["completed", "failed", "cancelled"].includes(event.job.state)) void refresh(); }), [client, refresh]);
  return <section aria-label={t("usage")} className="mb-3 flex flex-col gap-2 border-b border-border pb-3 text-xs">
    <div className="flex items-center justify-between"><h2 className="font-medium">{t("usage")}</h2><Button size="icon-xs" variant="ghost" aria-label={t("refresh")} disabled={loading} onClick={() => void refresh()}><RefreshCw className={loading ? "animate-spin" : ""} /></Button></div>
    {account ? <>
      {account.tier === "opus" && account.usagePercent !== null ? <><div className="flex justify-between text-muted-foreground"><span>{t("opus")}</span><span className="font-mono text-foreground">{Math.round(account.usagePercent * 10) / 10}%</span></div><Progress aria-label={t("opus")} value={Math.min(100, Math.max(0, account.usagePercent))} /><p className="text-[10px] text-muted-foreground" title={t("consumedHint")}>{t("consumed", { count: Math.round(Math.min(100, Math.max(0, account.usagePercent)) * 17).toLocaleString() })}</p></> : null}
      <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("balance")}</span><span className="font-mono">{account.anlas?.toLocaleString() ?? "—"}</span></div>
    </> : <p className="text-muted-foreground">{t(loading ? "loading" : connected ? "unavailable" : "offline")}</p>}
    {failed && account ? <p role="status" className="text-[10px] text-amber-500">{t("stale")}</p> : null}
  </section>;
}
