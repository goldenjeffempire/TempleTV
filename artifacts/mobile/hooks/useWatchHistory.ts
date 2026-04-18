import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS, APP_CONFIG } from "@/constants/config";
import { apiSyncHistory, apiClearHistory, apiGetHistory } from "@/services/authApi";
import { useAuth } from "@/context/AuthContext";
import type { Sermon, SermonCategory } from "@/types";

export interface HistoryEntry {
  sermon: Sermon;
  watchedAt: string;
}

async function hasAuthToken(): Promise<boolean> {
  const token = await AsyncStorage.getItem(STORAGE_KEYS.authToken);
  return !!token;
}

function cloudCategoryToSermonCategory(raw: string): SermonCategory {
  const map: Record<string, SermonCategory> = {
    faith: "Faith",
    healing: "Healing",
    deliverance: "Deliverance",
    worship: "Worship",
    prophecy: "Prophecy",
    teachings: "Teachings",
    special: "Special Programs",
    sermon: "Faith",
  };
  return map[raw.toLowerCase()] ?? "Faith";
}

export function useWatchHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIds, setHistoryIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const { token } = useAuth();
  const lastSyncedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.watchHistory)
      .then((raw) => {
        if (raw) {
          const parsed = JSON.parse(raw) as HistoryEntry[];
          setHistory(parsed);
          setHistoryIds(new Set(parsed.map((h) => h.sermon.youtubeId)));
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!token || !loaded || lastSyncedTokenRef.current === token) return;
    lastSyncedTokenRef.current = token;

    apiGetHistory()
      .then(async (cloudHistory) => {
        const raw = await AsyncStorage.getItem(STORAGE_KEYS.watchHistory).catch(() => null);
        const local: HistoryEntry[] = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
        const localIds = new Set(local.map((h) => h.sermon.youtubeId));

        const cloudOnly = cloudHistory
          .filter((ch) => !localIds.has(ch.videoId))
          .map<HistoryEntry>((ch) => ({
            watchedAt: ch.watchedAt,
            sermon: {
              id: ch.videoId,
              title: ch.videoTitle,
              description: "",
              youtubeId: ch.videoId,
              thumbnailUrl: ch.videoThumbnail,
              duration: "",
              category: cloudCategoryToSermonCategory(ch.videoCategory),
              preacher: "",
              date: ch.watchedAt.slice(0, 10),
            },
          }));

        if (cloudOnly.length === 0) return;

        const merged = [...local, ...cloudOnly]
          .sort((a, b) => new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime())
          .slice(0, APP_CONFIG.maxHistoryItems);

        setHistory(merged);
        setHistoryIds(new Set(merged.map((h) => h.sermon.youtubeId)));
        await AsyncStorage.setItem(STORAGE_KEYS.watchHistory, JSON.stringify(merged));
      })
      .catch(() => {});
  }, [token, loaded]);

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
