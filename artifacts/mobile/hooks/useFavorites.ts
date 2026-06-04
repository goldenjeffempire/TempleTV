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
  // Ref that mirrors `favorites` state so that addFavorite / removeFavorite
  // always read the *latest* list even when called in rapid succession before
  // React has re-rendered (stale-closure race condition).
  const favoritesRef = useRef<Sermon[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.favorites)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Sermon[];
            favoritesRef.current = parsed;
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
        // favoritesRef is the source of truth: it is seeded from AsyncStorage
        // on mount (this effect only runs once `loaded` is true) and kept fresh
        // by persist() on every add/remove. Merging against it — rather than a
        // stale AsyncStorage snapshot read *before* the network await — prevents
        // a lost-update race where a favorite the user adds while this cloud
        // sync is in flight would be silently overwritten on commit.
        const current = favoritesRef.current;
        const currentIds = new Set(current.map((s) => s.id));

        // Use s.id for dedup — matches the same key used throughout this hook.
        const cloudOnly = cloudFavs
          .filter((cf) => !currentIds.has(cf.videoId))
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

        // Re-read favoritesRef at commit time and dedup again so any add/remove
        // that landed during the synchronous map above is preserved.
        const latest = favoritesRef.current;
        const latestIds = new Set(latest.map((s) => s.id));
        const merged = [...latest, ...cloudOnly.filter((s) => !latestIds.has(s.id))];
        favoritesRef.current = merged;
        setFavorites(merged);
        setFavoriteIds(new Set(merged.map((s) => s.id)));
        await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(merged)).catch(() => {});
      })
      .catch(() => {});
  }, [token, loaded]);

  const persist = useCallback(async (updated: Sermon[]) => {
    // Update the ref *before* setState so subsequent calls within the same
    // event loop tick (before re-render) read the fresh list.
    favoritesRef.current = updated;
    setFavorites(updated);
    setFavoriteIds(new Set(updated.map((s) => s.id)));
    await AsyncStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(updated)).catch(() => {});
  }, []);

  const addFavorite = useCallback(
    async (sermon: Sermon) => {
      // Read favoritesRef (not `favorites` state) so concurrent calls build
      // on the latest list instead of the stale closure from the last render.
      const current = favoritesRef.current;
      if (current.some((s) => s.id === sermon.id)) return;
      await persist([sermon, ...current]);
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
    [persist],
  );

  const removeFavorite = useCallback(
    async (videoId: string) => {
      // Read favoritesRef (not `favorites` state) so concurrent calls build
      // on the latest list instead of the stale closure from the last render.
      const current = favoritesRef.current;
      const toRemove = current.find((s) => s.id === videoId);
      await persist(current.filter((s) => s.id !== videoId));
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
    [persist],
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
