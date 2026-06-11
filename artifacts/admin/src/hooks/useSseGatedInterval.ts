import { useEffect, useRef, useState } from "react";
import { useSSE } from "@/contexts/sse-context";

const RECONNECT_GRACE_MS = 15_000;

/**
 * Returns a `refetchInterval` value for TanStack Query that gates background
 * HTTP polling on admin SSE channel health.
 *
 * @param connectedMs    Interval while SSE is connected. Pass `false` to
 *                       suppress polling entirely (most queries benefit from
 *                       this — SSE push-invalidation handles freshness).
 * @param disconnectedMs Safety-net fallback interval used when SSE is
 *                       unavailable, so data stays fresh without push events.
 *
 * Grace period: when SSE drops from "connected" to any other state, polling is
 * suppressed for 15 s to give the channel time to re-establish before falling
 * back to HTTP. This prevents a request burst during brief blips (tab
 * wake-up, server restart, transient network hiccup).
 *
 * Initial phase: before SSE has ever connected, `disconnectedMs` polling starts
 * immediately so queries are hydrated before the first SSE handshake completes.
 *
 * Timer robustness: the grace timer is stored in a ref so it survives
 * multiple state transitions (connecting → reconnecting → degraded) without
 * being inadvertently cancelled by React's effect cleanup cycle.
 *
 * Usage:
 *   const interval = useSseGatedInterval(false, 60_000);
 *   useQuery({ ..., refetchInterval: interval });
 */
export function useSseGatedInterval(
  connectedMs: number | false,
  disconnectedMs: number,
): number | false {
  const { state } = useSSE();
  const everConnectedRef = useRef(false);
  const disconnectedAtRef = useRef<number | null>(null);
  // Store timer in a ref so effect cleanup on state transitions does NOT cancel
  // an in-flight grace timer (the original bug: setTimeout return value in a
  // local const was cleared by the cleanup return of a subsequent effect run).
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Trigger a re-render once the grace period expires so the returned value
  // transitions from `false` → `disconnectedMs` without an external SSE event.
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (state === "connected") {
      everConnectedRef.current = true;
      disconnectedAtRef.current = null;
      if (graceTimerRef.current !== null) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      return;
    }

    // Record the disconnection timestamp on the first non-connected transition.
    if (disconnectedAtRef.current === null && everConnectedRef.current) {
      disconnectedAtRef.current = Date.now();
    }

    // Ensure a grace timer is running whenever we have a disconnectedAt
    // timestamp but no timer is active.  This handles state changes like
    // reconnecting → degraded that re-run this effect: the old cleanup did NOT
    // cancel graceTimerRef (it's a ref), so we only schedule a new one when
    // the ref is null (timer was never started, or just fired).
    if (disconnectedAtRef.current !== null && graceTimerRef.current === null) {
      const elapsed = Date.now() - disconnectedAtRef.current;
      const remaining = Math.max(0, RECONNECT_GRACE_MS - elapsed);
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        forceUpdate((n) => n + 1);
      }, remaining);
    }
  }, [state]);

  // Cancel any pending grace timer on unmount.
  useEffect(() => {
    return () => {
      if (graceTimerRef.current !== null) {
        clearTimeout(graceTimerRef.current);
      }
    };
  }, []);

  // SSE is live — use the caller-specified connected interval.
  if (state === "connected") return connectedMs;

  // Initial connecting phase (never yet established): start fallback polling
  // immediately so queries are hydrated before the first SSE handshake.
  if (!everConnectedRef.current) return disconnectedMs;

  // Reconnect grace window: suppress polling briefly to avoid a request burst.
  if (disconnectedAtRef.current !== null) {
    const elapsed = Date.now() - disconnectedAtRef.current;
    if (elapsed < RECONNECT_GRACE_MS) return false;
  }

  return disconnectedMs;
}
