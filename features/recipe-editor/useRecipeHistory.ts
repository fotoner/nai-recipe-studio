import * as React from "react";
import type { Recipe } from "@/features/shared/types";
import { removeDraft, writeDraft } from "./drafts";

type History = { past: Recipe[]; current: Recipe | null; future: Recipe[]; saved: string };
const empty: History = { past: [], current: null, future: [], saved: "" };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const metadata = (recipe: Recipe) => ({ id: recipe.id, version: recipe.version, created_at: recipe.created_at, updated_at: recipe.updated_at });

/** In-memory undo is independent of explicit recipe versions and the recovery copy. */
export function useRecipeHistory(draftKey: string) {
  const [state, setState] = React.useState<History>(empty);
  const ref = React.useRef(state);
  const [storageError, setStorageError] = React.useState(false);
  const publish = React.useCallback((next: History, persist = true) => {
    ref.current = next;
    setState(next);
    if (!persist || !next.current) return;
    try {
      if (JSON.stringify(next.current) === next.saved) removeDraft(draftKey);
      else writeDraft(draftKey, next.current);
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [draftKey]);
  const initialize = React.useCallback((recipe: Recipe, unsaved = false) => {
    publish({ past: [], current: recipe, future: [], saved: unsaved ? "" : JSON.stringify(recipe) }, unsaved);
  }, [publish]);
  const update = React.useCallback((recipe: Recipe) => {
    const current = ref.current;
    if (same(current.current, recipe)) return;
    publish({ ...current, past: current.current ? [...current.past, current.current].slice(-100) : [], current: recipe, future: [] });
  }, [publish]);
  const undo = React.useCallback(() => {
    const current = ref.current;
    if (!current.current || !current.past.length) return;
    publish({ ...current, past: current.past.slice(0, -1), current: current.past.at(-1)!, future: [current.current, ...current.future] });
  }, [publish]);
  const redo = React.useCallback(() => {
    const current = ref.current;
    if (!current.current || !current.future.length) return;
    publish({ ...current, past: [...current.past, current.current], current: current.future[0], future: current.future.slice(1) });
  }, [publish]);
  const markSaved = React.useCallback((submitted: Recipe, stored: Recipe) => {
    const current = ref.current;
    const rebase = (value: Recipe) => ({ ...value, ...metadata(stored) });
    const next = { ...current, past: current.past.map(rebase), future: current.future.map(rebase), current: same(current.current, submitted) ? stored : rebase(current.current ?? stored), saved: JSON.stringify(stored) };
    publish(next);
    return JSON.stringify(next.current) !== next.saved;
  }, [publish]);
  return { recipe: state.current, dirty: !!state.current && JSON.stringify(state.current) !== state.saved, canUndo: !!state.past.length, canRedo: !!state.future.length, storageError, initialize, update, undo, redo, markSaved };
}
