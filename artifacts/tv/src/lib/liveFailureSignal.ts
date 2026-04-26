import { useEffect, useState } from "react";

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
