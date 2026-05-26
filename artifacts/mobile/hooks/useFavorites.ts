import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS, SECURE_KEYS } from "@/constants/config";
import { secureStorage } from "@/lib/secureStorage";
import { apiSyncFavorite, apiGetFavorites } from "@/services/authApi";
import { useAuth } from "@/context/AuthContext";
import type { Sermon, SermonCategory } from "@/types";

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

export function useFavorites() {
  const [favorites, setFavorites] = useState<Sermon[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const { token } = useAuth();
  const lastSyncedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.favorites)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Sermon[];
            setFavorites(parsed);
            // Use sermon.id (db UUID) as the canonical dedup key.
            // This fixes local-video favorites where youtubeId is always "".
            setFavoriteIds(new Set(parsed.map((s) => s.id)));
          } catch {
            // Corrupted AsyncStorage data — clear and start fresh so the app
            // doesn't crash on every launch until the user reinstalls.
            void AsyncStorage.removeItem(STORAGE_KEYS.favorites);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!token || !loaded || lastSyncedTokenRef.current === token) return;
    lastSyncedTokenRef.current = token;

    apiGetFavorites()
      .then(async (cloudFavs) => {
        const raw = await AsyncStorage.getItem(STORAGE_KEYS.favorites).catch(() => null);
        let local: Sermon[] = [];
        if (raw) {
          try { local = JSON.parse(raw) as Sermon[]; } catch { /* corrupted — treat as empty */ }
        }
        // Use s.id for dedup — matches the same key used throughout this hook.
        const localIds = new Set(local.map((s) => s.id));

        const cloudOnly = cloudFavs
          .filter((cf) => !localIds.has(cf.videoId))
          .map<Sermon>((cf) => ({
            id: cf.videoId,
            title: cf.videoTitle,
            description: "",
            youtubeId: cf.videoId,
            thumbnailUrl: cf.videoThumbnail,
            duration: "",
            category: cloudCategoryToSermonCategory(cf.videoCategory),
            preacher: "",
            date: cf.createdAt.slice(0, 10),
          }));

        if (cloudOnly.length === 0) return;

        const merged = [...local, ...cloudOnly];
        setFavorites(merged);
        setFavoriteIds(new Set(merged.map((s) => s.id)));
        await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(merged));
      })
      .catch(() => {});
  }, [token, loaded]);

  const persist = useCallback(async (updated: Sermon[]) => {
    setFavorites(updated);
    setFavoriteIds(new Set(updated.map((s) => s.id)));
    await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(updated));
  }, []);

  const addFavorite = useCallback(
    async (sermon: Sermon) => {
      if (favoriteIds.has(sermon.id)) return;
      await persist([sermon, ...favorites]);
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        // Cloud sync uses youtubeId for YouTube videos, falling back to id.
        apiSyncFavorite("add", {
          videoId: sermon.youtubeId || sermon.id,
          videoTitle: sermon.title,
          videoThumbnail: sermon.thumbnailUrl,
          videoCategory: sermon.category ?? "sermon",
        }).catch(() => {});
      });
    },
    [favorites, favoriteIds, persist],
  );

  const removeFavorite = useCallback(
    async (videoId: string) => {
      // Look up the stored sermon to recover its youtubeId for cloud sync.
      const toRemove = favorites.find((s) => s.id === videoId);
      await persist(favorites.filter((s) => s.id !== videoId));
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        apiSyncFavorite("remove", {
          videoId: toRemove?.youtubeId || videoId,
          videoTitle: "",
          videoThumbnail: "",
          videoCategory: "",
        }).catch(() => {});
      });
    },
    [favorites, persist],
  );

  const toggleFavorite = useCallback(
    async (sermon: Sermon) => {
      if (favoriteIds.has(sermon.id)) {
        await removeFavorite(sermon.id);
      } else {
        await addFavorite(sermon);
      }
    },
    [favoriteIds, addFavorite, removeFavorite],
  );

  const isFavorite = useCallback((videoId: string) => favoriteIds.has(videoId), [favoriteIds]);

  return { favorites, favoriteIds, isFavorite, toggleFavorite, addFavorite, removeFavorite, loaded };
}
