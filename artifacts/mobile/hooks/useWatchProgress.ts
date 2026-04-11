import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@temple_tv/watch_progress";
const SAVE_THROTTLE_MS = 5000;

interface ProgressEntry {
  position: number;
  duration: number;
  updatedAt: number;
  title?: string;
  thumbnailUrl?: string;
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
}

export function useWatchProgress() {
  const [progressMap, setProgressMap] = useState<WatchProgressMap>({});
  const lastSaveRef = useRef<Record<string, number>>({});

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) setProgressMap(JSON.parse(raw) as WatchProgressMap);
      })
      .catch(() => {});
  }, []);

  const saveProgress = useCallback(
    async (
      videoKey: string,
      position: number,
      duration: number,
      meta?: { title?: string; thumbnailUrl?: string },
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

      setProgressMap((prev) => {
        const updated = { ...prev, [videoKey]: entry };
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)).catch(() => {});
        return updated;
      });
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
    setProgressMap((prev) => {
      const { [videoKey]: _, ...rest } = prev;
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(rest)).catch(() => {});
      return rest;
    });
  }, []);

  const clearAllProgress = useCallback(async () => {
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
