import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, Gauge } from "lucide-react";
import { youtubeQuotaApi, type YouTubeQuotaStatus } from "@/services/adminApi";
import { useSSEEvent } from "@/contexts/SSEContext";

/**
 * Live YouTube Data API quota banner.
 *
 * Surfaces two states the operator otherwise wouldn't see until logs filled
 * with `quotaExceeded` 403s:
 *
 *   • exhausted — solid red bar with the exact reset time. Triggered both by
 *     the polled status and by the real-time `youtube-quota-exhausted` SSE
 *     event broadcast the moment the gate engages.
 *   • near-cap (≥80%) — amber bar with current usage. Gives the operator
 *     several hours of headroom to throttle non-essential calls or wait
 *     out the day.
 *
 * Hidden entirely when usage is below the warn threshold and the gate is
 * inactive — no operator distraction during normal operation.
 *
 * Variants
 * ────────
 *   • `floating` (default) — fixed-position overlay at the top of the
 *     viewport. Mounted once globally in `App.tsx` so the warning is
 *     visible no matter which admin page the operator is on.
 *   • `inline` — a normal block-level element that flows with the page.
 *     Mounted directly inside the YouTube settings page so the warning
 *     is anchored to the surface where the operator actually triggers
 *     YouTube-dependent actions (paste-and-go-live, sync, override).
 *     This is the "persistent in-page warning" the surface needs — once
 *     you're on the YouTube settings page and quota is exhausted, you
 *     can't miss it and it doesn't get scrolled out of view by the
 *     overlay's z-index dance.
 */

const WARN_THRESHOLD_PCT = 80;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes is plenty — usage is best-effort

export interface YouTubeQuotaBannerProps {
  variant?: "floating" | "inline";
}

export function YouTubeQuotaBanner({ variant = "floating" }: YouTubeQuotaBannerProps = {}) {
  const [quota, setQuota] = useState<YouTubeQuotaStatus | null>(null);
  const [tickMs, setTickMs] = useState<number>(() => Date.now());

  const load = useCallback(async () => {
    try {
      const data = await youtubeQuotaApi.get();
      setQuota(data);
    } catch {
      // Banner is best-effort observability — never let a fetch error break
      // the dashboard. We simply leave the previous state in place.
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Re-render every minute while exhausted so the "resets in" countdown ticks.
  useEffect(() => {
    if (!quota?.exhausted) return;
    const t = setInterval(() => setTickMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [quota?.exhausted]);

  // Real-time push: the moment the API server hits the gate or auto-throttle
  // engages we refresh — no waiting for the 5-minute poll cycle.
  useSSEEvent("youtube-quota-exhausted", () => { void load(); });
  useSSEEvent("youtube-quota-throttled", () => { void load(); });

  if (!quota) return null;
  const throttledContexts = quota.throttle?.contexts ?? [];
  const isThrottling = throttledContexts.length > 0;
  if (
    !quota.exhausted &&
    !isThrottling &&
    quota.percentUsed < WARN_THRESHOLD_PCT
  ) {
    return null;
  }

  // Outer wrapper differs by variant — inner card content is identical so
  // the two modes stay visually consistent.
  const wrapperClass =
    variant === "floating"
      ? "pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-3"
      : "w-full";
  const cardWrapperClass =
    variant === "floating"
      ? "pointer-events-auto flex w-full max-w-3xl items-start gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-md backdrop-blur-sm"
      : "flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-sm";

  if (quota.exhausted && quota.exhaustedUntil) {
    const resetAt = new Date(quota.exhaustedUntil).getTime();
    const minsLeft = Math.max(0, Math.ceil((resetAt - tickMs) / 60_000));
    const hoursLeft = Math.floor(minsLeft / 60);
    const remainderMins = minsLeft % 60;
    const eta = hoursLeft > 0 ? `${hoursLeft}h ${remainderMins}m` : `${minsLeft}m`;
    return (
      <div className={wrapperClass} role="status" aria-live="polite" data-testid="youtube-quota-banner-exhausted">
        <div className={`${cardWrapperClass} border-red-500/40 bg-red-500/15`}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-700 dark:text-red-400 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-red-800 dark:text-red-300">
              YouTube Data API quota exhausted
            </p>
            <p className="text-xs text-red-700/80 dark:text-red-400/80 mt-0.5">
              Live status, video sync, and channel polls are paused. Resets in{" "}
              <span className="font-mono font-semibold">{eta}</span> (
              {new Date(quota.exhaustedUntil).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              local time).
            </p>
            {variant === "inline" && (
              <p className="text-xs text-red-700/70 dark:text-red-400/70 mt-1">
                Pasting a YouTube URL will still work, but live-status probes
                and metadata enrichment for this stream will fall back to the
                cached state until quota resets.
              </p>
            )}
          </div>
          <Clock className="h-3.5 w-3.5 shrink-0 text-red-700 dark:text-red-400 mt-1" />
        </div>
      </div>
    );
  }

  // Near-cap warning — amber, encourages the operator to act before exhaustion.
  return (
    <div className={wrapperClass} role="status" aria-live="polite" data-testid="youtube-quota-banner-warning">
      <div className={`${cardWrapperClass} border-amber-500/40 bg-amber-500/15`}>
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-amber-800 dark:text-amber-300">
            YouTube quota at {quota.percentUsed}% — approaching daily limit
          </p>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5">
            <span className="font-mono">
              {quota.estimatedUsedToday.toLocaleString()} /{" "}
              {quota.dailyLimit.toLocaleString()}
            </span>{" "}
            units used (estimate). Resets at{" "}
            {new Date(quota.nextResetAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </p>
          {isThrottling && (
            <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-1">
              Auto-throttle active — paused until reset:{" "}
              <span className="font-mono">{throttledContexts.join(", ")}</span>
            </p>
          )}
        </div>
        {variant === "inline" && (
          <Gauge className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400 mt-1" />
        )}
      </div>
    </div>
  );
}
