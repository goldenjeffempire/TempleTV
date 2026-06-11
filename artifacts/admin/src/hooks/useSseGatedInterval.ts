import { useEffect, useRef, useState } from "react";
import { useSSE } from "@/contexts/sse-context";

const RECONNECT_GRACE_MS = 15_000;

/**
 * Returns a `refetchInterval` value for TanStack Query that suppresses background
 * HTTP polling while the admin SSE channel is healthy — SSE push-invalidation
 * handles cache freshness in real time, making redundant polling wasteful.
 *
 * Falls back to `fallbackMs` when the SSE channel is unavailable so data stays
 * fresh even without push events.
 *
 * Grace period: when SSE drops from "connected" to any other state, polling is
 * suppressed for 15 s to give the channel time to re-establish before falling
 * back to HTTP. This prevents a burst of HTTP fetches during brief blips (tab
 * wake-up, server restart, transient network hiccup).
 *
 * Initial phase: before SSE has ever connected, fallback polling starts
 * immediately so queries are hydrated before the first SSE handshake.
 *
 * Usage:
 *   const sseInterval = useSseGatedInterval(30_000);
 *   useQuery({ ..., refetchInterval: sseInterval });
 */
export function useSseGatedInterval(fallbackMs: number): number | false {
  const { state } = useSSE();
  const everConnectedRef = useRef(false);
  const disconnectedAtRef = useRef<number | null>(null);
  // Used to trigger a re-render once the grace period expires so the returned
  // value transitions from `false` to `fallbackMs` without requiring an
  // external event (state hasn't changed, only time has elapsed).
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (state === "connected") {
      everConnectedRef.current = true;
      disconnectedAtRef.current = null;
      return;
    }
    // On first transition from connected → non-connected, record the timestamp
    // and schedule a re-render after the grace period to activate fallback polling.
    if (disconnectedAtRef.current === null && everConnectedRef.current) {
      disconnectedAtRef.current = Date.now();
      const timer = setTimeout(() => forceUpdate((n) => n + 1), RECONNECT_GRACE_MS);
      return () => clearTimeout(timer);
    }
  }, [state]);

  // SSE is live — push-invalidation handles freshness, no polling needed.
  if (state === "connected") return false;

  // Initial connecting phase (never yet established): start fallback polling
  // immediately so data loads before the first SSE connection.
  if (!everConnectedRef.current) return fallbackMs;

  // Reconnect grace window: suppress polling for 15 s to give the SSE channel
  // time to recover before falling back to HTTP polling.
  if (disconnectedAtRef.current !== null) {
    const elapsed = Date.now() - disconnectedAtRef.current;
    if (elapsed < RECONNECT_GRACE_MS) return false;
  }

  return fallbackMs;
}
