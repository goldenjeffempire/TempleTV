/**
 * Favorites store for the TV app.
 *
 * Persists in localStorage. When the viewer is signed in, also syncs to the
 * server's user-favorites endpoint via authFetch so favorites are shared across
 * devices.
 *
 * Reactive: call `subscribeFavorites(fn)` to receive updates whenever the
 * store changes (used by `useFavorites` hook).
 */

import { authFetch, isLoggedIn } from "./auth";
import { resolveApiOrigin } from "./api";

const KEY = "ttv:favorites:v2";
const MAX_ENTRIES = 200;

export interface FavoriteEntry {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  hlsUrl: string | null;
  addedAt: number;
}

type Store = FavoriteEntry[];
type Listener = () => void;

const listeners = new Set<Listener>();

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* swallow */ }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch { return null; }
}

function readStore(): Store {
  const s = safeStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Store) : [];
  } catch { return []; }
}

function writeStore(store: Store): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(store.slice(0, MAX_ENTRIES)));
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[favorites] Failed to write to storage:", e);
    }
    /* quota exceeded — best-effort */
  }
}

/** Subscribe to store changes. Returns an unsubscribe function. */
export function subscribeFavorites(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Return all favorites, newest first. */
export function getFavorites(): FavoriteEntry[] {
  return readStore().sort((a, b) => b.addedAt - a.addedAt);
}

/** Check whether a video is favorited. */
export function isFavorite(videoId: string): boolean {
  return readStore().some((e) => e.videoId === videoId);
}

/** Add a video to favorites. Idempotent — re-adding only updates addedAt. */
export function addFavorite(entry: Omit<FavoriteEntry, "addedAt">): void {
  const store = readStore().filter((e) => e.videoId !== entry.videoId);
  store.unshift({ ...entry, addedAt: Date.now() });
  writeStore(store);
  notify();
  // Fire-and-forget server sync when authenticated
  syncFavoriteToServer(entry.videoId, entry.title, entry.thumbnailUrl, "add");
}

/** Remove a video from favorites. */
export function removeFavorite(videoId: string): void {
  const store = readStore().filter((e) => e.videoId !== videoId);
  writeStore(store);
  notify();
  syncFavoriteToServer(videoId, "", "", "remove");
}

/** Toggle favorite status. Returns the new state (true = now favorited). */
export function toggleFavorite(entry: Omit<FavoriteEntry, "addedAt">): boolean {
  if (isFavorite(entry.videoId)) {
    removeFavorite(entry.videoId);
    return false;
  } else {
    addFavorite(entry);
    return true;
  }
}

/** Clear all favorites locally (does not call server). */
export function clearFavorites(): void {
  const s = safeStorage();
  if (!s) return;
  try { s.removeItem(KEY); } catch { /* ignore */ }
  notify();
}

function apiUrl(path: string): string {
  return `${resolveApiOrigin()}/api${path}`;
}

function syncFavoriteToServer(
  videoId: string,
  _title: string,
  _thumbnailUrl: string,
  action: "add" | "remove",
): void {
  if (!isLoggedIn()) return;
  if (action === "add") {
    authFetch(apiUrl("/user/favorites"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  } else {
    authFetch(apiUrl(`/user/favorites/${encodeURIComponent(videoId)}`), {
      method: "DELETE",
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }
}

/**
 * Hydrate favorites from the server when the user is signed in.
 * Merges server favorites into local store (server wins for videoId overlap).
 * Call once on app mount after auth state is confirmed.
 */
export async function hydrateFavoritesFromServer(): Promise<void> {
  if (!isLoggedIn()) return;
  try {
    const res = await authFetch(apiUrl("/user/favorites"), {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as Array<{
      videoId: string;
      videoTitle?: string;
      videoThumbnail?: string;
    }>;
    if (!Array.isArray(data)) return;

    const existing = readStore();
    const existingIds = new Set(existing.map((e) => e.videoId));
    const merged = [...existing];
    for (const item of data) {
      if (!existingIds.has(item.videoId)) {
        merged.push({
          videoId: item.videoId,
          title: item.videoTitle ?? "",
          thumbnailUrl: item.videoThumbnail ?? "",
          hlsUrl: null,
          addedAt: Date.now(),
        });
      }
    }
    writeStore(merged);
    notify();
  } catch {
    /* server hydration is best-effort */
  }
}
