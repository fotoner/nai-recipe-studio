import { resolveMemberCharacter } from "@/core/recipe/characters";
import { useCastTranslation } from "./locale";
import * as React from "react";
import { ChevronDown, Lock, Shirt, Smile, Swords, Trash2, TriangleAlert } from "lucide-react";
import type { StudioClient } from "@/contracts/studio";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { allowsNsfwCast } from "@/lib/policy";
import { applyMemberPreset, dealAct } from "@/lib/member-presets";
import { layoutFor, type LayoutPreset } from "@/core/characters/layout";
import { Field, TagInput } from "@/features/shared/ui";
import type { Block, CastMember, Character } from "@/features/shared/types";
import { BlockPicker } from "./BlockPicker";
import { CharacterPicker } from "./CharacterPicker";

export type CastBlock = Extract<Block, { type: "cast" }>;

const PRESETS: LayoutPreset[] = ["solo", "side_by_side", "front_back", "over_shoulder_pair", "circle"];
const LAYOUT_LABEL: Record<LayoutPreset, string> = { solo: "layoutSolo", side_by_side: "layoutSide", front_back: "layoutDepth", over_shoulder_pair: "layoutShoulder", circle: "layoutCircle", custom: "layoutCustom" };
const QUICK_INTERACTIONS = ["mutual#hug", "source#hug", "target#hug", "mutual#holding hands", "source#headpat", "target#headpat"];
const AGE_BADGE: Record<Character["age_flag"], { label: string; variant: "secondary" | "outline" }> = {
  adult: { label: "adult", variant: "secondary" },
  minor: { label: "minor", variant: "outline" },
  unknown: { label: "unknown", variant: "outline" },
};

