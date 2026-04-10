import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "@/constants/config";
import type { Sermon } from "@/types";

export function useFavorites() {
  const [favorites, setFavorites] = useState<Sermon[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

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

  const persist = useCallback(async (updated: Sermon[]) => {
    setFavorites(updated);
    setFavoriteIds(new Set(updated.map((s) => s.youtubeId)));
    await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(updated));
  }, []);

  const addFavorite = useCallback(
    async (sermon: Sermon) => {
      if (favoriteIds.has(sermon.youtubeId)) return;
      await persist([sermon, ...favorites]);
    },
    [favorites, favoriteIds, persist],
  );

  const removeFavorite = useCallback(
    async (videoId: string) => {
      await persist(favorites.filter((s) => s.youtubeId !== videoId));
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
