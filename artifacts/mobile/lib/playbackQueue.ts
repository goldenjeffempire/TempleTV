/**
 * Playback queue store — Library Next/Previous navigation.
 *
 * Module-level singleton that mirrors the ordered Sermon list the Library
 * screen is currently showing. Set by `library.tsx` right before navigation
 * to /player, then read by the player screen to derive prev/next siblings
 * for in-player controls and the post-video autoplay countdown.
 *
 * Design rationale:
 *  • Library uses server-side pagination + debounced search/filter/sort —
 *    re-fetching that exact ordering inside the player would double the API
 *    load AND introduce a race where the visible "Next" changes mid-watch.
 *    A snapshot at navigation time freezes the order for the watch session,
 *    matching what the user saw in the list when they tapped.
 *  • A pure cached snapshot (vs. passing the full list through URL params)
 *    avoids URL-length limits and JSON parse cost on every screen mount.
 *  • Subscriptions are reactive (useSyncExternalStore-compatible) so the
 *    player UI updates if the library keeps loading more pages while the
 *    user is mid-watch.
 *
 * Lifetime: cleared by the library screen when its filter context fundamentally
 * changes (different category/search/sort) and on app cold-start (module
 * reload). Not persisted to AsyncStorage — playback continuity across
 * app restarts is out of scope for the queue.
 */

import type { Sermon } from "@/types";

interface QueueSnapshot {
  items: readonly Sermon[];
  currentId: string | null;
  /**
   * A monotonically-increasing integer that bumps whenever the queue
   * contents change. Lets consumers using useSyncExternalStore detect
   * mutations even when the items array reference is stable.
   */
  revision: number;
}

let items: Sermon[] = [];
let currentId: string | null = null;
let revision = 0;
let cachedSnapshot: QueueSnapshot = { items, currentId, revision };

const listeners = new Set<() => void>();

function publish() {
  revision++;
  cachedSnapshot = { items, currentId, revision };
  listeners.forEach((fn) => {
    try { fn(); } catch { /* swallow listener errors */ }
  });
}

export const playbackQueue = {
  /**
   * Replace the queue with a fresh ordered list and mark `id` as the
   * currently-playing item. Called by Library on tap-to-play.
   */
  set(newItems: readonly Sermon[], id: string): void {
    items = newItems.slice();
    currentId = id;
    publish();
  },

  /**
   * Merge additional items into the existing queue when the library
   * loads another page. Deduplicates by id and preserves existing order
   * (new items are appended). Cheap no-op when nothing actually changed
   * so the library can call this unconditionally from an effect.
   */
  extend(newItems: readonly Sermon[]): void {
    if (newItems.length === 0) return;
    const ids = new Set(items.map((s) => s.id));
    const additions = newItems.filter((s) => !ids.has(s.id));
    if (additions.length === 0) return;
    items = items.concat(additions);
    publish();
  },

  /** Update the currently-playing pointer (e.g. after auto-advance). */
  setCurrent(id: string): void {
    if (currentId === id) return;
    currentId = id;
    publish();
  },

  /** Drop the queue — used when the library's filter context changes. */
  clear(): void {
    if (items.length === 0 && currentId === null) return;
    items = [];
    currentId = null;
    publish();
  },

  getSnapshot(): QueueSnapshot {
    return cachedSnapshot;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

/** Sermon immediately after the current pointer, or null at the tail. */
export function getNextSermon(snapshot: QueueSnapshot): Sermon | null {
  if (!snapshot.currentId || snapshot.items.length === 0) return null;
  const idx = snapshot.items.findIndex((s) => s.id === snapshot.currentId);
  if (idx < 0 || idx >= snapshot.items.length - 1) return null;
  return snapshot.items[idx + 1] ?? null;
}

/** Sermon immediately before the current pointer, or null at the head. */
export function getPrevSermon(snapshot: QueueSnapshot): Sermon | null {
  if (!snapshot.currentId || snapshot.items.length === 0) return null;
  const idx = snapshot.items.findIndex((s) => s.id === snapshot.currentId);
  if (idx <= 0) return null;
  return snapshot.items[idx - 1] ?? null;
}

/** Zero-based position within the queue (-1 if not found). */
export function getCurrentIndex(snapshot: QueueSnapshot): number {
  if (!snapshot.currentId) return -1;
  return snapshot.items.findIndex((s) => s.id === snapshot.currentId);
}
