import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/constants/config";
import { apiSyncFavorite, apiGetFavorites } from "@/services/authApi";
import { useAuth } from "@/context/AuthContext";
import type { Sermon, SermonCategory } from "@/types";

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
          const parsed = JSON.parse(raw) as Sermon[];
          setFavorites(parsed);
          setFavoriteIds(new Set(parsed.map((s) => s.youtubeId)));
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
        const local: Sermon[] = raw ? (JSON.parse(raw) as Sermon[]) : [];
        const localIds = new Set(local.map((s) => s.youtubeId));

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
        setFavoriteIds(new Set(merged.map((s) => s.youtubeId)));
        await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(merged));
      })
      .catch(() => {});
  }, [token, loaded]);

  const persist = useCallback(async (updated: Sermon[]) => {
    setFavorites(updated);
    setFavoriteIds(new Set(updated.map((s) => s.youtubeId)));
    await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(updated));
  }, []);

  const addFavorite = useCallback(
    async (sermon: Sermon) => {
      if (favoriteIds.has(sermon.youtubeId)) return;
      await persist([sermon, ...favorites]);
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        apiSyncFavorite("add", {
          videoId: sermon.youtubeId,
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
      await persist(favorites.filter((s) => s.youtubeId !== videoId));
      hasAuthToken().then((loggedIn) => {
        if (!loggedIn) return;
        apiSyncFavorite("remove", {
          videoId,
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
      if (favoriteIds.has(sermon.youtubeId)) {
        await removeFavorite(sermon.youtubeId);
      } else {
        await addFavorite(sermon);
      }
    },
    [favoriteIds, addFavorite, removeFavorite],
  );

  const isFavorite = useCallback((videoId: string) => favoriteIds.has(videoId), [favoriteIds]);

  return { favorites, favoriteIds, isFavorite, toggleFavorite, addFavorite, removeFavorite, loaded };
}
