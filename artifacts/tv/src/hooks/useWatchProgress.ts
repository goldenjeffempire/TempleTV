import { useCallback, useEffect, useState } from "react";
import { getRecentProgress, clearProgress, type WatchEntry } from "../lib/watchProgress";

const STORAGE_KEY = "ttv:watch-progress:v1";

/**
 * Reactive hook for the watch-progress store.
 *
 * Returns the N most-recently-watched in-progress entries.
 * Updates automatically when the store changes in this tab (via `refresh()`)
 * or in another tab (via the `storage` event).
 */
export function useWatchProgress(limit = 5): {
  entries: WatchEntry[];
  refresh: () => void;
  remove: (videoId: string) => void;
} {
  const [entries, setEntries] = useState<WatchEntry[]>(() => getRecentProgress(limit));

  const refresh = useCallback(() => {
    setEntries(getRecentProgress(limit));
  }, [limit]);

  /** Remove a single entry and immediately re-read the store. */
  const remove = useCallback((videoId: string) => {
    clearProgress(videoId);
    setEntries(getRecentProgress(limit));
  }, [limit]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refresh]);

  return { entries, refresh, remove };
}
