import * as React from "react";
import { ArrowDown, ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, Ban, Brush, Check, ChevronDown, Code2, Copy, Crop, Download, History, Image as ImageIcon, Layers, Loader2, MessageCircle, MoreHorizontal, Plus, Replace, Redo2, RotateCcw, Save, Undo2, ShieldAlert, Shirt, ShieldCheck, Smile, SlidersHorizontal, Sparkle, Sun, Trash2, Users } from "lucide-react";
import type { Composed, GalleryItem as StoredGalleryItem, RecipeVersion, StudioClient } from "@/contracts/studio";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, FindingList, LoadingState, PageHeader, TagInput, cx, BlockLabel } from "@/features/shared/ui";
import { BLOCK_LABEL_KEY, BLOCK_ORDER, blockSummary, newBlock, type Block, type BlockType, type Character, type LintFinding, type Preset, type Recipe } from "@/features/shared/types";
import { errorMessage, studioCall, subscribeToStudio } from "@/desktop/renderer/studio-client";
import { useTranslation } from "react-i18next";
import { BlockEditor as SharedBlockEditor } from "@/features/palette/PaletteComponents";
import { CastEditor } from "@/features/cast/CastEditor";
import { PresetDialog, type PresetDraft } from "@/features/palette/PaletteComponents";
import { stripPresetRef } from "@/core/palette";
import { BlockPicker } from "@/features/cast/BlockPicker";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { presetName } from "@/i18n/preset-text";
import { Lightbox } from "@/features/gallery/Lightbox";
import { Thumbnail } from "@/features/gallery/Thumbnail";
import { RecipeGenerateDialog, type RecipeGenerationState } from "@/features/generation/RecipeGenerateDialog";
import { GenerationResults } from "@/features/generation/GenerationResults";
import { readAllPages } from "@/features/shared/pagination";
import type { GalleryItem as GalleryViewItem } from "@/features/gallery/types";

import { readDraft, recipeDraftKey, removeDraft, type RecipeDraft } from "./drafts";
import { useRecipeHistory } from "./useRecipeHistory";
import { RecipeProposals } from "./RecipeProposals";

import type { GenerationDraftFromImage } from "@/core/recipe/from-generation";

type RecipeEditorProps = { client?: StudioClient; recipeId?: number; draftId?: string; initialRecipe?: Recipe; snapshotMissing?: boolean; onContinueFromGeneration?: (draft: GenerationDraftFromImage) => void; onSaved?: (id: number) => void; onBack: () => void; onDirtyChange?: (dirty: boolean) => void; onGenerationBusyChange?: (busy: boolean) => void };

function asRecipe(value: unknown): Recipe {
  const input = (value ?? {}) as Partial<Recipe>;
  return { ...input, name: input.name ?? "", tags: Array.isArray(input.tags) ? input.tags : [], rating: typeof input.rating === "number" ? input.rating : 0, blocks: Array.isArray(input.blocks) ? input.blocks as Block[] : [], source: input.source ?? "manual", notes: input.notes ?? "" } as Recipe;
}

function asCharacters(value: unknown): Character[] { return Array.isArray(value) ? value as Character[] : []; }
function asPresets(value: unknown): Preset[] { return Array.isArray(value) ? value as Preset[] : []; }
function isEmptyCast(block: Block): boolean { return block.type === "cast" && block.members.length === 0; }
function withoutEmptyCast(recipe: Recipe): Recipe { return { ...recipe, blocks: recipe.blocks.filter((block) => !isEmptyCast(block)) }; }
function withCastBlock(recipe: Recipe): Recipe { return recipe.blocks.some((block) => block.type === "cast") ? recipe : { ...recipe, blocks: [newBlock("cast"), ...recipe.blocks] }; }

