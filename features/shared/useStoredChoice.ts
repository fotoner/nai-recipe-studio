import { useCallback, useEffect, useState } from "react";

/** Persist an existing view preference without requiring storage to be available. */
export function useStoredChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const read = useCallback(() => {
    try { const value = localStorage.getItem(key) as T | null; return value && allowed.includes(value) ? value : fallback; }
    catch { return fallback; }
  }, [allowed, fallback, key]);
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) setValue(read()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, read]);
  const update = useCallback((next: T) => {
    setValue(next);
    try { localStorage.setItem(key, next); } catch { /* The choice still works for this session. */ }
  }, [key]);
  return [value, update];
}
