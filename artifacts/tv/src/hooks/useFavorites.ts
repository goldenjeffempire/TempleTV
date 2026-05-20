/**
 * Reactive hook for the TV favorites store.
 * Subscribes to localStorage changes so any component updates instantly
 * when a favorite is added or removed anywhere in the app.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getFavorites,
  isFavorite,
  toggleFavorite,
  subscribeFavorites,
  type FavoriteEntry,
} from "../lib/favorites";

export function useFavorites(): {
  favorites: FavoriteEntry[];
  isFav: (videoId: string) => boolean;
  toggle: (entry: Omit<FavoriteEntry, "addedAt">) => boolean;
  count: number;
} {
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => getFavorites());

  useEffect(() => {
    const unsub = subscribeFavorites(() => {
      setFavorites(getFavorites());
    });
    return unsub;
  }, []);

  const isFav = useCallback((videoId: string) => isFavorite(videoId), []);

  const toggle = useCallback(
    (entry: Omit<FavoriteEntry, "addedAt">) => {
      const result = toggleFavorite(entry);
      setFavorites(getFavorites());
      return result;
    },
    [],
  );

  return { favorites, isFav, toggle, count: favorites.length };
}
