import * as React from "react";
import { ImageOff, Images, Pencil, Trash2 } from "lucide-react";
import type { StoredCharacter, GalleryItem as StoredGalleryItem } from "@/contracts/studio";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Character } from "@/features/shared/types";
import { useCharactersTranslation } from "./locale";

export type CharacterExample = Pick<StoredGalleryItem, "id" | "recipe_id" | "seed" | "created_at" | "rating" | "url">;
export type CharacterCardData = StoredCharacter & { examples: CharacterExample[]; generation_count: number };
export type CharacterView = "cards" | "table";

export const AGE_LABEL: Record<Character["age_flag"], string> = {
  adult: "adult",
  minor: "minor",
  unknown: "unknown",
};

export function emptyCharacter(): Character {
  return { tag: "", series: "", display_name: "", gender: "girl", age_flag: "unknown", locked: false, fixed_traits: [], default_x: 0.5, default_y: 0.5, notes: "" };
}

function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-1", className)}><Label className="text-[11px] text-muted-foreground">{label}{hint ? <span className="ml-1 font-normal opacity-70">{hint}</span> : null}</Label>{children}</div>;
}

function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (value: string[]) => void; placeholder?: string }) {
  const joined = value.join(", ");
  const commit = (raw: string) => { const next = raw.split(",").map((tag) => tag.trim()).filter(Boolean); if (next.join(", ") !== joined) onChange(next); };
  return <Input key={joined} className="h-8 font-mono text-xs" defaultValue={joined} placeholder={placeholder} onBlur={(event) => commit(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />;
}

function Example({ example, alt, sizes, className }: { example: CharacterExample; alt: string; sizes: string; className?: string }) {
  const inner = example.url ? <img src={example.url} alt={alt} sizes={sizes} loading="lazy" decoding="async" className="h-full w-full object-cover" /> : <span className="absolute inset-0 flex items-center justify-center text-muted-foreground"><ImageOff className="size-5" /></span>;
  const box = cn("relative block shrink-0 overflow-hidden bg-muted", className);
  return example.recipe_id ? <a href={`#/recipe/${example.recipe_id}`} className={box} title={`#${example.id} seed ${example.seed}`}>{inner}</a> : <div className={box} title={`#${example.id} seed ${example.seed}`}>{inner}</div>;
}

export function CharacterCard({ character, onEdit, onRemove }: { character: CharacterCardData; onEdit: (character: CharacterCardData) => void; onRemove: (character: CharacterCardData) => void }) {
  const { t: tp } = useCharactersTranslation();
  const [main, ...rest] = character.examples.slice(0, 4);
  return <div className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/30">
    {main ? <Example example={main} alt={character.tag} sizes="(min-width: 1536px) calc((100vw - 316px) / 6), (min-width: 1280px) calc((100vw - 304px) / 5), (min-width: 1024px) calc((100vw - 280px) / 3), (min-width: 768px) calc((100vw - 268px) / 2), calc((100vw - 44px) / 2)" className="aspect-3/4 w-full" /> : <div className="flex aspect-3/4 w-full shrink-0 flex-col items-center justify-center gap-1 bg-muted text-muted-foreground"><ImageOff className="size-6" /><span className="text-[11px]">{tp("generatedNone")}</span></div>}
    <div className="grid shrink-0 grid-cols-3 gap-px bg-border">{rest.map((example) => <Example key={example.id} example={example} alt={character.tag} sizes="(min-width: 1536px) calc((100vw - 316px) / 18), (min-width: 1280px) calc((100vw - 304px) / 15), (min-width: 1024px) calc((100vw - 280px) / 9), (min-width: 768px) calc((100vw - 268px) / 6), calc((100vw - 44px) / 6)" className="aspect-square" />)}{Array.from({ length: Math.max(0, 3 - rest.length) }).map((_, index) => <div key={`pad${index}`} aria-hidden="true" className="aspect-square bg-muted" />)}</div>
    <div className="flex h-[5.5rem] min-w-0 shrink-0 flex-col gap-1.5 p-2.5"><div className="flex h-4 min-w-0 shrink-0 items-baseline gap-1.5"><span className="truncate font-mono text-xs font-medium" title={character.tag}>{character.tag}</span>{character.display_name ? <span className="truncate text-xs text-muted-foreground" title={character.display_name}>{character.display_name}</span> : null}</div><div className="flex h-4 min-w-0 shrink-0 items-center gap-1"><Badge variant={character.age_flag === "adult" ? "secondary" : "outline"} className="h-4 px-1 text-[10px]">{tp(AGE_LABEL[character.age_flag])}</Badge><Badge variant="outline" className="h-4 min-w-0 shrink px-1 text-[10px]" title={character.series || tp("original")}><span className="truncate">{character.series || tp("original")}</span></Badge><span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{tp("generatedCount", { count: character.generation_count })}</span></div><div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground"><span className="truncate">{main ? main.created_at.slice(5, 16) : ""}</span><span className="flex shrink-0"><a href={`#/gallery?character_id=${character.id}&rating_max=2`} className={buttonVariants({ size: "icon-xs", variant: "ghost" })} aria-label={tp("gallery")} title={tp("gallery")}><Images /></a><Button size="icon-xs" variant="ghost" onClick={() => onEdit(character)} aria-label={tp("edit")} title={tp("edit")}><Pencil /></Button><Button size="icon-xs" variant="ghost" onClick={() => onRemove(character)} aria-label={tp("delete")} title={tp("delete")}><Trash2 /></Button></span></div></div>
  </div>;
}

export function CharacterForm({ value, busy, onSubmit, onCancel }: { value: Character; busy?: boolean; onSubmit: (character: Character) => void; onCancel: () => void }) {
  const { t: tp } = useCharactersTranslation();
  const [character, setCharacter] = React.useState<Character>(value);
  React.useEffect(() => setCharacter(value), [value]);
  const patch = (change: Partial<Character>) => setCharacter((current) => ({ ...current, ...change }));
  const gender = [["girl", tp("genderGirl")], ["boy", tp("genderBoy")], ["other", tp("genderOther")]] as const;
  const age = [["adult", tp("adultOption")], ["minor", tp("minorOption")], ["unknown", tp("unknownOption")]] as const;
  return <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (character.tag.trim()) onSubmit({ ...character, tag: character.tag.trim() }); }}><div className="grid gap-3 sm:grid-cols-2"><Field label={tp("characterTag")} hint={tp("tagHint")}><Input aria-label={tp("characterTag")} className="h-8 font-mono text-xs" value={character.tag} placeholder="character_tag" onChange={(event) => patch({ tag: event.target.value })} autoFocus /></Field><Field label={tp("series")} hint={tp("seriesHint")}><Input aria-label={tp("series")} className="h-8 font-mono text-xs" value={character.series} onChange={(event) => patch({ series: event.target.value })} /></Field><Field label={tp("name")}><Input aria-label={tp("name")} className="h-8" value={character.display_name} onChange={(event) => patch({ display_name: event.target.value })} /></Field><Field label={tp("gender")}><Select value={character.gender} onValueChange={(value) => value && patch({ gender: value as Character["gender"] })} items={gender.map(([value, label]) => ({ value, label }))}><SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{gender.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field><Field label={tp("age")} hint={tp("ageHint")}><Select value={character.age_flag} onValueChange={(value) => value && patch({ age_flag: value as Character["age_flag"] })} items={age.map(([value, label]) => ({ value, label }))}><SelectTrigger size="sm" className="w-full" aria-label={tp("age")}><SelectValue /></SelectTrigger><SelectContent>{age.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field><Field label={tp("coordinates")} hint={tp("coordinatesHint")}><div className="flex gap-2"><Input aria-label="X" className="h-8" type="number" step={0.05} min={0} max={1} value={character.default_x} onChange={(event) => patch({ default_x: Number(event.target.value) })} /><Input aria-label="Y" className="h-8" type="number" step={0.05} min={0} max={1} value={character.default_y} onChange={(event) => patch({ default_y: Number(event.target.value) })} /></div></Field><Field label={tp("traits")} hint={tp("traitsHint")} className="sm:col-span-2"><TagInput value={character.fixed_traits} onChange={(fixed_traits) => patch({ fixed_traits })} placeholder={tp("traitsPlaceholder")} /></Field><Field label={tp("notes")} className="sm:col-span-2"><Textarea className="min-h-16 text-xs" value={character.notes} onChange={(event) => patch({ notes: event.target.value })} /></Field></div><div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={onCancel}>{tp("cancel")}</Button><Button type="submit" size="sm" disabled={busy || !character.tag.trim()}>{tp("save")}</Button></div></form>;
}

export function CharacterTable({ characters, onEdit, onRemove }: { characters: CharacterCardData[]; onEdit: (character: CharacterCardData) => void; onRemove: (character: CharacterCardData) => void }) {
  const { t: tp } = useCharactersTranslation();
  return <div className="overflow-x-auto rounded-xl border border-border"><Table><TableHeader><TableRow><TableHead className="w-12" /><TableHead>{tp("characterTag")}</TableHead><TableHead className="hidden sm:table-cell">{tp("name")}</TableHead><TableHead className="hidden md:table-cell">{tp("series")}</TableHead><TableHead>{tp("gender")}</TableHead><TableHead>{tp("age")}</TableHead><TableHead className="hidden lg:table-cell">{tp("created")}</TableHead><TableHead className="text-right">{tp("actions")}</TableHead></TableRow></TableHeader><TableBody>{characters.map((character) => <TableRow key={character.id}><TableCell className="p-1">{character.examples[0] ? <Example example={character.examples[0]} alt={character.tag} sizes="40px" className="size-10 rounded-md" /> : <div className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground"><ImageOff className="size-4" /></div>}</TableCell><TableCell className="font-mono text-xs">{character.tag}</TableCell><TableCell className="hidden sm:table-cell">{character.display_name || "—"}</TableCell><TableCell className="hidden md:table-cell text-xs text-muted-foreground">{character.series || tp("original")}</TableCell><TableCell className="text-xs">{character.gender}</TableCell><TableCell><Badge variant={character.age_flag === "adult" ? "secondary" : "outline"}>{tp(AGE_LABEL[character.age_flag])}</Badge></TableCell><TableCell className="hidden font-mono text-[11px] text-muted-foreground lg:table-cell">{tp("generatedCount", { count: character.generation_count })}</TableCell><TableCell className="text-right whitespace-nowrap"><a href={`#/gallery?character_id=${character.id}&rating_max=2`} className={buttonVariants({ size: "icon-xs", variant: "ghost" })} aria-label={tp("gallery")} title={tp("gallery")}><Images /></a><Button size="icon-xs" variant="ghost" onClick={() => onEdit(character)} aria-label={tp("edit")} title={tp("edit")}><Pencil /></Button><Button size="icon-xs" variant="ghost" onClick={() => onRemove(character)} aria-label={tp("delete")} title={tp("delete")}><Trash2 /></Button></TableCell></TableRow>)}</TableBody></Table></div>;
}