export function CastEditor({ block, characters, rating, onChange, client }: { block: CastBlock; characters: Character[]; rating: number; onChange: (block: CastBlock) => void; client?: StudioClient }) {
  const { t } = useCastTranslation();
  const [open, setOpen] = React.useState<number | null>(0);
  const [pick, setPick] = React.useState<{ member: number; type: "outfit" | "expression_pose" } | null>(null);
  const [act, setAct] = React.useState<{ source: number; target: number } | null>(null);
  const [actPicking, setActPicking] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const blockRef = React.useRef(block);
  const byId = React.useMemo(() => new Map(characters.map(character => [character.id ?? -1, character])), [characters]);
  const members = block.members;
  React.useEffect(() => { blockRef.current = block; }, [block]);

  const setMembers = (next: CastMember[], preset?: LayoutPreset) => onChange({ ...block, members: next, layout_preset: preset ?? (next.length <= 1 ? "solo" : block.layout_preset === "solo" ? "side_by_side" : block.layout_preset) });
  const patch = (index: number, value: Partial<CastMember>) => setMembers(members.map((member, memberIndex) => memberIndex === index ? { ...member, ...value } : member));
  const applyLayout = (preset: LayoutPreset, list: CastMember[] = members) => {
    const points = layoutFor(preset, list.length);
    setMembers(list.map((member, index) => ({ ...member, x: points[index]?.x ?? member.x, y: points[index]?.y ?? member.y })), preset);
  };
  const add = (id: number) => {
    const character = byId.get(id);
    if (!character || character.id === undefined || members.length >= 6 || members.some(member => member.character_id === id)) return;
    const next = [...members, { character_id: character.id, x: character.default_x, y: character.default_y, traits: [], outfit: [], expression: [], uc: [], interactions: [] }];
    const preset: LayoutPreset = next.length === 1 ? "solo" : block.layout_preset === "solo" ? "side_by_side" : block.layout_preset;
    if (block.layout_preset === "custom") setMembers(next, "custom"); else applyLayout(preset, next);
    setOpen(next.length - 1);
  };
  const drag = (index: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const update = (clientX: number, clientY: number) => {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return;
      const point = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
      const current = blockRef.current;
      onChange({ ...current, layout_preset: "custom", members: current.members.map((member, memberIndex) => memberIndex === index ? { ...member, x: point((clientX - rect.left) / rect.width), y: point((clientY - rect.top) / rect.height) } : member) });
    };
    update(event.clientX, event.clientY);
    const onMove = (move: PointerEvent) => update(move.clientX, move.clientY);
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const blocked = rating >= 1 ? members.filter(member => !allowsNsfwCast(resolveMemberCharacter(member, byId.get(member.character_id)))) : [];

  return <div className="@container flex flex-col gap-3">
    {rating >= 1 && blocked.length > 0 ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>{t("blockedTitle", { rating })}</AlertTitle><AlertDescription>{t("blockedDescription", { characters: blocked.map(member => byId.get(member.character_id)?.tag ?? "?").join(", ") })}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2"><CharacterPicker characters={characters} selectedIds={members.map(member => member.character_id)} onAdd={add} /><span className="text-xs text-muted-foreground">{members.length}/6</span>{members.length >= 2 ? <Button size="xs" variant="outline" onClick={() => setAct({ source: 0, target: 1 })} title={t("allocateHelp")}><Swords /> {t("allocate")}</Button> : null}<label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">{t("leakGuard")}<Switch size="sm" checked={block.auto_leak_guard} onCheckedChange={value => onChange({ ...block, auto_leak_guard: value })} /></label></div>
    <div className="flex flex-col gap-3 @sm:flex-row"><div className="mx-auto w-full max-w-52 @sm:mx-0 @sm:w-40 @sm:shrink-0"><div ref={boxRef} className="relative aspect-3/4 w-full overflow-hidden rounded-lg border border-dashed border-border bg-muted/30"><div className="absolute inset-x-0 top-1/2 border-t border-border/40" /><div className="absolute inset-y-0 left-1/2 border-l border-border/40" />{members.map((member, index) => { const character = resolveMemberCharacter(member, byId.get(member.character_id)); return <button key={index} type="button" onPointerDown={drag(index)} style={{ left: `${member.x * 100}%`, top: `${member.y * 100}%` }} className="absolute -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground shadow active:cursor-grabbing" title={`${character?.display_name || character?.tag} (${member.x.toFixed(2)},${member.y.toFixed(2)})`}>{index + 1}</button>; })}{members.length === 0 ? <p className="absolute inset-0 grid place-content-center text-[11px] text-muted-foreground">{t("noMembers")}</p> : null}</div><div className="mt-2 flex flex-wrap gap-1">{PRESETS.map(preset => <Button key={preset} size="xs" variant={block.layout_preset === preset ? "secondary" : "ghost"} onClick={() => applyLayout(preset)} disabled={members.length === 0}>{t(LAYOUT_LABEL[preset])}</Button>)}</div></div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">{members.map((member, index) => { const character = resolveMemberCharacter(member, byId.get(member.character_id)); const age = AGE_BADGE[character?.age_flag ?? "unknown"]; const isOpen = open === index; return <div key={index} className="rounded-lg border border-border"><div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1.5"><span className="grid size-5 shrink-0 place-content-center rounded-full bg-muted text-[10px]">{index + 1}</span><span className="min-w-0 truncate text-sm">{character?.display_name || character?.tag || `#${member.character_id}`}</span><Badge variant={age.variant} className="shrink-0 gap-0.5">{character?.locked ? <Lock /> : null}{t(age.label)}</Badge><span className="ml-auto hidden shrink-0 font-mono text-[10px] text-muted-foreground @sm:inline">{member.x.toFixed(2)},{member.y.toFixed(2)}</span><Button size="icon-xs" variant="ghost" className="shrink-0" title={t("outfitTitle")} aria-label={`${character?.display_name || character?.tag || member.character_id} ${t("outfit")}`} onClick={() => setPick({ member: index, type: "outfit" })}><Shirt /></Button><Button size="icon-xs" variant="ghost" className="shrink-0" title={t("expressionTitle")} aria-label={`${character?.display_name || character?.tag || member.character_id} ${t("expression")}`} onClick={() => setPick({ member: index, type: "expression_pose" })}><Smile /></Button><Button size="icon-xs" variant="ghost" className="shrink-0" aria-label={`${character?.display_name || character?.tag || member.character_id} ${t("details")}`} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : index)}><ChevronDown className={isOpen ? "rotate-180 transition" : "transition"} /></Button><Button size="icon-xs" variant="ghost" className="shrink-0" aria-label={`${character?.display_name || character?.tag || member.character_id} ${t("remove")}`} onClick={() => setMembers(members.filter((_, memberIndex) => memberIndex !== index))}><Trash2 /></Button></div>{isOpen ? <div className="grid gap-2 border-t border-border px-2 py-2 @xl:grid-cols-2"><Field label={t("field_traits")}><TagInput value={member.traits} onChange={value => patch(index, { traits: value })} placeholder={t("fixedTraitsHint")} /></Field><Field label={t("field_outfit")}><TagInput value={member.outfit} onChange={value => patch(index, { outfit: value })} /></Field><Field label={t("field_expression")}><TagInput value={member.expression} onChange={value => patch(index, { expression: value })} /></Field><Field label={t("field_uc")} hint={t("memberNegative")}><TagInput value={member.uc} onChange={value => patch(index, { uc: value })} /></Field><Field label={t("field_interactions")} hint="source#/target#/mutual#" className="@xl:col-span-2"><TagInput value={member.interactions} onChange={value => patch(index, { interactions: value })} /></Field><div className="flex flex-wrap gap-1 @xl:col-span-2">{QUICK_INTERACTIONS.map(interaction => <Button key={interaction} size="xs" variant="ghost" className="font-mono text-[10px]" onClick={() => patch(index, { interactions: member.interactions.includes(interaction) ? member.interactions : [...member.interactions, interaction] })}>+{interaction}</Button>)}</div></div> : null}</div>; })}</div>
    </div>
    {act ? <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-xs"><span className="text-muted-foreground">{t("source")}</span><select className="h-7 rounded-md border border-border bg-background px-1" aria-label={t("actionSource")} value={act.source} onChange={event => setAct({ ...act, source: Number(event.target.value) })}>{members.map((member, index) => <option key={index} value={index}>{index + 1}. {byId.get(member.character_id)?.display_name || byId.get(member.character_id)?.tag}</option>)}</select><span className="text-muted-foreground">{t("target")}</span><select className="h-7 rounded-md border border-border bg-background px-1" aria-label={t("actionTarget")} value={act.target} onChange={event => setAct({ ...act, target: Number(event.target.value) })}>{members.map((member, index) => <option key={index} value={index}>{index + 1}. {byId.get(member.character_id)?.display_name || byId.get(member.character_id)?.tag}</option>)}</select><span className="text-muted-foreground">{t("mutualHint")}</span><Button size="xs" className="ml-auto" onClick={() => setActPicking(true)}>{t("chooseAction")}</Button><Button size="xs" variant="ghost" onClick={() => setAct(null)}>{t("close")}</Button></div> : null}
    <BlockPicker client={client} type={pick ? pick.type : null} title={pick ? `${byId.get(members[pick.member]?.character_id)?.display_name || byId.get(members[pick.member]?.character_id)?.tag || ""} · ${t(pick.type === "outfit" ? "outfit" : "expression")}` : undefined} hideAdult={pick ? !allowsNsfwCast(byId.get(members[pick.member]?.character_id)) : false} onOpenChange={openState => { if (!openState) setPick(null); }} onPick={selected => { if (pick) patch(pick.member, applyMemberPreset(members[pick.member], selected)); }} />
    <BlockPicker client={client} type={act && actPicking ? "nsfw" : null} title={t("allocateTitle")} hideAdult={members.some(member => !allowsNsfwCast(resolveMemberCharacter(member, byId.get(member.character_id))))} onOpenChange={openState => { if (!openState) setActPicking(false); }} onPick={selected => { if (!act || selected.type !== "nsfw") return; const same = act.source === act.target; setMembers(dealAct(selected.explicit_tags, members, same ? null : act.source, same ? null : act.target).members); setActPicking(false); }} />
  </div>;
}

export default CastEditor;
