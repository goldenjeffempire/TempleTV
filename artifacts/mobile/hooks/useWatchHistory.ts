import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS, APP_CONFIG } from "@/constants/config";
import { apiSyncHistory, apiClearHistory } from "@/services/authApi";
import type { Sermon } from "@/types";

export interface HistoryEntry {
  sermon: Sermon;
  watchedAt: string;
}

async function hasAuthToken(): Promise<boolean> {
  const token = await AsyncStorage.getItem(STORAGE_KEYS.authToken);
  return !!token;
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
      const filtered = history.filter((h) => h.sermon.youtubeId !== sermon.youtubeId);
      const updated = [entry, ...filtered].slice(0, APP_CONFIG.maxHistoryItems);
      setHistory(updated);
      setHistoryIds(new Set(updated.map((h) => h.sermon.youtubeId)));
      await AsyncStorage.setItem(STORAGE_KEYS.watchHistory, JSON.stringify(updated));
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        apiSyncHistory({
          videoId: sermon.youtubeId,
          videoTitle: sermon.title,
          videoThumbnail: sermon.thumbnailUrl,
          videoCategory: sermon.category ?? "sermon",
        }).catch(() => {});
      });
    },
    [history],
  );

  const clearHistory = useCallback(async () => {
    setHistory([]);
    setHistoryIds(new Set());
    await AsyncStorage.removeItem(STORAGE_KEYS.watchHistory);
    hasAuthToken().then((loggedIn) => {
      if (!loggedIn) return;
      apiClearHistory().catch(() => {});
    });
  }, []);

  const hasWatched = useCallback((videoId: string) => historyIds.has(videoId), [historyIds]);

  return { history, hasWatched, addToHistory, clearHistory };
}
