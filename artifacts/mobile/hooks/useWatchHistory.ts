import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS, APP_CONFIG } from "@/constants/config";
import type { Sermon } from "@/types";

export interface HistoryEntry {
  sermon: Sermon;
  watchedAt: string;
}

export function useWatchHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIds, setHistoryIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.watchHistory)
      .then((raw) => {
        if (raw) {
          const parsed = JSON.parse(raw) as HistoryEntry[];
          setHistory(parsed);
          setHistoryIds(new Set(parsed.map((h) => h.sermon.youtubeId)));
        }
      })
      .catch(() => {});
  }, []);

  const addToHistory = useCallback(
    async (sermon: Sermon) => {
      const entry: HistoryEntry = { sermon, watchedAt: new Date().toISOString() };
      // Remove if already in history (move to top)
      const filtered = history.filter((h) => h.sermon.youtubeId !== sermon.youtubeId);
      const updated = [entry, ...filtered].slice(0, APP_CONFIG.maxHistoryItems);
      setHistory(updated);
      setHistoryIds(new Set(updated.map((h) => h.sermon.youtubeId)));
      await AsyncStorage.setItem(STORAGE_KEYS.watchHistory, JSON.stringify(updated));
    },
    [history],
  );

  const clearHistory = useCallback(async () => {
    setHistory([]);
    setHistoryIds(new Set());
    await AsyncStorage.removeItem(STORAGE_KEYS.watchHistory);
  }, []);

  const hasWatched = useCallback((videoId: string) => historyIds.has(videoId), [historyIds]);

  return { history, hasWatched, addToHistory, clearHistory };
}