export function RecipeEditorFeature({ client, recipeId, draftId, initialRecipe, snapshotMissing, onContinueFromGeneration, onSaved, onBack, onDirtyChange, onGenerationBusyChange }: RecipeEditorProps) {
  const { t } = useTranslation();
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const draftKey = recipeId ? recipeDraftKey(recipeId) : `new:${draftId ?? "unsaved"}`;
  const history = useRecipeHistory(draftKey);
  const { recipe, dirty, initialize, update: editRecipe, undo, redo, markSaved } = history;
  const [proposalBusy, setProposalBusy] = React.useState(false);
  const [recovery, setRecovery] = React.useState<RecipeDraft | null>(null);
  const [generation, setGeneration] = React.useState<RecipeGenerationState | null>(null);
  const generationBusy = generation?.recipe.id === recipe?.id && !!generation?.busy;
  React.useEffect(() => {
    onGenerationBusyChange?.(generationBusy);
    return () => onGenerationBusyChange?.(false);
  }, [generationBusy, onGenerationBusyChange]);
  const [historyTick, setHistoryTick] = React.useState(0);
  const generationDone = React.useCallback(() => setHistoryTick(tick => tick + 1), []);
  const [characters, setCharacters] = React.useState<Character[]>([]);
  const [presets, setPresets] = React.useState<Preset[]>([]);
  const [findings, setFindings] = React.useState<LintFinding[]>([]);
  const [composed, setComposed] = React.useState<Composed | null>(null);
  const [versions, setVersions] = React.useState<RecipeVersion[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState<Record<number, boolean>>({ 0: true });
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [metadataOpen, setMetadataOpen] = React.useState(false);
  const [pick, setPick] = React.useState<{ type: BlockType; index?: number } | null>(null);
  const [presetDraft, setPresetDraft] = React.useState<(PresetDraft & { blockIndex: number }) | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!client) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const [loaded, characterPage, presetPage] = await Promise.all([
        recipeId ? studioCall(client, "recipes.get", { id: recipeId }).catch(cause => { const existing = readDraft(draftKey); if (!existing) throw cause; return { ...existing.recipe, id: undefined, version: undefined }; }) : Promise.resolve(readDraft(draftKey)?.recipe ?? initialRecipe),
        readAllPages(request => studioCall(client, "characters.list", request)),
        readAllPages(request => studioCall(client, "presets.list", { ...request, includeHidden: false })),
      ]);
      if (!loaded) throw new Error("Draft unavailable");
      const next = withCastBlock(asRecipe(loaded));
      const existing = recipeId ? readDraft(draftKey) : null;
      setRecovery(existing && JSON.stringify(withCastBlock(existing.recipe)) !== JSON.stringify(next) ? existing : null);
      initialize(next, !recipeId); setCharacters(asCharacters(characterPage)); setPresets(asPresets(presetPage));
    } catch (cause) { setError(errorMessage(cause, "errors.load")); }
    finally { setLoading(false); }
  }, [client, recipeId, draftKey, initialRecipe, initialize]);
  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const update = (next: Recipe) => { onDirtyChange?.(true); editRecipe(next); setComposed(null); };
  const save = async () => {
    if (!client || !recipe || busy || proposalBusy || !dirty) return;
    setBusy(true); setError(null);
    try {
      const expectedVersion = typeof recipe.version === "number" ? recipe.version : undefined;
      const stored = await studioCall(client, "recipes.save", { recipe: withoutEmptyCast(recipe), expectedVersion });
      const next = withCastBlock(asRecipe(stored));
      const stillDirty = markSaved(recipe, next); setRecovery(null);
      if ((recipeId !== next.id) && next.id && !stillDirty) { try { removeDraft(draftKey); } catch { /* explicit save still succeeded */ } if (mounted.current) onSaved?.(next.id); }
    } catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };
  const validate = async () => {
    if (!client || !recipe || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await studioCall(client, "recipe.validate", { recipe: withoutEmptyCast(recipe) });
      setFindings(Array.isArray(result.findings) ? result.findings as LintFinding[] : []);
      if (result.applied?.length && result.recipe && JSON.stringify(result.recipe) !== JSON.stringify(withoutEmptyCast(recipe))) update(withCastBlock(asRecipe(result.recipe)));
    } catch (cause) { setError(errorMessage(cause, "errors.load")); }
    finally { setBusy(false); }
  };
  const applyFixes = async (fixes: string[]) => {
    if (!client || !recipe || busy || fixes.length === 0) return;
    setBusy(true); setError(null);
    try {
      const result = await studioCall(client, "recipe.validate", { recipe: withoutEmptyCast(recipe), fixes });
      setFindings(Array.isArray(result.findings) ? result.findings as LintFinding[] : []);
      if (result.applied?.length && result.recipe && JSON.stringify(result.recipe) !== JSON.stringify(withoutEmptyCast(recipe))) update(withCastBlock(asRecipe(result.recipe)));
    } catch (cause) { setError(errorMessage(cause, "errors.save")); }
    finally { setBusy(false); }
  };
  const fixFinding = (finding: LintFinding) => { if (finding.fixable) void applyFixes([finding.code]); };
  const fixAll = () => { void applyFixes(findings.filter((finding) => finding.fixable).map((finding) => finding.code)); };
  const exportRecipe = async () => {
    if (!client || !recipe) return;
    try { await studioCall(client, "files.exportRecipe", { recipe: withoutEmptyCast(recipe) }); }
    catch (cause) { setError(errorMessage(cause, "errors.export")); }
  };
  const showVersions = async () => {
    if (!client || !recipe?.id) return;
    try { setVersions(await studioCall(client, "recipes.versions", { id: recipe.id })); }
    catch (cause) { setError(errorMessage(cause, "errors.load")); }
  };
  const restoreVersion = (version: RecipeVersion) => { update(withCastBlock({ ...asRecipe(version.recipe), id: recipe?.id, version: recipe?.version })); setVersions(null); };
  const appendBlock = (type: BlockType) => {
    if (!recipe) return;
    const index = recipe.blocks.findIndex((block) => block.type === type);
    setPick(index >= 0 ? { type, index } : { type });
  };
  const pickBlock = (block: Block) => {
    if (!recipe || !pick) return;
    if (pick.index === undefined) update({ ...recipe, blocks: [...recipe.blocks, block] });
    else updateBlock(pick.index, block);
    setPick(null);
  };
  const openPresetDialog = (block: Block, blockIndex: number) => setPresetDraft({ blockIndex, type: block.type, name: "", block: stripPresetRef(block), tags: [], notes: "" });
  const updateBlock = (index: number, block: Block) => { if (recipe) update({ ...recipe, blocks: recipe.blocks.map((item, itemIndex) => itemIndex === index ? block : item) }); };
  const removeBlock = (index: number) => { if (recipe) update({ ...recipe, blocks: recipe.blocks.filter((_, itemIndex) => itemIndex !== index) }); };
  const moveBlock = (index: number, direction: -1 | 1) => {
    if (!recipe) return;
    const next = [...recipe.blocks]; const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; update({ ...recipe, blocks: next });
    setOpen((current) => ({ ...current, [index]: current[target], [target]: current[index] }));
  };
  const sortBlocks = () => { if (recipe) update({ ...recipe, blocks: [...recipe.blocks].sort((a, b) => BLOCK_ORDER.indexOf(a.type) - BLOCK_ORDER.indexOf(b.type)) }); };
  const rating = Math.max(recipe?.rating ?? 0, ...(recipe?.blocks.filter((block) => block.type === "negative").map((block) => block.rating ?? 0) ?? []));

  React.useEffect(() => {
    if (!client || !recipe) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        studioCall(client, "recipe.compose", { recipe: withoutEmptyCast(recipe) }),
        studioCall(client, "recipe.validate", { recipe: withoutEmptyCast(recipe) }),
      ]).then(([composeResult, validateResult]) => {
        if (cancelled) return;
        if (composeResult.status === "fulfilled" && composeResult.value?.settings) setComposed(composeResult.value);
        if (validateResult.status === "fulfilled") {
          const nextFindings = Array.isArray(validateResult.value.findings) ? validateResult.value.findings as LintFinding[] : [];
          setFindings(nextFindings);
          if (validateResult.value.applied?.length && validateResult.value.recipe && JSON.stringify(validateResult.value.recipe) !== JSON.stringify(withoutEmptyCast(recipe))) {
            onDirtyChange?.(true);
            editRecipe(withCastBlock(asRecipe(validateResult.value.recipe)));
          }
        }
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, onDirtyChange, recipe, editRecipe]);

  const saveRef = React.useRef(save);
  React.useEffect(() => { saveRef.current = save; });
  React.useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (recovery || proposalBusy) { if (["s", "z", "y"].includes(key)) event.preventDefault(); return; }
      if (key === "s") { event.preventDefault(); (document.activeElement as HTMLElement | null)?.blur?.(); if (!recovery) window.setTimeout(() => { void saveRef.current(); }, 0); return; }
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input,textarea,[contenteditable=true],[role=dialog]")) return;
      if (key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      if (key === "y" && event.ctrlKey) { event.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [dirty, recovery, proposalBusy, undo, redo]);

  const leave = () => {
    onBack();
  };

  if (loading) return <div className="min-h-svh"><LoadingState /></div>;
  if (!recipe) return <div className="min-h-svh"><PageHeader title={t("editor.title")} onBack={onBack} /><div className="p-4 md:p-6"><EmptyState title={t("errors.load")} action={<Button onClick={() => void load()}>{t("common.retry")}</Button>} /></div></div>;
  const currentGeneration = generation?.recipe.id === recipe.id ? generation : null;
  const noCast = !recipe.blocks.some(block => block.type === "cast" && block.members.length > 0);
  const generationBlocked = noCast ? t("editor.addCharacterFirst") : !recipe.id ? t("editor.saveFirst") : findings.some(finding => finding.severity === "error") ? t("editor.fixErrorsFirst") : false;
  return <div className="min-h-svh">
    <section inert={!!recovery || proposalBusy} aria-label={t("editor.basicInfo")} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 text-xs text-muted-foreground md:px-6">
      <Button variant="ghost" size="sm" onClick={leave}><ArrowLeft />{t("editor.backToList")}</Button>
      <Input aria-label={t("editor.name")} placeholder={t("editor.name")} className="h-7 w-56" value={recipe.name} onChange={(event) => update({ ...recipe, name: event.target.value })} />
      <label className="flex min-w-0 shrink-0 items-center gap-2">{t("editor.tags")}<TagInput className="h-7 w-40" value={recipe.tags} onChange={(tags) => update({ ...recipe, tags })} placeholder={t("editor.tagsPlaceholder")} /></label>
      {findings.some((finding) => finding.severity === "error") ? <Badge variant="destructive">{t("common.error")}</Badge> : null}
      <div className="ml-auto flex items-center gap-2"><Button size="icon-sm" variant="ghost" aria-label={t("editor.undo")} title={t("editor.undo")} disabled={!history.canUndo} onClick={undo}><Undo2 /></Button><Button size="icon-sm" variant="ghost" aria-label={t("editor.redo")} title={t("editor.redo")} disabled={!history.canRedo} onClick={redo}><Redo2 /></Button><Button size="sm" variant="ghost" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}><Code2 />{t("editor.promptLint")}</Button><DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t("editor.title")} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setMetadataOpen((value) => !value)}><Code2 />{t("editor.notes")}</DropdownMenuItem>{recipe.id ? <DropdownMenuItem onClick={() => { if (versions) setVersions(null); else void showVersions(); }}><RotateCcw />{t("recipes.versions")}</DropdownMenuItem> : null}<DropdownMenuItem onClick={() => void validate()} disabled={busy}><ShieldCheck />{busy ? t("editor.checking") : t("editor.check")}</DropdownMenuItem><DropdownMenuItem onClick={() => void exportRecipe()}><Download />{t("common.export")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Button size="sm" variant="outline" disabled={busy || !dirty || !!recovery} onClick={() => void save()}>{busy ? <RotateCcw className="animate-spin" /> : <Save />}{busy ? t("common.saving") : t("common.save")}</Button><RecipeGenerateDialog key={recipe.id} client={client} onContinueFromGeneration={onContinueFromGeneration} recipe={withoutEmptyCast(recipe)} blocked={generationBlocked} onStateChange={setGeneration} onDone={generationDone} /></div>
    </section>
    {recovery ? <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-3 text-xs md:px-6"><span className="mr-auto">{t(recovery.recipe.version !== recipe.version ? "editor.draftConflict" : "editor.draftFound")}</span><Button size="xs" variant="outline" onClick={() => { const restored = withCastBlock(recovery.recipe); update(recovery.recipe.version !== recipe.version ? { ...restored, id: undefined, version: undefined, created_at: undefined, updated_at: undefined } : restored); setRecovery(null); }}>{t(recovery.recipe.version !== recipe.version ? "editor.recoverAsCopy" : "editor.recoverDraft")}</Button><Button size="xs" variant="ghost" onClick={() => { removeDraft(draftKey); setRecovery(null); }}>{t("editor.discardDraft")}</Button></div> : null}
    {(snapshotMissing || (recipe.source.startsWith("import:generation:") && recipe.blocks.some(block => block.type === "cast" && block.members.some(member => !member.character_snapshot)))) ? <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted-foreground md:px-6">{t("editor.missingCharacterSnapshot")}</p> : null}
    {history.storageError ? <p role="alert" className="px-4 py-2 text-xs text-destructive">{t("editor.draftStorageError")}</p> : null}
    {metadataOpen ? <div className="border-b border-border px-4 py-3 md:px-6"><label className="flex max-w-3xl flex-col gap-1.5 text-xs"><span className="font-medium text-foreground">{t("editor.notes")}</span><Textarea value={recipe.notes} onChange={(event) => update({ ...recipe, notes: event.target.value })} placeholder={t("editor.notesPlaceholder")} /></label></div> : null}
    <div inert={!!recovery || proposalBusy} className={cx("grid grid-cols-1 items-start gap-4 p-4 md:grid-cols-[11rem_minmax(0,1fr)] md:p-6", currentGeneration && "xl:grid-cols-[11rem_minmax(0,1fr)_minmax(20rem,0.9fr)]")}>
      <BlockPalette present={recipe.blocks.map((block) => block.type)} onAdd={appendBlock} />
      <main className="flex min-w-0 flex-col gap-4">
        {error ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive" role="alert">{error.startsWith("errors.") ? t(error) : error}</div> : null}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{t("editor.assemblyOrder", { count: recipe.blocks.length })}</span><Button size="xs" variant="ghost" onClick={sortBlocks}><Layers />{t("editor.standardOrderButton")}</Button></div>
          {recipe.blocks.map((block, index) => <EditableBlock key={`${block.type}-${index}`} block={block} rating={rating} client={client} open={open[index] ?? (block.type === "text")} canMoveUp={index > 0} canMoveDown={index < recipe.blocks.length - 1} onToggle={() => setOpen((current) => ({ ...current, [index]: !(current[index] ?? (block.type === "text")) }))} onChange={(next) => updateBlock(index, next)} onMove={(direction) => moveBlock(index, direction)} onRemove={() => removeBlock(index)} onSavePreset={() => openPresetDialog(block, index)} onPickPreset={() => setPick({ type: block.type, index })} characters={characters} presets={presets} />)}
        </div>
        {recipe.id ? <RecipeProposals client={client} recipeId={recipe.id} disabled={dirty || busy || !!recovery} onBusyChange={setProposalBusy} onApplied={stored => { initialize(withCastBlock(asRecipe(stored))); setComposed(null); setVersions(null); setError(null); }} onConflict={cause => setError(errorMessage(cause, "errors.VERSION_CONFLICT"))} /> : null}
        {versions ? <div className="flex flex-col gap-2 rounded-xl border border-border p-3"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">{t("recipes.versions")}</h2><Button size="icon-xs" variant="ghost" aria-label={t("common.close")} onClick={() => setVersions(null)}><RotateCcw /></Button></div>{versions.length ? versions.map((version) => <div className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-xs" key={version.version}><div className="flex min-w-0 flex-col"><strong>{t("recipes.version", { number: version.version })}</strong><span className="truncate text-muted-foreground">{version.note || ""}</span></div><Button size="xs" variant="outline" onClick={() => restoreVersion(version)}>{t("recipes.restore")}</Button></div>) : <span className="text-muted-foreground">{t("common.none")}</span>}</div> : null}
        {detailsOpen ? <Tabs defaultValue="prompt" className="min-w-0"><TabsList className="w-full"><TabsTrigger value="prompt" className="flex-1">{t("editor.prompt")}</TabsTrigger><TabsTrigger value="lint" className="flex-1">{t("editor.lint")}{findings.length ? <Badge variant={findings.some((finding) => finding.severity === "error") ? "destructive" : "secondary"} className="ml-1 h-4">{findings.length}</Badge> : null}</TabsTrigger></TabsList><TabsContent value="prompt"><PromptPreview composed={composed} loading={busy} /></TabsContent><TabsContent value="lint"><FindingList findings={findings} busy={busy} onFix={fixFinding} onFixAll={fixAll} /></TabsContent></Tabs> : null}
      </main>
      {currentGeneration ? <section aria-label={t("editor.currentResults")} className="order-first flex min-w-0 flex-col gap-3 md:col-span-2 xl:order-none xl:sticky xl:top-4 xl:col-span-1">
        <h2 className="text-sm font-medium">{t("editor.currentGeneration")}{currentGeneration.items.length ? <span className="ml-2 text-muted-foreground">{t("recipesExtra.imageCount", { count: currentGeneration.items.length })}</span> : null}</h2>
        {currentGeneration.busy ? <div role="status" className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 text-sm text-muted-foreground"><Loader2 className="size-8 animate-spin" />{t("editor.generatingImages", { count: currentGeneration.count })}</div> : null}
        {currentGeneration.error ? <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t(currentGeneration.error.replace(/^generationView\./, "generationView:"), { defaultValue: currentGeneration.error })}</p> : null}
        {currentGeneration.items.length ? <GenerationResults client={client} items={currentGeneration.items} large onContinueFromGeneration={onContinueFromGeneration} /> : null}
      </section> : null}
    </div>
    {recipe.id ? <GenerationHistory key={recipe.id} client={client} recipeId={recipe.id} tick={historyTick} onContinueFromGeneration={onContinueFromGeneration} /> : null}
    <BlockPicker client={client} type={pick?.type ?? null} replacing={pick?.index !== undefined} existing={pick?.index !== undefined ? recipe.blocks[pick.index] : undefined} onOpenChange={(isOpen) => { if (!isOpen) setPick(null); }} onPick={pickBlock} />
    <PresetDialog client={client} draft={presetDraft} characters={characters} onOpenChange={(isOpen) => { if (!isOpen) setPresetDraft(null); }} onSaved={(savedPreset) => { if (presetDraft) updateBlock(presetDraft.blockIndex, { ...recipe.blocks[presetDraft.blockIndex], preset_id: savedPreset.id }); setPresets((current) => [savedPreset, ...current]); setPresetDraft(null); }} />
  </div>;
}

function BlockPalette({ present, onAdd }: { present: BlockType[]; onAdd: (type: BlockType) => void }) {
  const { t } = useTranslation();
  const icons: Record<BlockType, React.ComponentType<{ className?: string }>> = { cast: Users, scene: ImageIcon, composition: Crop, outfit: Shirt, expression_pose: Smile, lighting: Sun, motif: Sparkle, style: Brush, nsfw: ShieldAlert, negative: Ban, settings: SlidersHorizontal, text: MessageCircle };
  const groups: { title: string; types: BlockType[] }[] = [{ title: t("editorPalette.content"), types: ["scene", "composition", "outfit", "expression_pose", "lighting", "motif", "text"] }, { title: t("editorPalette.adult"), types: ["nsfw"] }, { title: t("editorPalette.base"), types: ["style", "negative", "settings"] }];
  return <aside className="min-w-0"><Card className="sticky top-4 gap-0 py-3"><CardHeader className="px-3 pb-1"><CardTitle className="text-xs text-muted-foreground">{t("editor.blockPaletteTitle")}</CardTitle></CardHeader><CardContent className="flex flex-col gap-2 px-2">{groups.map((group) => <div key={group.title} role="group" aria-label={group.title} className="flex flex-col"><div className="px-2 pt-1 pb-0.5 text-[10px] tracking-wide text-muted-foreground/70 uppercase">{group.title}</div><div className="flex flex-row flex-wrap gap-0.5 md:flex-col md:flex-nowrap">{group.types.map((type) => { const Icon = icons[type]; const used = present.includes(type); return <button key={type} type="button" onClick={() => onAdd(type)} className={cx("group/row flex h-7 items-center gap-2 rounded-md px-2 text-[0.8rem] transition-colors hover:bg-muted md:w-full", used ? "text-foreground" : "text-muted-foreground hover:text-foreground")}><Icon className={cx("size-3.5 shrink-0", used ? "text-foreground" : "text-muted-foreground")} /><span className="flex-1 text-left">{t(BLOCK_LABEL_KEY[type])}</span>{used ? <><Check className="size-3 text-emerald-500 group-hover/row:hidden" /><Replace className="hidden size-3 text-muted-foreground group-hover/row:block" /></> : <Plus className="size-3 text-muted-foreground opacity-70" />}</button>; })}</div></div>)}</CardContent></Card></aside>;
}

function PromptField({ label, value, extra }: { label: string; value: string; extra?: React.ReactNode }) {
  return <div className="flex flex-col gap-1"><div className="flex items-center gap-2"><span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>{extra}<Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={label} title={label} disabled={!value} onClick={() => { void navigator.clipboard?.writeText(value); }}><Copy /></Button></div><pre className="max-h-48 overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap">{value || "—"}</pre></div>;
}

function PromptPreview({ composed, loading }: { composed: Composed | null; loading?: boolean }) {
  const { t } = useTranslation();
  if (loading && !composed) return <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><span className="size-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />{t("editor.composing")}</div>;
  if (!composed) return <p className="p-4 text-xs text-muted-foreground">{t("editor.noComposedResult")}</p>;
  const settings = `${composed.settings.width}×${composed.settings.height} · ${composed.settings.steps}${t("editor.stepsSuffix")} · scale ${composed.settings.scale} · rescale ${composed.settings.rescale} · ${composed.settings.sampler}/${composed.settings.schedule} · uc ${composed.settings.uc_preset} · quality ${composed.settings.quality_preset} · seed ${composed.settings.seed_policy === "fixed" ? composed.settings.seed ?? 0 : "random"}`;
  const all = [`BASE\n${composed.base_prompt}`, ...composed.characters.map((character, index) => `CHARACTER ${index + 1} (x ${character.x.toFixed(2)}, y ${character.y.toFixed(2)})\n${character.prompt}${character.uc ? `\nUC: ${character.uc}` : ""}`), `NEGATIVE\n${composed.negative}`, `SETTINGS\n${settings}`].join("\n\n");
  return <div className="flex flex-col gap-3"><div className="flex items-center gap-2"><Badge variant={composed.rating >= 1 ? "destructive" : "secondary"}>{t("editor.promptRating")} {composed.rating}</Badge>{composed.characters.length ? <Badge variant="outline">{t("editor.promptMembers")} {composed.characters.length}</Badge> : null}<Button size="xs" variant="outline" className="ml-auto" aria-label={t("editor.copyAll")} title={t("editor.copyAll")} onClick={() => { void navigator.clipboard?.writeText(all); }}><Copy />{t("editor.copyAll")}</Button></div><PromptField label={t("editor.promptBase")} value={composed.base_prompt} />{composed.characters.map((character, index) => <PromptField key={index} label={`${t("editor.promptCharacter")} ${index + 1}`} extra={<span className="font-mono text-[10px] text-muted-foreground">x {character.x.toFixed(2)} y {character.y.toFixed(2)}</span>} value={character.prompt + (character.uc ? `\nUC: ${character.uc}` : "")} />)}<PromptField label={t("editor.promptNegative")} value={composed.negative} /><PromptField label={t("editor.promptSettings")} value={settings} /></div>;
}

function EditableBlock({ block, rating, client, open, canMoveUp, canMoveDown, onToggle, onChange, onMove, onRemove, onSavePreset, onPickPreset, characters, presets }: { block: Block; rating: number; client?: StudioClient; open: boolean; canMoveUp: boolean; canMoveDown: boolean; onToggle: () => void; onChange: (block: Block) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void; onSavePreset: () => void; onPickPreset: () => void; characters: Character[]; presets: Preset[] }) {
  const { t } = useTranslation();
  const sourcePreset = block.preset_id ? presets.find((preset) => preset.id === block.preset_id) : undefined;
  return <Card className="gap-0 py-0">
    <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-label={`${t(BLOCK_LABEL_KEY[block.type])} ${open ? t("editor.collapse") : t("editor.expand")}`} aria-expanded={open} onClick={onToggle}>
        <ChevronDown className={cx("size-3.5 shrink-0 transition", open && "rotate-180")} />
        <Badge variant="outline" className="shrink-0"><BlockLabel type={block.type} /></Badge>
        {block.preset_id && block.type !== "cast" ? <Badge variant="secondary" className="max-w-32 shrink-0 truncate" title={sourcePreset ? presetName(sourcePreset) : `#${block.preset_id}`}>{sourcePreset ? presetName(sourcePreset) : `#${block.preset_id}`}</Badge> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{blockSummary(block)}</span>
      </button>
      {block.type !== "cast" ? <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button size="xs" variant="outline" onClick={onPickPreset}><ArrowLeftRight />{t("editor.replace")}</Button>
        <Button size="xs" variant="ghost" aria-label={`${t(BLOCK_LABEL_KEY[block.type])} ${t("editor.saveToPalette")}`} title={t("editor.savePresetTitle")} onClick={onSavePreset}><Save />{t("editor.saveBlock")}</Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`${t(BLOCK_LABEL_KEY[block.type])} ${t("editor.blockMenu")}`} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={!canMoveUp} onClick={() => onMove(-1)}><ArrowUp />{t("editor.moveUp")}</DropdownMenuItem><DropdownMenuItem disabled={!canMoveDown} onClick={() => onMove(1)}><ArrowDown />{t("editor.moveDown")}</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={onRemove}><Trash2 />{t("editor.removeBlock")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div> : null}
    </div>
    {open ? <CardContent className="border-t border-border px-3 py-3">{block.type === "cast" ? <CastEditor block={block} characters={characters} rating={rating} onChange={onChange} client={client} /> : <SharedBlockEditor block={block} onChange={onChange} characters={characters} />}</CardContent> : null}
  </Card>;
}

function toHistoryItem(item: StoredGalleryItem): GalleryViewItem {
  return { ...item, recipe_snapshot: JSON.stringify(item.recipe), characters: item.characters ?? [], anlas_cost: item.estimatedAnlas };
}

function GenerationHistory({ client, recipeId, tick, onContinueFromGeneration }: { client?: StudioClient; recipeId: number; tick: number; onContinueFromGeneration?: (draft: GenerationDraftFromImage) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = React.useState<GalleryViewItem[] | null>(null);
  const [refresh, setRefresh] = React.useState(0);
  const [open, setOpen] = React.useState<number | null>(null);
  const [blur, setBlur] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let alive = true;
    if (!client) { setItems([]); return () => { alive = false; }; }
    void Promise.allSettled([
      studioCall(client, "gallery.list", { recipeId, ratingMax: 2, limit: 120, offset: 0, sort: "newest" }),
      studioCall(client, "settings.get", {}),
    ]).then(([historyResult, settingsResult]) => {
      if (!alive) return;
      if (historyResult.status === "fulfilled") setItems(Array.isArray(historyResult.value.items) ? historyResult.value.items.map(toHistoryItem) : []);
      else setItems([]);
      if (settingsResult.status === "fulfilled") setBlur(settingsResult.value.blurSensitive);
    });
    return () => { alive = false; };
  }, [client, recipeId, tick, refresh]);
  React.useEffect(() => subscribeToStudio(client, event => {
    if (event.type === "settings.changed") setBlur(event.settings.blurSensitive);
    if (event.type === "workspace.changed" && event.entity === "gallery") setRefresh(value => value + 1);
  }), [client]);

  const scroll = (direction: -1 | 1) => ref.current?.scrollBy({ left: direction * Math.max(240, ref.current.clientWidth * 0.8), behavior: "smooth" });
  const rate = async (item: GalleryViewItem, patch: { score?: number | null; liked?: boolean; note?: string }) => {
    if (!client) return;
    const updated = toHistoryItem(await studioCall(client, "gallery.rate", { id: item.id, ...patch }));
    setItems(current => current?.map(value => value.id === updated.id ? updated : value) ?? null);
  };
  const remove = async (item: GalleryViewItem) => {
    if (!client) return;
    await studioCall(client, "gallery.delete", { id: item.id });
    setItems(current => current?.filter(value => value.id !== item.id) ?? null);
    setOpen(null);
  };
  const exportItem = async (item: GalleryViewItem, includeMetadata: boolean) => {
    if (client) await studioCall(client, "gallery.export", { id: item.id, includeMetadata });
  };

  return <section className="flex flex-col gap-2 border-t border-border px-4 py-3 md:px-6">
    <div className="flex items-center gap-2"><History className="size-4 text-muted-foreground" /><span className="text-sm font-medium">{t("editor.historyTitle")}</span><Badge variant="outline" className="h-4 px-1 font-mono text-[10px]">{items?.length ?? 0}</Badge><span className="ml-auto flex gap-1"><Button size="icon-xs" variant="ghost" onClick={() => scroll(-1)} aria-label={t("editor.historyPrevious")}><ArrowLeft /></Button><Button size="icon-xs" variant="ghost" onClick={() => scroll(1)} aria-label={t("editor.historyNext")}><ArrowRight /></Button></span></div>
    {items === null ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("common.loading")}</div> : items.length === 0 ? <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{t("editor.historyEmpty")}</p> : <div ref={ref} className="flex snap-x gap-2 overflow-x-auto pb-1">{items.map((item, index) => <button key={item.id} type="button" onClick={() => setOpen(index)} title={t("editor.historyImage", { id: item.id, seed: item.seed })} className="group relative h-40 shrink-0 snap-start overflow-hidden rounded-lg border border-border bg-muted transition-colors hover:border-primary focus-visible:border-primary focus-visible:outline-none"><Thumbnail src={item.url} alt={t("editor.historyImage", { id: item.id, seed: item.seed })} sizes="160px" className={cx("h-full w-auto object-cover", blur && item.rating >= 1 && "blur-md")} /><span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 font-mono text-[10px]">#{item.id} · {item.seed}</span>{item.score ? <span className="absolute top-1 right-1 rounded bg-background/80 px-1 font-mono text-[10px]">★{item.score}</span> : null}</button>)}</div>}
    {items ? <Lightbox onContinueFromGeneration={onContinueFromGeneration} items={items} index={open} blur={blur} onClose={() => setOpen(null)} onIndex={setOpen} onDelete={remove} onExport={exportItem} onRate={rate} onOpenRecipe={(id) => { window.location.hash = `#/recipe/${id}`; }} /> : null}
  </section>;
}
