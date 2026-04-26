import { CheckCircle2, CloudUpload, Loader2, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useApiHealth } from "@/contexts/ApiHealthContext";
import { Button } from "@/components/ui/button";

/**
 * A single fixed banner pinned to the top of the viewport that surfaces
 * global API health. Hidden when the API is healthy. Visible states:
 *
 *   • deploying  — calm slate "Updating — viewers unaffected" with a small
 *                  spinner. Shown when /healthz reports `draining` or
 *                  `starting` (or a brief network gap immediately after a
 *                  drain). No "Retry now" button — it is not user-actionable
 *                  and would only generate distracting toasts during a
 *                  routine deploy.
 *   • degraded   — solid amber "API connection lost — reconnecting…" with
 *                  attempt counter and "Retry now". A genuine outage:
 *                  db_down, sustained 5xx, network failure with no recent
 *                  drain hint, or a deploy that exceeded the escalation
 *                  threshold (60s).
 *   • recovering — green pulse "Connection restored". Self-dismisses after
 *                  the provider transitions to "healthy".
 *
 * Layered above all page chrome (z-50) so it's visible regardless of which
 * page is mounted, and uses pointer-events on its inner card only so click
 * targets behind the empty banner edges still work normally.
 */
export function ApiReconnectionBanner() {
  const { status, lastReason, lastSource, probeAttempt, retryNow, degradedSinceMs } =
    useApiHealth();
  const [tickMs, setTickMs] = useState<number>(() => Date.now());

  // Re-render once a second while non-healthy so the duration clock ticks.
  useEffect(() => {
    if (status === "healthy" || status === "recovering") return;
    const t = setInterval(() => setTickMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [status]);

  if (status === "healthy") return null;

  const downForSec =
    (status === "degraded" || status === "deploying") && degradedSinceMs !== null
      ? Math.max(0, Math.round((tickMs - degradedSinceMs) / 1000))
      : 0;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3"
      role="status"
      aria-live="polite"
    >
      {status === "deploying" && (
        <div
          className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-lg border border-slate-400/40 bg-slate-500/15 px-4 py-2.5 text-sm shadow-md backdrop-blur-sm dark:border-slate-500/40"
          data-testid="banner-api-deploying"
        >
          <CloudUpload className="h-4 w-4 shrink-0 text-slate-700 dark:text-slate-200" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-slate-800 dark:text-slate-100">
              Updating — viewers unaffected
              {downForSec > 0 ? ` · ${downForSec}s` : ""}
            </p>
            <p className="truncate text-xs text-slate-700/80 dark:text-slate-300/80">
              The server is restarting. The admin will reconnect automatically
              in a few seconds.
            </p>
          </div>
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-700 dark:text-slate-200" />
        </div>
      )}
      {status === "degraded" && (
        <div
          className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm shadow-md backdrop-blur-sm"
          data-testid="banner-api-degraded"
        >
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
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm shadow-md backdrop-blur-sm"
          data-testid="banner-api-recovering"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
          <span className="font-medium text-emerald-800 dark:text-emerald-300">
            Connection restored
          </span>
        </div>
      )}
    </div>
  );
}
