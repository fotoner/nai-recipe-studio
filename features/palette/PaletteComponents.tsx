import * as React from "react";
import { presetName, presetNotes } from "@/i18n/preset-text";
import {
  Ban,
  Brush,
  Copy,
  Crop,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  Save,
  Search,
  Shirt,
  ShieldAlert,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Star,
  Sun,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { StudioClient, GalleryItem as StoredGalleryItem, StoredPreset } from "@/contracts/studio";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { studioCall, errorMessage } from "@/desktop/renderer/studio-client";
import { blockSummary, newBlock, type Block, type BlockType, type Character } from "@/features/shared/types";
import { usePaletteTranslation } from "./locale";
import { useTranslation } from "react-i18next";

export type PaletteExample = Pick<StoredGalleryItem, "id" | "recipe_id" | "seed" | "created_at" | "rating" | "url">;
export type PalettePreset = StoredPreset & { usage: number; examples: PaletteExample[] };
export type PresetDraft = { id?: number; type: BlockType; name: string; block: Block; tags: string[]; notes: string };
export type LibrarySort = "usage" | "usage_asc" | "newest" | "oldest";

export const ORDER: BlockType[] = ["scene", "composition", "outfit", "expression_pose", "lighting", "motif", "text", "style", "nsfw", "negative", "settings"];

export const BLOCK_ICON: Record<BlockType, React.ComponentType<{ className?: string }>> = {
  cast: Users,
  scene: ImageIcon,
  composition: Crop,
  outfit: Shirt,
  expression_pose: Smile,
  lighting: Sun,
  motif: Sparkles,
  style: Brush,
  nsfw: ShieldAlert,
  negative: Ban,
  settings: SlidersHorizontal,
  text: MessageCircle,
};

export function emptyPreset(type: BlockType): PresetDraft {
  return { type, name: "", block: newBlock(type), tags: [], notes: "" };
}

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-1", className)}>
    <Label className="text-[11px] text-muted-foreground">{label}{hint ? <span className="ml-1 font-normal opacity-70">{hint}</span> : null}</Label>
    {children}
  </div>;
}

