/**
 * Watch-progress store — persists per-video playback positions in localStorage
 * so the TV app can offer a "Continue Watching" row across sessions.
 *
 * Rules:
 *  • Only save if positionSecs ≥ MIN_POSITION_SECS (don't clutter for skips)
 *  • Auto-clear if the viewer reached ≥ 95% of the video (consider it "done")
 *  • Cap at MAX_ENTRIES, evicting oldest first
 *
 * Side effects:
 *  • Every save also writes to the watch-history store (watchHistory.ts)
 *    so the History page can show both in-progress and completed videos.
 *  • Every save also fire-and-forgets a POST to /api/tv/history for
 *    cross-device continuity (serverSync.ts).
 *
 * Write strategy:
 *  • Writes from saveProgress() are debounced (WRITE_DEBOUNCE_MS) to avoid
 *    thrashing Smart TV NVRAM on rapid player timer callbacks (typically every
 *    5 s). clearProgress() always flushes immediately — clearing is critical.
 */

import { logWatch } from "./watchHistory";
import { syncProgressToServer } from "./serverSync";

const KEY = "ttv:watch-progress:v1";
const MAX_ENTRIES = 20;
const MIN_POSITION_SECS = 10;
const DONE_RATIO = 0.95;
/** Coalesce rapid consecutive saveProgress() calls into one localStorage write. */
const WRITE_DEBOUNCE_MS = 2_000;

export interface WatchEntry {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  hlsUrl: string | null;
  hlsMasterUrl?: string | null;
  positionSecs: number;
  durationSecs: number;
  updatedAt: number;
}

type Store = Record<string, WatchEntry>;

// ── Debounce state ────────────────────────────────────────────────────────────
let _writeTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingStore: Store | null = null;

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStore(): Store {
  const s = safeStorage();
  if (!s) return {};
  try {
    const raw = s.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded — silently skip; watch progress is best-effort.
  }
}

/**
 * Schedule a debounced localStorage write. Rapid consecutive calls (e.g. from
 * a player timer) coalesce into a single write fired WRITE_DEBOUNCE_MS after
 * the last call, protecting Smart TV NVRAM from unnecessary wear.
 */
function scheduleWrite(store: Store): void {
  _pendingStore = store;
  if (_writeTimer !== null) return; // will flush _pendingStore when it fires
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    if (_pendingStore !== null) {
      writeStore(_pendingStore);
      _pendingStore = null;
    }
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Flush any pending debounced write immediately. Called before clearProgress()
 * to ensure the latest in-progress state is persisted before clearing the entry.
 */
function flushWrite(): void {
  if (_writeTimer !== null) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  if (_pendingStore !== null) {
    writeStore(_pendingStore);
    _pendingStore = null;
  }
}

/** Upsert a progress entry. Automatically evicts entries considered "done". */
export function saveProgress(entry: WatchEntry): void {
  if (entry.positionSecs < MIN_POSITION_SECS) return;

  // If the viewer has reached ≥ 95% of the video, remove it from the
  // continue-watching store and mark it as completed in watch history.
  if (entry.durationSecs > 0 && entry.positionSecs / entry.durationSecs >= DONE_RATIO) {
    logWatch({
      videoId: entry.videoId,
      title: entry.title,
      thumbnailUrl: entry.thumbnailUrl,
      hlsUrl: entry.hlsUrl,
      hlsMasterUrl: entry.hlsMasterUrl,
      positionSecs: entry.positionSecs,
      durationSecs: entry.durationSecs,
      completed: true,
    });
    // Server sync — mark as completed
    syncProgressToServer({
      videoId: entry.videoId,
      title: entry.title,
      thumbnailUrl: entry.thumbnailUrl,
      hlsUrl: entry.hlsUrl,
      hlsMasterUrl: entry.hlsMasterUrl,
      positionSecs: entry.positionSecs,
      durationSecs: entry.durationSecs,
      completed: true,
      watchedAt: Date.now(),
    });
    clearProgress(entry.videoId);
    return;
  }

  const store = readStore();
  store[entry.videoId] = { ...entry, updatedAt: Date.now() };

  // Evict oldest entries beyond MAX_ENTRIES
  const all = Object.values(store).sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed: Store = {};
  for (const e of all.slice(0, MAX_ENTRIES)) {
    trimmed[e.videoId] = e;
  }
  // Debounced write — coalesces rapid timer callbacks into one NVRAM write
  scheduleWrite(trimmed);

  // Mirror every in-progress save to watch history (upsert — moves to front,
  // updates position) so the History page always shows current progress.
  logWatch({
    videoId: entry.videoId,
    title: entry.title,
    thumbnailUrl: entry.thumbnailUrl,
    hlsUrl: entry.hlsUrl,
    hlsMasterUrl: entry.hlsMasterUrl,
    positionSecs: entry.positionSecs,
    durationSecs: entry.durationSecs,
    completed: false,
  });

  // Server sync — in-progress (fire-and-forget)
  syncProgressToServer({
    videoId: entry.videoId,
    title: entry.title,
    thumbnailUrl: entry.thumbnailUrl,
    hlsUrl: entry.hlsUrl,
    hlsMasterUrl: entry.hlsMasterUrl,
    positionSecs: entry.positionSecs,
    durationSecs: entry.durationSecs,
    completed: false,
    watchedAt: Date.now(),
  });
}

/** Remove a specific video from the progress store. */
export function clearProgress(videoId: string): void {
  // Flush any pending debounced write first so the latest in-progress state
  // is persisted before we delete this entry from the store.
  flushWrite();
  const store = readStore();
  if (!(videoId in store)) return;
  delete store[videoId];
  writeStore(store);
}

/** Return the most recently watched entries, newest first. */
export function getRecentProgress(limit = 5): WatchEntry[] {
  return Object.values(readStore())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Return a single entry, or null if not found. */
export function getProgress(videoId: string): WatchEntry | null {
  return readStore()[videoId] ?? null;
}
