import { useState, useEffect, useRef } from "react";
import { useSSE } from "@/contexts/sse-context";
import { WifiOff, Loader2, X, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Format a duration in milliseconds as a human-readable "X ago" string.
 * Ticks are driven by a 15-second interval so the display stays current
 * without hammering the renderer every second.
 */
function formatAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hr${hrs !== 1 ? "s" : ""} ago`;
}

/**
 * Persistent banner rendered between the header and page content whenever the
 * SSE connection is not fully established. Operators get clear, always-visible
 * signal that live data is paused or delayed — critical for a 24/7 control room
 * where stale queue or broadcast state must never go unnoticed.
 *
 * States:
 *   offline      → red   "Disconnected — live updates paused. Last synced X ago."
 *   reconnecting → amber "Reconnecting to live updates…"
 *   degraded     → amber "Live updates degraded — data may be delayed."
 *
 * Auto-dismisses (re-shows without interaction) when SSE reconnects so the
 * operator never needs to manually hide it after recovery.
 *
 * Offline state additionally shows when data was last successfully synced so
 * operators can assess staleness at a glance without navigating to another page.
 */
export function ConnectionStatusBanner() {
  const { state, forceReconnect } = useSSE();
  const [dismissed, setDismissed] = useState(false);

  // Track the wall-clock time at which SSE last transitioned to "connected".
  // Initialised to Date.now() so on first render the label reads "just now"
  // rather than a confusingly large duration. A ref holds the canonical value;
  // the state copy drives the 15-second live re-render.
  const lastConnectedRef = useRef<number>(Date.now());
  const [lastConnected, setLastConnected] = useState<number>(Date.now());

  // Capture when we successfully reconnect.
  useEffect(() => {
    if (state === "connected") {
      const now = Date.now();
      lastConnectedRef.current = now;
      setLastConnected(now);
      setDismissed(false);
    }
  }, [state]);

  // Live-update the "X ago" label every 15 s while the banner is visible.
  // Using 15 s instead of 1 s avoids unnecessary re-renders — the granularity
  // is still fine enough that operators see meaningful changes.
  useEffect(() => {
    const visible =
      state === "offline" || state === "degraded" || state === "reconnecting";
    if (!visible || dismissed) return;

    const id = setInterval(() => {
      setLastConnected(lastConnectedRef.current);
    }, 15_000);
    return () => clearInterval(id);
  }, [state, dismissed]);

  const visible =
    !dismissed &&
    (state === "offline" || state === "degraded" || state === "reconnecting");

  if (!visible) return null;

  const isOffline = state === "offline";
  const isReconnecting = state === "reconnecting";
  const syncAge = Date.now() - lastConnected;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "flex items-center gap-3 px-4 py-2 text-xs font-medium shrink-0 select-none",
        isOffline
          ? "bg-red-600 text-white"
          : "bg-amber-500 text-white",
      )}
    >
      {isOffline ? (
        <WifiOff size={13} className="shrink-0" aria-hidden="true" />
      ) : (
        <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />
      )}

      <span className="flex-1 min-w-0 leading-snug">
        {isOffline ? (
          <>
            Disconnected — live updates paused.
            <span className="opacity-75 ml-1">
              Last synced {formatAgo(syncAge)}.
            </span>
          </>
        ) : isReconnecting ? (
          "Reconnecting to live updates…"
        ) : (
          "Live updates degraded — some data may be delayed."
        )}
      </span>

      {!isReconnecting && (
        <button
          type="button"
          onClick={forceReconnect}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-white/30 hover:bg-white/15 transition-colors whitespace-nowrap"
        >
          <RotateCw size={11} aria-hidden="true" />
          Retry
        </button>
      )}

      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss connection alert"
        className="shrink-0 p-0.5 rounded hover:bg-white/15 transition-colors"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
