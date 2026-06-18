import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS, SECURE_KEYS, APP_CONFIG } from "@/constants/config";
import { secureStorage } from "@/lib/secureStorage";
import { apiSyncHistory, apiClearHistory, apiGetHistory } from "@/services/authApi";
import { useAuth } from "@/context/AuthContext";
import type { Sermon, SermonCategory } from "@/types";

export interface HistoryEntry {
  sermon: Sermon;
  watchedAt: string;
}

// Auth tokens live in SecureStore under SECURE_KEYS (safe-char keys).
// Fall back to the legacy AsyncStorage key for one release so any user that
// hadn't yet hit AuthContext's migration block still gets cloud sync.
async function hasAuthToken(): Promise<boolean> {
  const secure = await secureStorage.getItem(SECURE_KEYS.authToken);
  if (secure) return true;
  const legacy = await AsyncStorage.getItem(STORAGE_KEYS.authToken);
  return !!legacy;
}

function cloudCategoryToSermonCategory(raw: string): SermonCategory {
  const map: Record<string, SermonCategory> = {
    live_service: "Live Service",
    "live-service": "Live Service",
    faith: "Sermons",
    deliverance: "Deliverance",
    worship: "Sermons",
    prophecy: "Sermons",
    teachings: "Sermons",
    teaching: "Sermons",
    sermon: "Sermons",
    special: "Sermons",
    prayer: "Prayers",
    prayers: "Prayers",
    crusade: "Crusades",
    crusades: "Crusades",
    conference: "Conferences",
    conferences: "Conferences",
    testimony: "Testimonies",
    testimonies: "Testimonies",
  };
  return map[raw.toLowerCase()] ?? "Sermons";
}

export function useWatchHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIds, setHistoryIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const { token } = useAuth();
  const lastSyncedTokenRef = useRef<string | null>(null);
  // Always-current mirror of `history`. Allows addToHistory to read the
  // latest list without closing over the render-time snapshot — preventing
  // dropped entries when two navigations happen before a re-render.
  const latestHistoryRef = useRef<HistoryEntry[]>([]);
  useEffect(() => { latestHistoryRef.current = history; }, [history]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.watchHistory)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as HistoryEntry[];
            latestHistoryRef.current = parsed;
            setHistory(parsed);
            // Use sermon.id (db UUID) as the canonical dedup key.
            // This fixes local-video history where youtubeId is always "".
            setHistoryIds(new Set(parsed.map((h) => h.sermon.id)));
          } catch (e) {
            // Corrupted AsyncStorage data — clear and start fresh so the app
            // doesn't crash on every launch until the user reinstalls.
            if (process.env.NODE_ENV !== "production") {
              if (__DEV__) console.error("[useWatchHistory] Failed to parse history:", e);
            }
            void AsyncStorage.removeItem(STORAGE_KEYS.watchHistory);
          }
        }
      })
      .catch((e) => {
        if (process.env.NODE_ENV !== "production") {
          if (__DEV__) console.error("[useWatchHistory] Failed to read history from storage:", e);
        }
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!token || !loaded || lastSyncedTokenRef.current === token) return;
    lastSyncedTokenRef.current = token;

    apiGetHistory()
      .then(async (cloudHistory) => {
        const raw = await AsyncStorage.getItem(STORAGE_KEYS.watchHistory).catch(() => null);
        let local: HistoryEntry[] = [];
        if (raw) {
          try { local = JSON.parse(raw) as HistoryEntry[]; } catch { /* corrupted — treat as empty */ }
        }
        // Build a set of ALL identifiers from local entries (both the db UUID
        // and the youtubeId, when present) so we match cloud videoIds regardless
        // of whether the server stored a YouTube ID or a platform UUID.
        const localIds = new Set<string>();
        for (const h of local) {
          localIds.add(h.sermon.id);
          if (h.sermon.youtubeId) localIds.add(h.sermon.youtubeId);
        }

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
              videoSource: "youtube",
            },
          }));

        if (cloudOnly.length === 0) return;

        const merged = [...local, ...cloudOnly]
          .sort((a, b) => new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime())
          .slice(0, APP_CONFIG.maxHistoryItems);

      setHistory(merged);
      setHistoryIds(new Set(merged.map((h) => h.sermon.id)));
      try {
        await AsyncStorage.setItem(STORAGE_KEYS.watchHistory, JSON.stringify(merged));
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          if (__DEV__) console.error("[useWatchHistory] Failed to persist merged history:", e);
        }
      }
    })
    .catch((e) => {
      if (process.env.NODE_ENV !== "production") {
        if (__DEV__) console.error("[useWatchHistory] Cloud sync failed:", e);
      }
    });
  }, [token, loaded]);

  const addToHistory = useCallback(
    async (sermon: Sermon) => {
      const entry: HistoryEntry = { sermon, watchedAt: new Date().toISOString() };
      // Read from ref so rapid back-to-back calls build on top of each other
      // rather than both reading the same stale render-snapshot of `history`.
      const current = latestHistoryRef.current;
      // Dedup by sermon.id (UUID). Using youtubeId caused all local-platform
      // videos (youtubeId === "") to collide on the same slot, evicting each
      // other and making hasWatched() return true for every local video.
      const filtered = current.filter((h) => h.sermon.id !== sermon.id);
      const updated = [entry, ...filtered].slice(0, APP_CONFIG.maxHistoryItems);
      latestHistoryRef.current = updated; // keep ref in sync immediately
      setHistory(updated);
      setHistoryIds(new Set(updated.map((h) => h.sermon.id)));
      try {
        await AsyncStorage.setItem(STORAGE_KEYS.watchHistory, JSON.stringify(updated));
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          if (__DEV__) console.error("[useWatchHistory] Failed to save entry:", e);
        }
      }
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        apiSyncHistory({
          // For local/uploaded videos youtubeId is ""; fall back to the db UUID
          // so the server receives a meaningful identifier rather than blank.
          videoId: sermon.youtubeId || sermon.id,
          videoTitle: sermon.title,
          videoThumbnail: sermon.thumbnailUrl,
          videoCategory: sermon.category ?? "sermon",
        }).catch(() => {});
      });
    },
    [], // no stale closure — reads latest history from ref
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
