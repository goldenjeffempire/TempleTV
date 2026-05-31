import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@temple_tv/watch_progress";
const SAVE_THROTTLE_MS = 5000;
// Keep at most this many entries in AsyncStorage. Android's default cap is
// ~6 MB; each progress entry is ~300–500 bytes so 200 entries stay well
// under 1 MB while covering any realistic watch history.
const MAX_PROGRESS_ENTRIES = 200;

interface ProgressEntry {
  position: number;
  duration: number;
  updatedAt: number;
  title?: string;
  thumbnailUrl?: string;
  youtubeId?: string;
  localVideoUrl?: string;
  hlsMasterUrl?: string;
}

interface WatchProgressMap {
  [videoKey: string]: ProgressEntry;
}

export interface ContinueWatchingItem {
  videoKey: string;
  position: number;
  duration: number;
  pct: number;
  updatedAt: number;
  title?: string;
  thumbnailUrl?: string;
  youtubeId?: string;
  localVideoUrl?: string;
  hlsMasterUrl?: string;
}

export function useWatchProgress() {
  const [progressMap, setProgressMap] = useState<WatchProgressMap>({});
  // Authoritative in-memory store — kept in sync with React state but used
  // directly for writes so that concurrent saveProgress calls always compose
  // on top of the latest data rather than the (potentially stale) React state
  // snapshot captured in a state updater callback.
  const progressMapRef = useRef<WatchProgressMap>({});
  const lastSaveRef = useRef<Record<string, number>>({});

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as WatchProgressMap;
            progressMapRef.current = parsed;
            setProgressMap(parsed);
          } catch {
            // Corrupted storage — start with empty progress map.
          }
        }
      })
      .catch(() => {});
  }, []);

  const saveProgress = useCallback(
    async (
      videoKey: string,
      position: number,
      duration: number,
      meta?: { title?: string; thumbnailUrl?: string; youtubeId?: string; localVideoUrl?: string; hlsMasterUrl?: string },
    ) => {
      if (!videoKey || duration <= 0 || position < 5) return;

      const now = Date.now();
      const lastSave = lastSaveRef.current[videoKey] ?? 0;
      if (now - lastSave < SAVE_THROTTLE_MS) return;
      lastSaveRef.current[videoKey] = now;

      const entry: ProgressEntry = {
        position,
        duration,
        updatedAt: now,
        ...(meta ?? {}),
      };

      // Build the new map using the ref (always current) rather than reading
      // from the React state updater argument. The state updater pattern
      // (setProgressMap(prev => ...)) seems safe but carries two risks:
      //   1. Side effects inside a state updater are a React anti-pattern —
      //      React may call the updater more than once (StrictMode, Concurrent).
      //   2. Under rapid saves the same `prev` snapshot can be captured by
      //      two queued updaters that haven't flushed yet, causing one entry
      //      to silently overwrite the other.
      // Using a ref as the authoritative in-memory store decouples the AsyncStorage
      // write from React's render cycle entirely.
      let updated: WatchProgressMap = { ...progressMapRef.current, [videoKey]: entry };

      // Prune the map if it exceeds the cap. Drop the oldest completed entries
      // first (pct >= 0.97), then the oldest in-progress entries if still over.
      const entries = Object.entries(updated);
      if (entries.length > MAX_PROGRESS_ENTRIES) {
        const sorted = entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        const excess = entries.length - MAX_PROGRESS_ENTRIES;
        // Prefer dropping completed entries first to preserve resume-ability.
        const completedKeys = new Set(
          sorted
            .filter(([, e]) => e.position / e.duration >= 0.97)
            .slice(0, excess)
            .map(([k]) => k),
        );
        const dropped = completedKeys.size;
        const remainingExcess = excess - dropped;
        const oldestKeys = new Set(
          sorted
            .filter(([k]) => !completedKeys.has(k))
            .slice(0, remainingExcess)
            .map(([k]) => k),
        );
        updated = Object.fromEntries(
          entries.filter(([k]) => !completedKeys.has(k) && !oldestKeys.has(k)),
        );
      }

      progressMapRef.current = updated;
      setProgressMap(progressMapRef.current);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(progressMapRef.current)).catch(() => {});
    },
    [],
  );

  const getProgress = useCallback(
    (videoKey: string) => {
      const entry = progressMap[videoKey];
      if (!entry || entry.duration <= 0) return null;
      const pct = entry.position / entry.duration;
      if (pct < 0.02 || pct > 0.97) return null;
      return { position: entry.position, duration: entry.duration, pct };
    },
    [progressMap],
  );

  const clearProgress = useCallback(async (videoKey: string) => {
    const { [videoKey]: _, ...rest } = progressMapRef.current;
    progressMapRef.current = rest;
    setProgressMap(rest);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(rest)).catch(() => {});
  }, []);

  const clearAllProgress = useCallback(async () => {
    progressMapRef.current = {};
    setProgressMap({});
    await AsyncStorage.removeItem(STORAGE_KEY);
  }, []);

  const continueWatching: ContinueWatchingItem[] = Object.entries(progressMap)
    .filter(([, entry]) => {
      const pct = entry.position / entry.duration;
      return pct >= 0.02 && pct <= 0.97;
    })
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, 10)
    .map(([videoKey, entry]) => ({
      videoKey,
      position: entry.position,
      duration: entry.duration,
      pct: entry.position / entry.duration,
      updatedAt: entry.updatedAt,
      title: entry.title,
      thumbnailUrl: entry.thumbnailUrl,
      youtubeId: entry.youtubeId,
      localVideoUrl: entry.localVideoUrl,
      hlsMasterUrl: entry.hlsMasterUrl,
    }));

  return {
    progressMap,
    saveProgress,
    getProgress,
    clearProgress,
    clearAllProgress,
    continueWatching,
  };
}
