import { useEffect, useRef, useState } from "react";

/**
 * Per-device "live YouTube embed failed" signal.
 *
 * Why a shared signal instead of localized error UI: the LiveHero (cinematic
 * preview) and the full-screen <Player> are independent React subtrees. When
 * one of them detects that the YouTube live iframe failed to load (network
 * issue, embed disabled, geo-block, etc.), we want BOTH surfaces to fall
 * through to the broadcast queue together — otherwise the hero keeps trying
 * to embed a dead URL while the player has already given up, or vice-versa.
 *
 * Mechanism: a tiny pub-sub keyed by videoId. When a failure is reported,
 * `useUnifiedLive` flips `isLive=false` for that videoId until either:
 *   • the cool-down expires (default 60 s) — auto-retry, the next fetch /
 *     SSE update will lift the suppression and the iframe gets one more try, OR
 *   • a different videoId becomes the active one (admin pasted a fresh URL,
 *     or YouTube's channel scrape returned a new live event) — clears the
 *     failure for the OLD ID since it's no longer the active stream.
 *
 * Scope: device-local. Cross-device coordination would require a backend
 * report endpoint and is out of scope (and risky — one flaky device must
 * not drag the whole platform off-air).
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

/**
 * Returns true when the supplied `videoId` is currently flagged as failed and
 * the cool-down window hasn't elapsed. Subscribes the caller to changes so
 * any report / clear / TTL expiry triggers a re-render.
 */
export function useLiveFailureFor(videoId: string | null | undefined): boolean {
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  // Schedule a re-render at the cool-down boundary so the suppression lifts
  // on its own without the caller needing a separate timer.
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
    // The active live stream has shifted to a different ID — the previous
    // failure no longer applies. Clear it as a side effect of the read so
    // we don't accumulate stale records.
    current = null;
    return false;
  }
  return Date.now() - current.failedAt < FAILURE_TTL_MS;
}

/**
 * Edge-triggered hook: returns `true` for `BANNER_VISIBLE_MS` ms after a
 * fresh failure is reported for `videoId`, then auto-flips back to `false`.
 *
 * Used to flash a one-shot "Live unavailable — playing the broadcast queue
 * instead" banner on the surface that's still mounted (the home hero on TV /
 * mobile). The player's instance back-navigates immediately on failure so
 * the home banner is what the viewer actually sees.
 *
 * "Fresh" is keyed by `failedAt` timestamp, so re-entering the page or
 * re-mounting after the TTL won't re-flash the banner — but a brand-new
 * failure (different `failedAt`) will.
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
