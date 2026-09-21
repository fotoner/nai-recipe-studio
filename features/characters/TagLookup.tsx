import * as React from "react";
import { Loader2, Search } from "lucide-react";
import type { StudioClient, TagSuggestion } from "@/contracts/studio";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { studioCall } from "@/desktop/renderer/studio-client";

type TagKind = "character" | "copyright";

/** Debounced Danbooru lookup through the desktop command boundary. */
export function TagLookup({ client, value, kind, placeholder, ariaLabel, onChange, onPick, className }: {
  client?: StudioClient;
  value: string;
  kind: TagKind;
  placeholder?: string;
  ariaLabel?: string;
  onChange: (value: string) => void;
  onPick?: (suggestion: TagSuggestion) => void;
  className?: string;
}) {
  const [result, setResult] = React.useState<{ query: string; kind: TagKind; suggestions: TagSuggestion[] } | null>(null);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const query = value.trim();
  const suggestions = open && query.length >= 2 && result?.query === query && result.kind === kind ? result.suggestions : [];
  const busy = !!client && open && query.length >= 2 && (result?.query !== query || result.kind !== kind);

  React.useEffect(() => {
    if (!client || !open || query.length < 2) return;
    let alive = true;
    const timeout = window.setTimeout(() => {
      void studioCall(client, "characters.tagLookup", { mode: "search", query, kind })
        .then(items => { if (alive) { setResult({ query, kind, suggestions: items }); setActive(0); } })
        .catch(() => { if (alive) setResult({ query, kind, suggestions: [] }); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timeout); };
  }, [client, kind, open, query]);

  const choose = (suggestion: TagSuggestion) => {
    onChange(suggestion.name);
    onPick?.(suggestion);
    setOpen(false);
  };

  return <div className={cn("relative", className)}>
    <Input className="h-8 pr-7 font-mono text-xs" value={value} placeholder={placeholder} aria-label={ariaLabel}
      onChange={event => { onChange(event.target.value); setOpen(true); }}
      onFocus={() => setOpen(true)}
      onBlur={() => window.setTimeout(() => setOpen(false), 120)}
      onKeyDown={event => {
        if (!open || !suggestions.length) return;
        if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(index + 1, suggestions.length - 1)); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
        else if (event.key === "Enter") { event.preventDefault(); choose(suggestions[active]); }
        else if (event.key === "Escape") setOpen(false);
      }} />
    <span className="pointer-events-none absolute top-2 right-2 text-muted-foreground">{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}</span>
    {open && suggestions.length ? <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 text-xs shadow-md">
      {suggestions.map((suggestion, index) => <li key={suggestion.tag}>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => choose(suggestion)}
          className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted", index === active && "bg-muted")}>
          <span className="truncate font-mono">{suggestion.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{suggestion.post_count.toLocaleString()}</span>
        </button>
      </li>)}
    </ul> : null}
  </div>;
}

export default TagLookup;
