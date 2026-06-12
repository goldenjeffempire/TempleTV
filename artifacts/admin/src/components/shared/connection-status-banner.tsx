import { useState, useEffect } from "react";
import { useSSE } from "@/contexts/sse-context";
import { WifiOff, Loader2, X, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Persistent banner rendered between the header and page content whenever the
 * SSE connection is not fully established. Operators get clear, always-visible
 * signal that live data is paused or delayed — critical for a 24/7 control room
 * where stale queue or broadcast state must never go unnoticed.
 *
 * States:
 *   offline      → red   "Disconnected — live updates paused."
 *   reconnecting → amber "Reconnecting to live updates…"
 *   degraded     → amber "Live updates degraded — data may be delayed."
 *
 * Auto-dismisses (re-shows without interaction) when SSE reconnects so the
 * operator never needs to manually hide it after recovery.
 */
export function ConnectionStatusBanner() {
  const { state, forceReconnect } = useSSE();
  const [dismissed, setDismissed] = useState(false);

  // Auto-reset the dismissed flag on every reconnect so the banner re-appears
  // if SSE drops again later in the same session.
  useEffect(() => {
    if (state === "connected") setDismissed(false);
  }, [state]);

  const visible =
    !dismissed &&
    (state === "offline" || state === "degraded" || state === "reconnecting");

  if (!visible) return null;

  const isOffline = state === "offline";
  const isReconnecting = state === "reconnecting";

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
        {isOffline
          ? "Disconnected — live updates paused. Data on screen may be stale."
          : isReconnecting
            ? "Reconnecting to live updates…"
            : "Live updates degraded — some data may be delayed."}
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
