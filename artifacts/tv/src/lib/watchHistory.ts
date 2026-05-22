/**
 * Watch-history store — persists a log of all videos the viewer has watched,
 * including ones they completed. Unlike watch-progress (which only keeps
 * in-progress items and auto-evicts at 95%), history is an append-only log
 * capped at MAX_ENTRIES. Entries are upserted by videoId so re-watching a
 * video moves it to the top rather than creating a duplicate.
 */

const KEY = "ttv:watch-history:v1";
const MAX_ENTRIES = 100;

export interface HistoryEntry {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  hlsUrl: string | null;
  hlsMasterUrl?: string | null;
  positionSecs: number;
  durationSecs: number;
  /** true when the viewer reached ≥ 95 % of the video. */
  completed: boolean;
  watchedAt: number; // epoch ms
}

type HistoryStore = HistoryEntry[];

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readHistory(): HistoryStore {
  const s = safeStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryStore) : [];
  } catch {
    return [];
  }
}

function writeHistory(store: HistoryStore): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded — silently skip; history is best-effort.
  }
}

/**
 * Upsert a history entry. If the video was already logged, its record is
 * moved to the front with updated values. New entries are prepended.
 */
export function logWatch(
  entry: Omit<HistoryEntry, "watchedAt"> & { watchedAt?: number },
): void {
  const store = readHistory().filter((e) => e.videoId !== entry.videoId);
  store.unshift({ ...entry, watchedAt: entry.watchedAt ?? Date.now() });
  writeHistory(store.slice(0, MAX_ENTRIES));
}

/** Return all history entries, newest first. */
export function getWatchHistory(limit = MAX_ENTRIES): HistoryEntry[] {
  return readHistory().slice(0, limit);
}

/** Permanently remove all history entries. */
export function clearWatchHistory(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    // ignore
  }
}
