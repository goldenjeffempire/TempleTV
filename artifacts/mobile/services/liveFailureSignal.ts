import { useEffect, useRef, useState } from "react";

/**
 * Per-device "live YouTube embed failed" signal — mobile twin of
 * `artifacts/tv/src/lib/liveFailureSignal.ts`. See that file for the
 * full design rationale.
 *
 * On mobile the consumers are:
 *   • `app/(tabs)/index.tsx`'s hero iframe (web only) — reports on
 *     iframe `onError` / load watchdog timeout.
 *   • `app/player.tsx` when `isLive=true` and the underlying
 *     `<YoutubePlayer>` fires `onError`.
 *
 * Both surfaces also read the signal: the hero treats `isLive=false` so
 * `showBroadcast` activates and renders the broadcast queue fallback;
 * the player auto-navigates back to home (where the hero now shows the
 * fallback) instead of staring at a broken iframe.
 */

const FAILURE_TTL_MS = 60_000;

interface FailureRecord {
  videoId: string;
  failedAt: number;
}

let current: FailureRecord | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function reportLiveFailure(videoId: string | null | undefined): void {
  if (!videoId) return;
  current = { videoId, failedAt: Date.now() };
  notify();
}

export function clearLiveFailure(): void {
  if (!current) return;
  current = null;
  notify();
}

export function useLiveFailureFor(videoId: string | null | undefined): boolean {
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!current || current.videoId !== videoId) return;
    const elapsed = Date.now() - current.failedAt;
    const remaining = FAILURE_TTL_MS - elapsed;
    if (remaining <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), remaining);
    return () => clearTimeout(t);
  }, [videoId, current?.failedAt]);

  if (!current || !videoId) return false;
  if (current.videoId !== videoId) {
    current = null;
    return false;
  }
  return Date.now() - current.failedAt < FAILURE_TTL_MS;
}

/**
 * Edge-triggered hook: returns `true` for `BANNER_VISIBLE_MS` ms after a
 * fresh failure is reported for `videoId`, then auto-flips back to `false`.
 * Used to flash a one-shot fallback banner on the home hero.
 *
 * "Fresh" is keyed by `failedAt` so re-mounting the consumer after the
 * banner already played won't re-flash it.
 */
const BANNER_VISIBLE_MS = 5_000;

export function useLiveFallbackJustTriggered(videoId: string | null | undefined): boolean {
  const [visible, setVisible] = useState(false);
  const lastSeenAtRef = useRef<number | null>(null);

  useEffect(() => {
    const evaluate = () => {
      if (!videoId || !current || current.videoId !== videoId) return;
      if (lastSeenAtRef.current === current.failedAt) return;
      lastSeenAtRef.current = current.failedAt;
      setVisible(true);
      const t = setTimeout(() => setVisible(false), BANNER_VISIBLE_MS);
      return () => clearTimeout(t);
    };
    const cleanup = evaluate();
    const fn = () => evaluate();
    listeners.add(fn);
    return () => {
      if (typeof cleanup === "function") cleanup();
      listeners.delete(fn);
    };
  }, [videoId]);

  return visible;
}
