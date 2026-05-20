import { useCallback, useEffect, useState } from "react";
import {
  getWatchHistory,
  clearWatchHistory,
  type HistoryEntry,
} from "../lib/watchHistory";

const STORAGE_KEY = "ttv:watch-history:v1";

export function useWatchHistory(limit?: number): {
  entries: HistoryEntry[];
  refresh: () => void;
  clearAll: () => void;
} {
  const [entries, setEntries] = useState<HistoryEntry[]>(() =>
    getWatchHistory(limit),
  );

  const refresh = useCallback(() => {
    setEntries(getWatchHistory(limit));
  }, [limit]);

  const clearAll = useCallback(() => {
    clearWatchHistory();
    setEntries([]);
  }, []);

  // Keep in sync when another tab writes (or when Player.tsx calls logWatch
  // and the storage event fires on this tab).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refresh]);

  return { entries, refresh, clearAll };
}