/** The original palette uses a comma separated, compact tag field. */
export function TagInput({ value, onChange, placeholder, className }: { value: string[]; onChange: (value: string[]) => void; placeholder?: string; className?: string }) {
  const joined = value.join(", ");
  const commit = (raw: string) => {
    const next = raw.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (next.join(", ") !== joined) onChange(next);
  };
  return <Input key={joined} className={cn("h-8 font-mono text-xs", className)} defaultValue={joined} placeholder={placeholder} onBlur={(event) => commit(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />;
}

export function SortControl({ value, onChange, label }: { value: LibrarySort; onChange: (value: LibrarySort) => void; label: string }) {
  const { t } = usePaletteTranslation();
  const options: Array<[LibrarySort, string]> = [["usage", t("sortUsage")], ["usage_asc", t("sortUsageAsc")], ["newest", t("sortNewest")], ["oldest", t("sortOldest")]];
  return <Select value={value} onValueChange={(next) => { if (next) onChange(next as LibrarySort); }} items={options.map(([option, text]) => ({ value: option, label: text }))}>
    <SelectTrigger size="sm" aria-label={label} className="w-36"><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectContent>
  </Select>;
}

export function sortPresets(items: PalettePreset[], sort: LibrarySort): PalettePreset[] {
  return [...items].sort((a, b) => {
    if (sort === "usage") return b.usage - a.usage || b.id - a.id;
    if (sort === "usage_asc") return a.usage - b.usage || b.id - a.id;
    const left = a.created_at ?? "";
    const right = b.created_at ?? "";
    return sort === "newest" ? right.localeCompare(left) : left.localeCompare(right);
  });
}

function useDefaultStyleName() {
  const [name, setName] = React.useState("");
  React.useEffect(() => {
    try { setName(JSON.parse(localStorage.getItem("studio.default_style") ?? "null")?.name ?? ""); } catch { setName(""); }
  }, []);
  const setDefault = React.useCallback((nextName: string, block: unknown) => {
    try { localStorage.setItem("studio.default_style", JSON.stringify({ name: nextName, block })); } catch { /* local preference is optional */ }
    setName(nextName);
  }, []);
  return [name, setDefault] as const;
}

function ExampleStrip({ examples, onClick, title, name }: { examples: PaletteExample[]; onClick?: () => void; title?: string; name: string }) {
  const { t } = usePaletteTranslation();
  const example = examples[0];
  const box = cn("relative block shrink-0 aspect-3/4 w-full overflow-hidden bg-muted", onClick && "cursor-pointer");
  const content = example?.url ? <img src={example.url} alt={t("exampleAlt", { name })} loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : <span className="absolute inset-0 flex items-center justify-center text-muted-foreground"><ImageOff className="size-5" /></span>;
  const label = title ?? (example ? `#${example.id} seed ${example.seed}` : t("exampleNone"));
  return onClick ? <button type="button" onClick={onClick} className={box} title={label}>{content}</button> : <div className={box} title={label}>{content}</div>;
}

export function PresetCard({ preset, onEdit, onDuplicate, onRemove, isDefault, onDefault }: { preset: PalettePreset; onEdit: () => void; onDuplicate: () => void; onRemove: () => void; isDefault?: boolean; onDefault?: () => void }) {
  const { t: tp } = usePaletteTranslation();
  const Icon = BLOCK_ICON[preset.type];
  const canEdit = !preset.builtinId;
  return <div className={cn("group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/30", isDefault ? "border-primary" : "border-border")}>
    <ExampleStrip examples={preset.examples} onClick={canEdit ? onEdit : undefined} title={tp("editPreset")} name={presetName(preset)} />
    <div className="flex h-[9.25rem] min-w-0 shrink-0 flex-col gap-1.5 p-2.5">
      <div className="flex h-5 min-w-0 shrink-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={presetName(preset)}>{presetName(preset)}</span>
        {isDefault ? <Badge variant="secondary" className="h-4 shrink-0 gap-0.5 px-1 text-[10px]"><Star className="size-3 fill-current" /> {tp("default")}</Badge> : null}
        {preset.tags.includes("nsfw") ? <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[10px]">{tp("adult")}</Badge> : null}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{tp("usage", { count: preset.usage })}</span>
      </div>
      <p className="h-8 shrink-0 line-clamp-2 font-mono text-[11px] leading-4 text-muted-foreground" title={blockSummary(preset.block)}>{blockSummary(preset.block)}</p>
      <p className="h-8 shrink-0 line-clamp-2 text-[11px] leading-4 text-muted-foreground" title={presetNotes(preset)}>{presetNotes(preset)}</p>
      <div className="mt-auto flex h-6 min-w-0 shrink-0 items-center gap-1">
        <span className="flex min-w-0 flex-1 gap-1 overflow-hidden" title={preset.tags.join(", ")}>{preset.tags.slice(0, 3).map((tag) => <Badge key={tag} variant="secondary" className="h-4 px-1 text-[10px]">{tag}</Badge>)}</span>
        {canEdit ? <span className="ml-auto flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onDefault ? <Button size="icon-xs" variant="ghost" onClick={onDefault} title={tp("default")}><Star className={cn(isDefault && "fill-current text-amber-400")} /></Button> : null}
          {preset.usage ? <a href={`#/gallery?preset_id=${preset.id}&rating_max=2`} className={buttonVariants({ size: "icon-xs", variant: "ghost" })} aria-label={tp("gallery")} title={tp("gallery")}><Search /></a> : null}
          <Button size="icon-xs" variant="ghost" onClick={onEdit} aria-label={tp("editPreset")} title={tp("editPreset")}><Pencil /></Button>
          <Button size="icon-xs" variant="ghost" onClick={onDuplicate} aria-label={tp("duplicatePreset")} title={tp("duplicatePreset")}><Copy /></Button>
          <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={tp("deletePreset")} title={tp("deletePreset")}><Trash2 /></Button>
        </span> : null}
      </div>
    </div>
  </div>;
}

export function BlockDescription({ type }: { type: BlockType }) {
  const { t: tp } = usePaletteTranslation();
  const Icon = BLOCK_ICON[type];
  const examples = tp(`blockDescription.${type}.examples`, { returnObjects: true }) as unknown as string[];
  const caution = tp(`blockDescription.${type}.caution`, { defaultValue: "" });
  return <section className="rounded-xl border border-border bg-card p-3">
    <div className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" /><span className="text-sm font-medium">{tp(`block.${type}`)}</span><span className="text-xs text-muted-foreground">{tp(`blockDescription.${type}.summary`)}</span></div>
    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{tp(`blockDescription.${type}.detail`)}</p>
    <div className="mt-2 flex flex-wrap items-center gap-1"><span className="text-[10px] text-muted-foreground">{tp("descriptionExamples")}</span>{examples.map((example) => <code key={example} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">{example}</code>)}</div>
    {caution ? <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-500"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{caution}</p> : null}
  </section>;
}

function NumberInput({ value, onChange, step = 1, min, max, className }: { value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number; className?: string }) {
  return <Input className={cn("h-8", className)} type="number" step={step} min={min} max={max} value={value} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} />;
}

function StyleEditor({ block, onChange }: { block: Extract<Block, { type: "style" }>; onChange: (block: Extract<Block, { type: "style" }>) => void }) {
  const { t: tp } = usePaletteTranslation();
  const sum = block.artists.reduce((total, artist) => total + artist.weight, 0);
  return <div className="@container flex min-w-0 flex-col gap-2">
    {block.artists.map((artist, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-1.5 @sm:grid-cols-[minmax(0,1fr)_7rem_2.25rem_1.5rem]">
      <Input className="col-start-1 row-start-1 h-8 font-mono text-xs" aria-label={`${tp("styleArtistName")} ${index + 1}`} value={artist.name} onChange={(event) => onChange({ ...block, artists: block.artists.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
      <Slider className="col-start-1 row-start-2 min-w-0 @sm:col-start-2 @sm:row-start-1" aria-label={`${tp("styleWeight")} ${index + 1}`} min={0} max={2} step={0.05} value={artist.weight} onValueChange={(value) => onChange({ ...block, artists: block.artists.map((item, itemIndex) => itemIndex === index ? { ...item, weight: typeof value === "number" ? value : value[0] } : item) })} />
      <span className="col-start-2 row-start-2 text-right font-mono text-xs tabular-nums @sm:col-start-3 @sm:row-start-1">{artist.weight.toFixed(2)}</span>
      <Button size="icon-xs" variant="ghost" className="col-start-2 row-start-1 justify-self-end @sm:col-start-4" aria-label={`${tp("styleArtistName")} ${index + 1}`} onClick={() => onChange({ ...block, artists: block.artists.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 /></Button>
    </div>)}
    <div className="flex items-center gap-2"><Button size="xs" variant="outline" onClick={() => onChange({ ...block, artists: [...block.artists, { name: "", weight: 1 }] })}><Plus /> {tp("styleAddArtist")}</Button><span className={cn("text-xs", block.artists.length > 4 || sum > 3.5 ? "text-destructive" : "text-muted-foreground")}>{block.artists.length} · {sum.toFixed(2)}</span></div>
    <div className="grid gap-2 sm:grid-cols-2"><Field label={tp("styleYear")}><Input className="h-8 font-mono text-xs" value={block.year} onChange={(event) => onChange({ ...block, year: event.target.value })} /></Field><Field label={tp("styleQuality")}><TagInput value={block.quality} onChange={(quality) => onChange({ ...block, quality })} /></Field><Field label={tp("styleMinus")} className="sm:col-span-2"><TagInput value={block.minus} onChange={(minus) => onChange({ ...block, minus })} /></Field></div>
  </div>;
}

function TagBlockEditor({ block, onChange }: { block: Extract<Block, { tags: string[] }>; onChange: (block: Extract<Block, { tags: string[] }>) => void }) {
  const { t: tp } = usePaletteTranslation();
  return <div className="flex flex-col gap-2"><Field label={tp("genericBlock")}><TagInput value={block.tags} onChange={(tags) => onChange({ ...block, tags })} /></Field><Field label={tp("tagText")} hint={tp("tagTextHint")}><Textarea className="min-h-16 font-mono text-xs" value={block.text} onChange={(event) => onChange({ ...block, text: event.target.value })} /></Field></div>;
}

function NegativeEditor({ block, onChange }: { block: Extract<Block, { type: "negative" }>; onChange: (block: Extract<Block, { type: "negative" }>) => void }) {
  const { t: tp } = usePaletteTranslation();
  const rating = block.rating ?? 0;
  return <div className="flex flex-col gap-2"><Field label={tp("negativeRating")}><div className="flex gap-1">{[0, 1, 2].map((value) => <Button key={value} type="button" size="xs" variant={rating === value ? "secondary" : "ghost"} onClick={() => onChange({ ...block, rating: value })}>{value}</Button>)}</div></Field><div className="grid gap-2 sm:grid-cols-[10rem_1fr]"><Field label={tp("negativeBase")}><Select value={block.base_preset} onValueChange={(value) => { if (value) onChange({ ...block, base_preset: value as Extract<Block, { type: "negative" }>["base_preset"] }); }} items={["heavy", "light", "none"].map((value) => ({ value, label: value }))}><SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["heavy", "light", "none"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field><Field label={tp("negativeExtra")}><TagInput value={block.extra} onChange={(extra) => onChange({ ...block, extra })} /></Field></div></div>;
}

function NsfwEditor({ block, onChange }: { block: Extract<Block, { type: "nsfw" }>; onChange: (block: Extract<Block, { type: "nsfw" }>) => void }) {
  const { t: tp } = usePaletteTranslation();
  return <Field label={tp("nsfwTags")}><TagInput value={block.explicit_tags} onChange={(explicit_tags) => onChange({ ...block, explicit_tags })} /></Field>;
}

const SAMPLERS = ["k_euler_ancestral", "k_euler", "k_dpmpp_2m", "k_dpmpp_2s_ancestral", "k_dpmpp_sde"];
const SCHEDULES = ["karras", "native", "exponential", "polyexponential"];

function SettingsEditor({ block, onChange }: { block: Extract<Block, { type: "settings" }>; onChange: (block: Extract<Block, { type: "settings" }>) => void }) {
  const { t: tp } = usePaletteTranslation();
  return <div className="flex flex-col gap-2"><div className="grid grid-cols-2 gap-2 sm:grid-cols-5"><Field label={tp("settingsSize")}><div className="flex gap-1"><NumberInput value={block.width} step={64} onChange={(width) => onChange({ ...block, width })} /><NumberInput value={block.height} step={64} onChange={(height) => onChange({ ...block, height })} /></div></Field><Field label={tp("settingsSteps")}><NumberInput value={block.steps} min={1} max={50} onChange={(steps) => onChange({ ...block, steps })} /></Field><Field label={tp("settingsScale")}><NumberInput value={block.scale} step={0.1} min={0} max={10} onChange={(scale) => onChange({ ...block, scale })} /></Field><Field label={tp("settingsRescale")}><NumberInput value={block.rescale} step={0.05} min={0} max={1} onChange={(rescale) => onChange({ ...block, rescale })} /></Field></div><div className="grid gap-2 sm:grid-cols-4"><Field label={tp("settingsSampler")}><Select value={block.sampler} onValueChange={(value) => value && onChange({ ...block, sampler: value })} items={SAMPLERS.map((value) => ({ value, label: value }))}><SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{SAMPLERS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field><Field label={tp("settingsSchedule")}><Select value={block.schedule} onValueChange={(value) => value && onChange({ ...block, schedule: value })} items={SCHEDULES.map((value) => ({ value, label: value }))}><SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{SCHEDULES.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field><Field label={tp("settingsQuality")}><Select value={block.quality_preset} onValueChange={(value) => value && onChange({ ...block, quality_preset: value as Extract<Block, { type: "settings" }>["quality_preset"] })} items={["none", "standard"].map((value) => ({ value, label: value }))}><SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["none", "standard"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field><Field label={tp("settingsUc")}><Select value={block.uc_preset} onValueChange={(value) => value && onChange({ ...block, uc_preset: value as Extract<Block, { type: "settings" }>["uc_preset"] })} items={["heavy", "light", "none", "human_focus"].map((value) => ({ value, label: value }))}><SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["heavy", "light", "none", "human_focus"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field></div><Field label={tp("settingsSeedPolicy")}><div className="flex items-center gap-2"><div className="flex gap-1">{(["random", "fixed"] as const).map((policy) => <Button key={policy} type="button" size="xs" variant={block.seed_policy === policy ? "secondary" : "ghost"} onClick={() => onChange({ ...block, seed_policy: policy })}>{tp(policy)}</Button>)}</div>{block.seed_policy === "fixed" ? <><NumberInput className="w-40 font-mono text-xs" value={block.seed ?? 0} onChange={(seed) => onChange({ ...block, seed })} /><span className="text-xs text-muted-foreground">{tp("settingsSeed")}</span></> : null}</div></Field></div>;
}

function TextEditor({ block, onChange }: { block: Extract<Block, { type: "text" }>; onChange: (block: Extract<Block, { type: "text" }>) => void }) {
  const { t: tp } = usePaletteTranslation();
  const kinds = ["speech", "sound", "motion"] as const;
  const labels = { speech: tp("textKindSpeech"), sound: tp("textKindSound"), motion: tp("textKindMotion") };
  return <div className="flex min-w-0 flex-col gap-3"><div className="flex flex-wrap gap-1">{kinds.map((kind) => <Button key={kind} type="button" size="sm" variant="outline" onClick={() => onChange({ ...block, entries: [...block.entries, { kind, text: "" }] })}><Plus /> {labels[kind]}</Button>)}</div>{block.entries.length === 0 ? <p className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">{tp("textEmpty")}</p> : null}{block.entries.map((entry, index) => <div key={index} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"><div className="flex items-center gap-2"><MessageCircle className="size-4 shrink-0 text-muted-foreground" /><span className="text-xs text-muted-foreground">{tp("textLine", { number: index + 1 })}</span><Select value={entry.kind} onValueChange={(value) => value && onChange({ ...block, entries: block.entries.map((item, itemIndex) => itemIndex === index ? { ...item, kind: value as typeof entry.kind } : item) })} items={kinds.map((kind) => ({ value: kind, label: labels[kind] }))}><SelectTrigger size="sm" className="w-28"><SelectValue /></SelectTrigger><SelectContent>{kinds.map((kind) => <SelectItem key={kind} value={kind}>{labels[kind]}</SelectItem>)}</SelectContent></Select><Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label={tp("textDelete")} onClick={() => onChange({ ...block, entries: block.entries.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 /></Button></div><Textarea aria-label={tp("textLine", { number: index + 1 })} rows={2} value={entry.text} onChange={(event) => onChange({ ...block, entries: block.entries.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item) })} /></div>)}</div>;
}

type CastMember = Extract<Block, { type: "cast" }>["members"][number];
function CastEditor({ block, characters, onChange }: { block: Extract<Block, { type: "cast" }>; characters: Character[]; onChange: (block: Extract<Block, { type: "cast" }>) => void }) {
  const { t: tp } = usePaletteTranslation();
  const add = () => { const first = characters[0]; if (!first?.id) return; onChange({ ...block, members: [...block.members, { character_id: first.id, x: first.default_x, y: first.default_y, traits: [...first.fixed_traits], outfit: [], expression: [], uc: [], interactions: [] }] }); };
  const patchMember = (index: number, patch: Partial<CastMember>) => onChange({ ...block, members: block.members.map((member, memberIndex) => memberIndex === index ? { ...member, ...patch } : member) });
  return <div className="flex flex-col gap-3"><div className="flex items-center justify-between"><span className="text-sm font-medium">{tp("castMembers")}</span><Button type="button" size="xs" variant="outline" onClick={add} disabled={!characters.length}><Plus /> {tp("castAdd")}</Button></div>{block.members.length === 0 ? <p className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">{tp("castEmpty")}</p> : null}{block.members.map((member, index) => <div key={`${member.character_id}-${index}`} className="flex flex-col gap-2 rounded-lg border border-border p-3"><div className="flex items-center gap-2"><Select value={String(member.character_id)} onValueChange={(value) => { const character = characters.find((item) => String(item.id) === value); if (value) patchMember(index, { character_id: Number(value), x: character?.default_x ?? member.x, y: character?.default_y ?? member.y }); }} items={characters.filter((character): character is Character & { id: number } => typeof character.id === "number").map((character) => ({ value: String(character.id), label: character.display_name || character.tag }))}><SelectTrigger className="flex-1"><SelectValue /></SelectTrigger><SelectContent>{characters.filter((character): character is Character & { id: number } => typeof character.id === "number").map((character) => <SelectItem key={character.id} value={String(character.id)}>{character.display_name || character.tag}</SelectItem>)}</SelectContent></Select><Button type="button" size="icon-xs" variant="ghost" aria-label={tp("castRemove")} onClick={() => onChange({ ...block, members: block.members.filter((_, memberIndex) => memberIndex !== index) })}><Trash2 /></Button></div><div className="grid gap-2 sm:grid-cols-2"><Field label="X"><NumberInput value={member.x} min={0} max={1} step={0.05} onChange={(x) => patchMember(index, { x })} /></Field><Field label="Y"><NumberInput value={member.y} min={0} max={1} step={0.05} onChange={(y) => patchMember(index, { y })} /></Field><Field label={tp("castTraits")}><TagInput value={member.traits} onChange={(traits) => patchMember(index, { traits })} /></Field><Field label={tp("castOutfit")}><TagInput value={member.outfit} onChange={(outfit) => patchMember(index, { outfit })} /></Field><Field label={tp("castExpression")}><TagInput value={member.expression} onChange={(expression) => patchMember(index, { expression })} /></Field><Field label={tp("castNegative")}><TagInput value={member.uc} onChange={(uc) => patchMember(index, { uc })} /></Field></div></div>)}</div>;
}

export function BlockEditor({ block, characters, onChange }: { block: Block; characters: Character[]; onChange: (block: Block) => void }) {
  if (block.type === "style") return <StyleEditor block={block} onChange={onChange} />;
  if (block.type === "negative") return <NegativeEditor block={block} onChange={onChange} />;
  if (block.type === "settings") return <SettingsEditor block={block} onChange={onChange} />;
  if (block.type === "nsfw") return <NsfwEditor block={block} onChange={onChange} />;
  if (block.type === "text") return <TextEditor block={block} onChange={onChange} />;
  if (block.type === "cast") return <CastEditor block={block} characters={characters} onChange={onChange} />;
  return <TagBlockEditor block={block} onChange={onChange} />;
}

export function PresetDialog({ client, draft, characters, onOpenChange, onSaved }: { client?: StudioClient; draft: PresetDraft | null; characters: Character[]; onOpenChange: (open: boolean) => void; onSaved: (preset: StoredPreset) => void }) {
  const { t } = useTranslation();
  const { t: tp } = usePaletteTranslation();
  const [current, setCurrent] = React.useState<PresetDraft | null>(draft);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { setCurrent(draft); setError(null); }, [draft]);
  const save = async () => {
    if (!client || !current || !current.name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await studioCall(client, "presets.save", { preset: { id: current.id, type: current.type, name: current.name.trim(), block: current.block, tags: current.tags, notes: current.notes } });
      onSaved(saved); onOpenChange(false);
    } catch (cause) { const key = errorMessage(cause, "errors.save"); setError(key.startsWith("errors.") ? t(key) : tp("errorSave")); }
    finally { setBusy(false); }
  };
  return <Dialog open={!!draft} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[92svh] flex-col gap-3 overflow-hidden sm:max-w-2xl"><DialogHeader><DialogTitle>{current?.id ? tp("editPreset") : t("common.new")} · {current ? tp(`block.${current.type}`) : ""}</DialogTitle><DialogDescription>{tp("dialogDescription")}</DialogDescription></DialogHeader>{error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}{current ? <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"><div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr]"><Field label={tp("fieldName")}><Input className="h-8" value={current.name} onChange={(event) => setCurrent({ ...current, name: event.target.value })} autoFocus /><span className="sr-only">{tp("fieldName")}</span></Field><Field label={tp("fieldTags")} hint={tp("fieldTagsHint")}><TagInput value={current.tags} onChange={(tags) => setCurrent({ ...current, tags })} /></Field></div><Field label={tp("fieldNotes")}><Textarea rows={2} value={current.notes} onChange={(event) => setCurrent({ ...current, notes: event.target.value })} placeholder={tp("fieldNotesPlaceholder")} /></Field><div className="rounded-lg border border-border p-3"><h3 className="mb-2 text-xs font-medium text-muted-foreground">{tp("blockEditor")}</h3><BlockEditor block={current.block} characters={characters} onChange={(block) => setCurrent({ ...current, block })} /></div></div> : null}<DialogFooter><Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button size="sm" disabled={busy || !current?.name.trim()} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Save />}{tp("save")}</Button></DialogFooter></DialogContent></Dialog>;
}

export function StyleCompare({ presets }: { presets: PalettePreset[] }) {
  const { t: tp } = usePaletteTranslation();
  const [a, setA] = React.useState(presets[0]?.name ?? "");
  const [b, setB] = React.useState(presets[1]?.name ?? presets[0]?.name ?? "");
  if (presets.length < 2) return null;
  const left = presets.find((preset) => preset.name === a)?.block;
  const right = presets.find((preset) => preset.name === b)?.block;
  if (!left || left.type !== "style" || !right || right.type !== "style") return null;
  const rows: Array<[string, string[], string[]]> = [[tp("styleArtists"), left.artists.map((artist) => `${artist.name} ${artist.weight}`), right.artists.map((artist) => `${artist.name} ${artist.weight}`)], [tp("styleYear"), [left.year], [right.year]], [tp("styleQuality"), left.quality, right.quality], [tp("styleMinus"), left.minus, right.minus]];
  return <section className="rounded-xl border border-border bg-card p-3"><div className="flex items-center gap-2 text-sm font-medium"><Brush className="size-4 text-muted-foreground" />{tp("compare")}</div><div className="mt-2 flex items-center gap-2"><Select value={a} onValueChange={(value) => value && setA(value)} items={presets.map((preset) => ({ label: preset.name, value: preset.name }))}><SelectTrigger className="flex-1" size="sm"><SelectValue /></SelectTrigger><SelectContent>{presets.map((preset) => <SelectItem key={preset.name} value={preset.name}>{presetName(preset)}</SelectItem>)}</SelectContent></Select><span className="text-xs text-muted-foreground">→</span><Select value={b} onValueChange={(value) => value && setB(value)} items={presets.map((preset) => ({ label: preset.name, value: preset.name }))}><SelectTrigger className="flex-1" size="sm"><SelectValue /></SelectTrigger><SelectContent>{presets.map((preset) => <SelectItem key={preset.name} value={preset.name}>{presetName(preset)}</SelectItem>)}</SelectContent></Select></div><div className="mt-1">{rows.map(([label, before, after]) => <div key={label} className="flex flex-col gap-1 border-t border-border py-2 first:border-t-0"><span className="text-[11px] text-muted-foreground">{label}</span>{before.join("|") === after.join("|") ? <span className="text-xs text-muted-foreground">{tp("unchanged")}</span> : <div className="flex flex-wrap gap-1">{before.filter((value) => !after.includes(value)).map((value) => <Badge key={`-${value}`} variant="destructive" className="font-mono text-[10px]">- {value}</Badge>)}{after.filter((value) => !before.includes(value)).map((value) => <Badge key={`+${value}`} variant="secondary" className="font-mono text-[10px]">+ {value}</Badge>)}</div>}</div>)}</div></section>;
}

export { useDefaultStyleName };
