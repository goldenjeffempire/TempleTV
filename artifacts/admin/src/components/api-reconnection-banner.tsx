import { CheckCircle2, Loader2, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useApiHealth } from "@/contexts/ApiHealthContext";
import { Button } from "@/components/ui/button";

// A single fixed banner pinned to the top of the viewport that surfaces
// global API health. Hidden when the API is healthy. Three visible states:
//
//   • degraded   — solid amber bar, "API connection lost — reconnecting…"
//                  with attempt counter and "Retry now" button.
//   • recovering — green pulse, "Connection restored". Self-dismisses after
//                  the provider transitions to "healthy".
//
// Layered above all page chrome (z-50) so it's visible regardless of which
// page is mounted, and uses pointer-events on its inner card only so click
// targets behind the empty banner edges still work normally.
export function ApiReconnectionBanner() {
  const { status, lastReason, lastSource, probeAttempt, retryNow, degradedSinceMs } =
    useApiHealth();
  const [tickMs, setTickMs] = useState<number>(() => Date.now());

  // Re-render once a second while degraded so the "down for Xs" clock ticks.
  useEffect(() => {
    if (status !== "degraded") return;
    const t = setInterval(() => setTickMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [status]);

  if (status === "healthy") return null;

  const downForSec =
    status === "degraded" && degradedSinceMs !== null
      ? Math.max(0, Math.round((tickMs - degradedSinceMs) / 1000))
      : 0;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3"
      role="status"
      aria-live="polite"
    >
      {status === "degraded" && (
        <div className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm shadow-md backdrop-blur-sm">
          <WifiOff className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-amber-800 dark:text-amber-300">
              API connection lost — reconnecting
              {probeAttempt > 0 ? ` (attempt ${probeAttempt})` : ""}
              {downForSec > 0 ? ` · down for ${downForSec}s` : ""}
            </p>
            {lastReason && (
              <p className="truncate text-xs text-amber-700/80 dark:text-amber-400/80">
                {lastSource ? `${lastSource}: ` : ""}
                {lastReason}
              </p>
            )}
          </div>
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-700 dark:text-amber-400" />
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={retryNow}
          >
            Retry now
          </Button>
        </div>
      )}
      {status === "recovering" && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm shadow-md backdrop-blur-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
          <span className="font-medium text-emerald-800 dark:text-emerald-300">
            Connection restored
          </span>
        </div>
      )}
    </div>
  );
}
