import { WorkspaceBackup } from "./WorkspaceBackup";
import * as React from "react";
import { ExternalLink, FolderOpen, KeyRound, Languages, Link2, MonitorCog, Plus, ShieldCheck, Trash2, Unplug } from "lucide-react";
import type { Connection, SetupStatus, SetupTarget, StudioClient } from "@/contracts/studio";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, InlineNotice, cx } from "@/features/shared/ui";
import { changeLanguage, languageOptions, languagePreferenceFrom } from "@/i18n";
import type { Language, Usage } from "@/features/shared/types";
import { errorMessage, studioCall } from "@/desktop/renderer/studio-client";
import { useTranslation } from "react-i18next";

type SettingsProps = { client?: StudioClient; onLanguageChanged?: (language: Language) => void };
type SetupState = SetupStatus;
type PermissionKey = keyof Connection["permissions"];
type PermissionState = Connection["permissions"];

const permissionKeys: PermissionKey[] = ["read", "write", "generate", "images"];
const emptyPermissions: PermissionState = { read: true, write: true, generate: false, images: false };

function SettingsCard({ icon, title, description, children }: { icon?: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return <Card className="gap-0 py-0"><CardHeader className="px-4 py-4"><h2 className="flex items-center gap-2 text-sm font-medium">{icon}{title}</h2>{description ? <CardDescription className="text-xs">{description}</CardDescription> : null}</CardHeader><CardContent className="flex flex-col gap-3 px-4 pb-4">{children}</CardContent></Card>;
}

function accountUsage(status: { connected: boolean; account: { tier: string; usagePercent: number | null; anlas: number | null } | null }): Usage {
  return { connected: status.connected, plan: status.account?.tier, percent: status.account?.usagePercent ?? undefined, anlas: status.account?.anlas ?? undefined };
}

export function SettingsFeature({ client, onLanguageChanged }: SettingsProps) {
  const { t } = useTranslation();
  const [language, setLanguage] = React.useState<Language>("system");
  const [blur, setBlur] = React.useState(false);
  const [outputDirectory, setOutputDirectory] = React.useState("");
  const [token, setToken] = React.useState("");
  const [usage, setUsage] = React.useState<Usage>({ connected: false });
  const [setups, setSetups] = React.useState<Record<SetupTarget, SetupState | undefined>>({ codex: undefined, "claude-desktop": undefined });
  const [connections, setConnections] = React.useState<Connection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = React.useState("");
  const [creatingConnection, setCreatingConnection] = React.useState(false);
  const [connectionName, setConnectionName] = React.useState("");
  const [permissions, setPermissions] = React.useState<PermissionState>(emptyPermissions);
  const [maxImages, setMaxImages] = React.useState(1);
  const [maxAnlas, setMaxAnlas] = React.useState(0);
  const [selectedTarget, setSelectedTarget] = React.useState<SetupTarget>("codex");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!client) return;
    try {
      const [settings, status, codex, claude, listedConnections] = await Promise.all([
        studioCall(client, "settings.get", {}),
        studioCall(client, "status.read", {}),
        studioCall(client, "setup.inspect", { target: "codex" }),
        studioCall(client, "setup.inspect", { target: "claude-desktop" }),
        studioCall(client, "ai.connections.list", {}),
      ]);
      const preference = languagePreferenceFrom(settings.language);
      setLanguage(preference); setBlur(settings.blurSensitive); setOutputDirectory(settings.outputDirectory); setUsage(accountUsage(status));
      setSetups({ codex, "claude-desktop": claude });
      setConnections(listedConnections);
      setSelectedConnectionId((current) => current && listedConnections.some((item) => item.id === current) ? current : listedConnections[0]?.id ?? "");
      await changeLanguage(preference); onLanguageChanged?.(preference);
    } catch (cause) { setError(errorMessage(cause, "errors.load")); }
  }, [client, onLanguageChanged]);
  React.useEffect(() => { void load(); }, [load]);

  const selectedConnection = connections.find((item) => item.id === selectedConnectionId);
  const currentSetup = setups[selectedTarget];

  const updateSettings = async (patch: { language?: Language; blurSensitive?: boolean; outputDirectory?: string }) => {
    if (!client) return;
    setBusy(true); setError(null); setNotice(null);
    try { const result = await studioCall(client, "settings.update", patch); setLanguage(result.language); setBlur(result.blurSensitive); setOutputDirectory(result.outputDirectory); if (patch.language) await changeLanguage(patch.language); onLanguageChanged?.(result.language); setNotice(t("settings.languageSaved")); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    if (!client || !token.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try { await studioCall(client, "credentials.set", { token: token.trim() }); const status = await studioCall(client, "credentials.test", {}); setUsage(accountUsage(status)); setToken(""); setNotice(t("settings.connectionSuccess")); }
    catch (cause) { setError(errorMessage(cause, "settings.connectionFailure")); }
    finally { setBusy(false); }
  };

  const clearToken = async () => {
    if (!client || busy || !usage.connected || !window.confirm(t("settings.clearTokenConfirm"))) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await studioCall(client, "credentials.clear", {});
      setToken("");
      setUsage({ connected: result.connected });
      setNotice(t("settings.connectionCleared"));
    } catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };

  const createConnection = async () => {
    if (!client || !connectionName.trim() || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { const created = await studioCall(client, "ai.connections.create", { name: connectionName.trim(), permissions, maxImages: Math.max(0, maxImages), maxAnlas: Math.max(0, maxAnlas) }); setConnections((current) => [...current, created]); setSelectedConnectionId(created.id); setConnectionName(""); setCreatingConnection(false); setNotice(t("settingsExtra.connectionCreated")); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };

  const revokeConnection = async () => {
    if (!client || !selectedConnection || busy || !window.confirm(t("settingsExtra.revokeConfirm", { name: selectedConnection.name }))) return;
    setBusy(true); setError(null); setNotice(null);
    try { await studioCall(client, "ai.connections.revoke", { id: selectedConnection.id }); const next = connections.filter((item) => item.id !== selectedConnection.id); setConnections(next); setSelectedConnectionId(next[0]?.id ?? ""); setNotice(t("settingsExtra.connectionRevoked")); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };

  const openHelp = (page: "novelai" | "token") => { if (client) void studioCall(client, "help.open", { page }); };
  const chooseOutput = async () => { if (!client) return; try { const result = await studioCall(client, "files.chooseOutput", {}); if (result.path) { setOutputDirectory(result.path); await updateSettings({ outputDirectory: result.path }); } } catch (cause) { setError(errorMessage(cause, "errors.save")); } };

  const installSetup = async () => {
    if (!client || !selectedConnectionId || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { const result = await studioCall(client, "setup.install", { target: selectedTarget, connectionId: selectedConnectionId }); setSetups((current) => ({ ...current, [selectedTarget]: result })); setNotice(t("settings.setupDone")); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };

  const uninstallSetup = async () => {
    if (!client || busy || !currentSetup?.mcpInstalled && !currentSetup?.skillInstalled || !window.confirm(t("settingsExtra.uninstallConfirm"))) return;
    setBusy(true); setError(null); setNotice(null);
    try { const result = await studioCall(client, "setup.uninstall", { target: selectedTarget }); setSetups((current) => ({ ...current, [selectedTarget]: result })); setNotice(t("settingsExtra.uninstalled")); }
    catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };

  const translatedError = error && (error.startsWith("errors.") || error.startsWith("settings.") || error.startsWith("settingsExtra.")) ? t(error) : error ? t("errors.unknown") : null;
  const fieldSelectClass = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return <>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6"><div><h1 className="text-base font-semibold tracking-tight">{t("settings.title")}</h1><p className="text-xs text-muted-foreground">{t("settings.description")}</p></div></header>
    <div className="grid max-w-5xl gap-4 p-4 md:p-6">
      {translatedError ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{translatedError}</div> : null}
      {notice ? <InlineNotice kind="success">{notice}</InlineNotice> : null}
      <SettingsCard icon={<Languages className="size-4" />} title={t("settings.language")} description={t("settings.languageDescription")}><div className="flex flex-wrap gap-2">{languageOptions.map((option) => <label key={option.value} className={cx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors", language === option.value ? "border-foreground bg-muted font-medium" : "border-border text-muted-foreground hover:bg-muted/60")}><input type="radio" className="accent-primary" name="language" value={option.value} checked={language === option.value} onChange={() => void updateSettings({ language: option.value })} />{t(option.labelKey)}</label>)}</div></SettingsCard>
      <SettingsCard icon={<KeyRound className="size-4" />} title={t("settings.connection")} description={t("settings.connectionDescription")}><div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className={cx("size-2 rounded-full bg-muted-foreground", usage.connected && "bg-emerald-500")} />{usage.connected ? t("common.connected") : t("status.notConnected")}{usage.plan ? <span>{usage.plan}</span> : null}{typeof usage.percent === "number" ? <span>{usage.percent}%</span> : null}{typeof usage.anlas === "number" ? <span>{usage.anlas} Anlas</span> : null}</div><Field label={t("settings.token")} hint={t("settings.tokenHelp")}><Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={t("settings.tokenPlaceholder")} autoComplete="off" /></Field><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => openHelp("token")}><ExternalLink />{t("settings.openNovelAI")}</Button><Button size="sm" onClick={() => void connect()} disabled={!token.trim() || busy}><Link2 />{busy ? t("settings.checkingConnection") : t("settings.checkConnection")}</Button>{usage.connected ? <Button size="sm" variant="ghost" onClick={() => void clearToken()} disabled={busy}><Unplug />{t("settings.clearToken")}</Button> : null}</div></SettingsCard>
      <SettingsCard icon={<ShieldCheck className="size-4" />} title={t("settingsExtra.connections")} description={t("settingsExtra.connectionsDescription")}>
        {selectedConnection ? <div className="rounded-lg border border-border p-3"><div className="flex items-start justify-between gap-2"><div className="flex flex-col"><strong className="text-sm">{selectedConnection.name}</strong><span className="text-xs text-muted-foreground">{t("settingsExtra.selectedConnection")}</span></div><Button size="xs" variant="destructive" onClick={() => void revokeConnection()} disabled={busy}><Trash2 />{t("settingsExtra.revoke")}</Button></div><div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">{permissionKeys.map((key) => <span key={key} className={cx("rounded-md border px-2 py-1", selectedConnection.permissions[key] ? "border-foreground/30 bg-muted text-foreground" : "border-border text-muted-foreground")}>{t(`settingsExtra.permission${key[0].toUpperCase()}${key.slice(1)}`)}</span>)}<span className="rounded-md bg-muted px-2 py-1">{t("settingsExtra.maxImages")}: {selectedConnection.maxImages}</span><span className="rounded-md bg-muted px-2 py-1">{t("settingsExtra.maxAnlas")}: {selectedConnection.maxAnlas}</span></div></div> : <InlineNotice>{t("settingsExtra.noConnections")}</InlineNotice>}
        {creatingConnection ? <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border p-3"><Field label={t("settingsExtra.connectionName")}><Input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder={t("settingsExtra.connectionNamePlaceholder")} /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label={t("settingsExtra.maxImages")}><Input type="number" min={0} max={200} value={maxImages} onChange={(event) => setMaxImages(Number(event.target.value) || 0)} /></Field><Field label={t("settingsExtra.maxAnlas")}><Input type="number" min={0} max={100000} value={maxAnlas} onChange={(event) => setMaxAnlas(Number(event.target.value) || 0)} /></Field></div><div className="flex flex-col gap-2"><span className="text-xs font-medium">{t("settings.permissions")}</span>{permissionKeys.map((key) => <label key={key} className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={permissions[key]} onChange={(event) => setPermissions((current) => ({ ...current, [key]: event.target.checked }))} />{t(`settingsExtra.permission${key[0].toUpperCase()}${key.slice(1)}`)}</label>)}</div><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void createConnection()} disabled={!connectionName.trim() || busy}><Plus />{t("settingsExtra.saveConnection")}</Button><Button size="sm" variant="ghost" onClick={() => setCreatingConnection(false)}>{t("common.cancel")}</Button></div></div> : <Button size="sm" variant="outline" onClick={() => setCreatingConnection(true)}><Plus />{t("settingsExtra.createConnection")}</Button>}
      </SettingsCard>
      <SettingsCard icon={<FolderOpen className="size-4" />} title={t("settings.storage")} description={t("settings.storageDescription")}><div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2"><code className="min-w-0 truncate text-xs text-muted-foreground">{outputDirectory || "—"}</code><Button size="sm" variant="outline" onClick={() => void chooseOutput()}><FolderOpen />{t("settings.changeFolder")}</Button></div></SettingsCard>
      <WorkspaceBackup client={client} />
      <SettingsCard icon={<MonitorCog className="size-4" />} title={t("settings.display")} description={t("settings.blurDescription")}><div className="flex items-center justify-between gap-3"><span className="flex flex-col"><strong className="text-xs">{t("settings.blur")}</strong><small className="text-[11px] text-muted-foreground">{t("settings.blurDescription")}</small></span><Switch checked={blur} onCheckedChange={(checked) => { setBlur(checked); void updateSettings({ blurSensitive: checked }); }} /></div></SettingsCard>
      <SettingsCard icon={<Unplug className="size-4" />} title={t("settings.ai.title")} description={t("settings.ai.description")}><div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-0.5">{(["codex", "claude-desktop"] as const).map((target) => <Button key={target} size="sm" variant={selectedTarget === target ? "secondary" : "ghost"} onClick={() => setSelectedTarget(target)}>{target === "codex" ? "Codex" : "Claude Desktop"}</Button>)}</div>{currentSetup?.skillInstalled || currentSetup?.mcpInstalled ? <InlineNotice kind="success">{t("settings.skillStatus", { version: currentSetup.version ?? "" })}</InlineNotice> : <InlineNotice>{currentSetup?.messageKey ? t(currentSetup.messageKey) : t("settingsExtra.notInstalled")}</InlineNotice>}<div className="grid gap-2 rounded-lg border border-border p-3 text-xs"><div className="flex flex-col gap-1"><span className="text-muted-foreground">{t("settingsExtra.mcpPath")}</span><code className="break-all">{currentSetup?.configPath || "—"}</code></div>{currentSetup?.skillPath ? <div className="flex flex-col gap-1"><span className="text-muted-foreground">{t("settingsExtra.skillPath")}</span><code className="break-all">{currentSetup.skillPath}</code></div> : null}</div><Field label={t("settingsExtra.profileForSetup")} hint={selectedConnection ? undefined : t("settingsExtra.connectionRequired")}><select className={fieldSelectClass} value={selectedConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)} disabled={!connections.length}><option value="">{t("settingsExtra.chooseConnection")}</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></Field><div className="flex flex-wrap gap-2"><Button onClick={() => void installSetup()} disabled={busy || !selectedConnectionId || currentSetup?.available === false}><ShieldCheck />{currentSetup?.mcpInstalled ? t("settingsExtra.updateSetup") : t("settings.setup")}</Button>{currentSetup?.mcpInstalled || currentSetup?.skillInstalled ? <Button variant="outline" onClick={() => void uninstallSetup()} disabled={busy}><Trash2 />{t("settingsExtra.uninstall")}</Button> : null}</div><p className="text-[11px] text-muted-foreground">{t("settings.permissionHint")}</p></SettingsCard>
      <SettingsCard title={t("settings.about")} description={t("settings.aboutDescription")}><p className="text-xs text-muted-foreground">{t("settings.version", { version: "0.1.0" })}</p></SettingsCard>
    </div>
  </>;
}
