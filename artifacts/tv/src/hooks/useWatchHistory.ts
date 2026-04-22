/**
 * useWatchHistory — TV Watch History & Continue Watching
 * =====================================================
 * Persists to localStorage so history survives app restarts.
 * Stores the last 20 items, most-recent first.
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ttv_watch_history_v2";
const MAX_ITEMS = 20;
const MIN_WATCH_SECS = 30;     // ignore plays shorter than 30s
const COMPLETE_THRESHOLD = 0.92; // 92% → mark as complete, hide from Continue Watching

export interface WatchHistoryEntry {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelName: string;
  duration: string;
  positionSecs: number;
  durationSecs: number;
  progressPct: number;          // 0–100
  watchedAt: number;            // epoch ms
  isComplete: boolean;
}

function load(): WatchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WatchHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function save(entries: WatchHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

// ── Singleton state so multiple hook instances share the same data ─────────

let _entries: WatchHistoryEntry[] = load();
const _listeners: Set<() => void> = new Set();

function notify(): void {
  for (const cb of _listeners) cb();
}

function setEntries(next: WatchHistoryEntry[]): void {
  _entries = next;
  save(next);
  notify();
}

// ── Public API ─────────────────────────────────────────────────────────────

export function recordProgress(
  video: {
    videoId: string;
    title: string;
    thumbnailUrl: string;
    channelName: string;
    duration: string;
  },
  positionSecs: number,
  durationSecs: number,
): void {
  if (positionSecs < MIN_WATCH_SECS) return;
  const progressPct = durationSecs > 0
    ? Math.min(100, Math.round((positionSecs / durationSecs) * 100))
    : 0;
  const isComplete = durationSecs > 0
    ? positionSecs / durationSecs >= COMPLETE_THRESHOLD
    : false;

  const existing = _entries.findIndex((e) => e.videoId === video.videoId);
  const entry: WatchHistoryEntry = {
    ...video,
    positionSecs: Math.floor(positionSecs),
    durationSecs: Math.floor(durationSecs),
    progressPct,
    watchedAt: Date.now(),
    isComplete,
  };

  const next = [..._entries];
  if (existing !== -1) next.splice(existing, 1);
  next.unshift(entry);
  setEntries(next.slice(0, MAX_ITEMS));
}

export function clearHistory(): void {
  setEntries([]);
}

export function removeFromHistory(videoId: string): void {
  setEntries(_entries.filter((e) => e.videoId !== videoId));
}

// ── React hook ────────────────────────────────────────────────────────────

export function useWatchHistory() {
  const [entries, setLocal] = useState<WatchHistoryEntry[]>(_entries);

  useEffect(() => {
    const cb = () => setLocal([..._entries]);
    _listeners.add(cb);
    return () => { _listeners.delete(cb); };
  }, []);

  const continueWatching = entries.filter((e) => !e.isComplete);

  const record = useCallback(
    (
      video: { videoId: string; title: string; thumbnailUrl: string; channelName: string; duration: string },
      positionSecs: number,
      durationSecs: number,
    ) => recordProgress(video, positionSecs, durationSecs),
    [],
  );

  return {
    history: entries,
    continueWatching,
    record,
    clearHistory,
    removeFromHistory,
  };
}
