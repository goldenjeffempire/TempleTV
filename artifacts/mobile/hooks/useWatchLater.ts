import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS, SECURE_KEYS } from "@/constants/config";
import { secureStorage } from "@/lib/secureStorage";
import { apiGetWatchLater, apiAddWatchLater, apiRemoveWatchLater, apiClearWatchLater } from "@/services/watchLaterApi";
import { useAuth } from "@/context/AuthContext";
import type { Sermon, SermonCategory } from "@/types";

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

export function useWatchLater() {
  const [items, setItems] = useState<Sermon[]>([]);
  const [itemIds, setItemIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const { token } = useAuth();
  const lastSyncedTokenRef = useRef<string | null>(null);
  const itemsRef = useRef<Sermon[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.watchLater)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Sermon[];
            itemsRef.current = parsed;
            setItems(parsed);
            setItemIds(new Set(parsed.map((s) => s.id)));
          } catch {
            void AsyncStorage.removeItem(STORAGE_KEYS.watchLater);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!token || !loaded || lastSyncedTokenRef.current === token) return;
    lastSyncedTokenRef.current = token;

    apiGetWatchLater()
      .then(async (cloudItems) => {
        const current = itemsRef.current;
        const currentIds = new Set(current.map((s) => s.id));

        const cloudOnly = cloudItems
          .filter((ci) => !currentIds.has(ci.videoId))
          .map<Sermon>((ci) => ({
            id: ci.videoId,
            title: ci.videoTitle,
            description: "",
            youtubeId: ci.videoId,
            thumbnailUrl: ci.videoThumbnail,
            duration: "",
            category: cloudCategoryToSermonCategory(ci.videoCategory),
            preacher: "",
            date: ci.addedAt.slice(0, 10),
            videoSource: "youtube",
          }));

        if (cloudOnly.length === 0) return;

        const latest = itemsRef.current;
        const latestIds = new Set(latest.map((s) => s.id));
        const merged = [...latest, ...cloudOnly.filter((s) => !latestIds.has(s.id))];
        itemsRef.current = merged;
        setItems(merged);
        setItemIds(new Set(merged.map((s) => s.id)));
        try {
          await AsyncStorage.setItem(STORAGE_KEYS.watchLater, JSON.stringify(merged));
        } catch { /* Non-critical */ }
      })
      .catch(() => {});
  }, [token, loaded]);

  const persist = useCallback(async (updated: Sermon[]) => {
    itemsRef.current = updated;
    setItems(updated);
    setItemIds(new Set(updated.map((s) => s.id)));
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.watchLater, JSON.stringify(updated));
    } catch { /* Non-critical */ }
  }, []);

  const addToWatchLater = useCallback(
    async (sermon: Sermon) => {
      const current = itemsRef.current;
      if (current.some((s) => s.id === sermon.id)) return;
      await persist([sermon, ...current]);
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        apiAddWatchLater({
          videoId: sermon.youtubeId || sermon.id,
          videoTitle: sermon.title,
          videoThumbnail: sermon.thumbnailUrl,
          videoCategory: sermon.category ?? "sermon",
        }).catch(() => {});
      });
    },
    [persist],
  );

  const removeFromWatchLater = useCallback(
    async (videoId: string) => {
      const current = itemsRef.current;
      const toRemove = current.find((s) => s.id === videoId);
      await persist(current.filter((s) => s.id !== videoId));
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        apiRemoveWatchLater(toRemove?.youtubeId || videoId).catch(() => {});
      });
    },
    [persist],
  );

  const toggleWatchLater = useCallback(
    async (sermon: Sermon) => {
      if (itemIds.has(sermon.id)) {
        await removeFromWatchLater(sermon.id);
      } else {
        await addToWatchLater(sermon);
      }
    },
    [itemIds, addToWatchLater, removeFromWatchLater],
  );

  const clearWatchLater = useCallback(async () => {
    await persist([]);
    hasAuthToken().then((loggedIn) => {
      if (!loggedIn) return;
      apiClearWatchLater().catch(() => {});
    });
  }, [persist]);

  const isInWatchLater = useCallback(
    (videoId: string) => itemIds.has(videoId),
    [itemIds],
  );

  return {
    watchLater: items,
    watchLaterIds: itemIds,
    isInWatchLater,
    addToWatchLater,
    removeFromWatchLater,
    toggleWatchLater,
    clearWatchLater,
    loaded,
  };
}
