"use client";

import * as React from "react";
import { presetName } from "@/i18n/preset-text";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BlockPreset, Character } from "@/lib/schema";
import type { GalleryQuery } from "./types";
import { BLOCK_LABEL_KEY } from "@/features/shared/types";
import { useTranslation } from "react-i18next";
import { useGalleryTranslation } from "./locale";

type Option = { value: number; label: string };


function FilterSelect({ label, values, multiple = false, options, onChange, className }: {
  label: string; values: number[]; multiple?: boolean; options: Option[]; onChange: (ids: number[]) => void; className?: string;
}) {
  const { t } = useGalleryTranslation();
  const choices = multiple ? options : [{ value: 0, label: t("all") }, ...options];
  const selected = values.map(id => choices.find(o => o.value === id) ?? { value: id, label: `#${id}` });
  const summary = selected.length ? selected.map(o => o.label).join(", ") : t("all");
  return (
    <Combobox.Root items={choices} multiple={multiple} value={multiple ? selected : selected[0] ?? choices[0]} isItemEqualToValue={(a, b) => a.value === b.value}
      onValueChange={v => onChange((Array.isArray(v) ? v : v ? [v] : []).map(o => o.value).filter(Boolean))}>
      <Combobox.Trigger aria-label={t("filterLabel", { label })} className={cn("flex h-8 min-w-0 items-center gap-2 rounded-md border border-input px-2.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", values.length > 0 && "bg-muted", className)}>
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <span className="min-w-0 flex-1 truncate text-left" title={summary}>{selected[0]?.label ?? t("all")}</span>
        {selected.length > 1 ? <span className="shrink-0 font-mono text-[10px]">+{selected.length - 1}</span> : null}
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} align="start" className="z-50">
          <Combobox.Popup className="w-72 max-w-(--available-width) overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <Combobox.Input aria-label={t("searchLabel", { label })} placeholder={t("searchLabel", { label })} className="h-9 w-full min-w-0 bg-transparent text-xs outline-none" />
            </div>
            <Combobox.Empty className="p-4 text-center text-xs text-muted-foreground empty:p-0">{t("searchEmpty")}</Combobox.Empty>
            <Combobox.List className="max-h-64 overflow-y-auto p-1">
              {(option: Option) => <Combobox.Item key={option.value} value={option} className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-xs outline-none data-highlighted:bg-muted">
                <span className="min-w-0 flex-1 break-words">{option.label}</span>
                <Combobox.ItemIndicator><Check className="size-3.5" /></Combobox.ItemIndicator>
              </Combobox.Item>}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export function GalleryFilters({ characters, presets, recipes, query, onQuery }: {
  characters: Character[]; presets: BlockPreset[]; recipes: { id: number; name: string }[];
  query: GalleryQuery; onQuery: (query: GalleryQuery) => void;
}) {
  const { t } = useGalleryTranslation();
  const { t: ui } = useTranslation();
  const DATE_SORTS = [{ value: "newest", label: t("newest") }, { value: "oldest", label: t("oldest") }];
  const [advanced, setAdvanced] = React.useState(false);
  const detailId = React.useId();
  const filters = [
    { key: "character_ids", label: t("characters"), multiple: true, values: query.character_ids ?? [], options: characters.filter(c => c.id).map(c => ({ value: c.id!, label: c.display_name ? `${c.display_name} · ${c.tag}` : c.tag })) },
    { key: "preset_ids", label: t("palette"), multiple: true, values: query.preset_ids ?? [], options: presets.filter(p => p.id && p.type !== "cast").map(p => ({ value: p.id!, label: `${ui(BLOCK_LABEL_KEY[p.type])} · ${presetName(p)}` })) },
    { key: "recipe_id", label: t("recipe"), multiple: false, values: query.recipe_id ? [query.recipe_id] : [], options: recipes.map(r => ({ value: r.id, label: r.name })) },
  ] as const;
  const active = filters.flatMap(f => f.values.map(value => ({ filter: f, value })));
  const extraCount = [query.recipe_id].filter(Boolean).length;
  const update = (filter: typeof filters[number], ids: number[]) => onQuery({ ...query, [filter.key]: filter.multiple ? ids : ids[0], offset: undefined });
  return (
    <div role="group" aria-label={t("filters")} className="flex min-w-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {filters.slice(0, 2).map(f => <FilterSelect key={f.key} label={f.label} values={f.values} multiple={f.multiple} options={f.options} onChange={ids => update(f, ids)} className={f.key === "character_ids" ? "w-44 max-w-full" : "w-52 max-w-full"} />)}
        <Select value={query.sort ?? "newest"} items={DATE_SORTS} onValueChange={sort => { if (sort === "newest" || sort === "oldest") onQuery({ ...query, sort, offset: undefined }); }}>
          <SelectTrigger size="sm" aria-label={t("sort")} className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{DATE_SORTS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
        </Select>
        <div role="group" aria-label={t("ratings")} className="flex h-8 items-center rounded-md bg-muted/60 p-0.5">
          {[t("rating0"), t("rating1"), t("rating2")].map((label, rating) => <button key={rating} type="button" aria-pressed={(query.rating_max ?? 0) === rating}
            onClick={() => onQuery({ ...query, rating_max: rating, offset: undefined })}
            className={cn("h-7 rounded px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring", (query.rating_max ?? 0) === rating ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>)}
        </div>
        <Button size="sm" variant="ghost" aria-expanded={advanced} aria-controls={detailId} onClick={() => setAdvanced(v => !v)} className="h-8 text-xs text-muted-foreground">
          {t("advanced")}{extraCount ? <span className="font-mono text-foreground">{extraCount}</span> : null}<ChevronDown className={cn("transition-transform", advanced && "rotate-180")} />
        </Button>
        {active.length || (query.rating_max ?? 0) !== 0 ? <Button size="xs" variant="ghost" aria-label={t("resetFilters")} onClick={() => onQuery({ rating_max: 0, limit: query.limit, ...(query.sort ? { sort: query.sort } : {}) })} className="text-muted-foreground"><X /> {t("reset")}</Button> : null}
      </div>
      {advanced ? <div id={detailId} role="group" aria-label={t("advanced")} className="flex flex-wrap gap-2">
        {filters.slice(2).map(f => <FilterSelect key={f.key} label={f.label} values={f.values} options={f.options} onChange={ids => update(f, ids)} className="max-w-64 flex-[1_1_12rem]" />)}
      </div> : null}
      {active.length ? <div className="flex flex-wrap gap-1.5">
        {active.map(({ filter: f, value }) => {
          const name = f.options.find(o => o.value === value)?.label ?? `#${value}`;
          return <button key={`${f.key}-${value}`} type="button" aria-label={t("removeFilter", { label: f.label, name })} onClick={() => update(f, f.values.filter(id => id !== value))} title={name}
            className="flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px] hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring">
            <span className="shrink-0 text-muted-foreground">{f.label}</span><span className="truncate">{name}</span><X className="size-3 shrink-0 text-muted-foreground" />
          </button>;
        })}
      </div> : null}
    </div>
  );
}
