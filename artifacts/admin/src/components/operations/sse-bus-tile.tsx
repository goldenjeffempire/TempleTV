import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/operations/status-badge";
import type { SSEBusStatus } from "@/services/adminApi";

/**
 * Compact relative-time formatter for "X ago" style timestamps.
 *
 * Returns "never" when given 0 (the sentinel value used by `BusStatsSnapshot
 * .lastPublishErrorAt` / `lastReceiveErrorAt` for "no error has ever
 * occurred"). Returns "just now" inside a 5s window so a brand-new error
 * doesn't immediately read as a stale "0s ago".
 *
 * Note: only re-renders when the parent poll fires (currently 30s on the
 * Operations page) — that's intentional. Per-second updates would require a
 * separate ticker and add no operational value when reading historical
 * errors. The poll cadence sets the granularity of how fresh "just now"
 * really is, which is fine for "last error" displays.
 *
 * Module-private because no other place in the dashboard needs this exact
 * format yet — when a second consumer appears, lift it to a shared utility.
 */
function formatTimeAgo(unixMs: number): string {
  if (!unixMs) return "never";
  const diffSec = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Format one side (sent / received) of the live rate line, returning
 * null when there's nothing meaningful to display so the caller can
 * `.filter()` it out.
 *
 * Decision matrix (current = client-side delta-sampled "now" rate,
 * peak = max value in the server-side 5-minute ring buffer):
 *
 *   current  peak    →  output
 *   -------  ------     --------------------------------
 *      0       0     →  null                (idle bus, nothing to say)
 *      0      >0     →  "5m peak N/min L"   (recent burst, now quiet)
 *     >0      =cur   →  "~N/min L"          (peak suffix would be noise)
 *     >0      >cur   →  "~N/min L (peak P)" (current vs typical)
 *
 * The "peak <= current" case includes both peak == current (we're at the
 * peak right now) and peak < current (which can happen briefly when the
 * client-side average over 30s catches a burst that the server-side 10s
 * sampler hasn't yet recorded a full window for). Either way, showing
 * the peak adds no information.
 */
function formatRateForSide(
  label: string,
  current: number,
  peak: number,
): string | null {
  if (current === 0 && peak === 0) return null;
  if (current === 0) return `5m peak ${peak}/min ${label}`;
  if (peak > current) return `~${current}/min ${label} (peak ${peak})`;
  return `~${current}/min ${label}`;
}

/**
 * Cross-instance SSE bus tile for the Infrastructure card on the Operations
 * page. Three rendered states map to the server-side `health` field:
 *
 *   - undefined / health="off" → neutral grey "Disabled" badge with helpful
 *     copy. This is the supported default for single-instance deploys; it
 *     is NOT an error and must NOT be styled like one.
 *   - "ok"       → emerald "Healthy" badge, summary copy from server.
 *   - "degraded" → amber "Degraded" badge, summary copy from server.
 *
 * `undefined` covers two real cases:
 *   1. The api-server is older than Round 18 (field doesn't exist yet).
 *   2. The api-server returned an error from /admin/ops/status before the
 *      sseBus block was built (the catch handler in the route).
 * Both are treated as "off" — better than rendering a confusing dash.
 *
 * Three add-ons render conditionally:
 *   1. **Cumulative metrics line** — `X sent · Y received · Z reconnects`,
 *      each suppressed when zero. Shown whenever the bus is enabled.
 *   2. **Live rate line** — `~X/min sent (peak P) · ~Y/min received (peak Q)`,
 *      with the "current" value computed client-side as deltas between
 *      consecutive polls and the "5m peak" sourced from the server-side
 *      ring buffer (`sseBus.recentRates`). Hidden when the bus is fully
 *      idle. See `formatRateForSide` for the per-side rendering rules
 *      (the parenthetical "(peak P)" is suppressed when peak ≤ current
 *      to avoid noise; switches to "5m peak P/min sent" when current is
 *      zero but a recent burst is still in the buffer).
 *   3. **Recent-errors expander** — collapsed-by-default detail panel that
 *      surfaces `lastPublishErrorMsg` / `lastReceiveErrorMsg` with relative
 *      timestamps. Only renders when at least one error timestamp is
 *      non-zero (sentinel 0 = "never").
 *
 * Self-contained: no props beyond the snapshot, no global state, no shared
 * polling — safe to drop into any container that has access to the
 * `infrastructure.sseBus` field on `OpsStatus` (or the bare result of
 * `sseBusApi.getStatus()`).
 *
 * **`detailHref` (optional):** when provided, renders a small "Details →"
 * link in the bottom-right of the tile, used by the operations page to
 * link through to the dedicated `/sse-bus` detail route. Omitted when the
 * tile IS that detail page (linking to itself would be silly) or when the
 * caller is a context that has no detail surface to offer. The link
 * renders even in the "Disabled" state because the detail page also
 * surfaces useful configuration / instance info regardless of bus state.
 */
export function SseBusTile({
  sseBus,
  detailHref,
}: {
  sseBus: SSEBusStatus | undefined;
  detailHref?: string;
}) {
  // Local UI state for the "recent errors" expander. Defaults to collapsed
  // because the tile is in a busy infrastructure card and most of the time
  // the errors panel is just "for reference" — operators only open it when
  // the badge or the metrics line tells them something is off.
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  // ── Live publish/receive rate (per minute) ────────────────────────────
  // The snapshot only carries cumulative counters; to get a rate we sample
  // the delta between two consecutive polls. This is computed entirely on
  // the client to avoid adding any per-second sampling state to the bus
  // module on the server (which would need its own ring buffer + ticker
  // for what is purely a UI nicety).
  //
  // `prevSampleRef` holds the previous snapshot's counter values + the
  // wall-clock time we observed them at. We use a ref (not state) for the
  // baseline so updating it doesn't itself trigger a re-render — only the
  // computed `rates` go into state, and only when they actually change
  // (most ticks they will, by 1-2/min, but it's still much cheaper than
  // re-running the rate calc inside render).
  const prevSampleRef = useRef<{
    publishesSent: number;
    framesReceived: number;
    at: number;
  } | null>(null);
  const [rates, setRates] = useState<{
    pubPerMin: number;
    recvPerMin: number;
  } | null>(null);

  useEffect(() => {
    // Reset baseline when the bus is disabled or the field disappears
    // (e.g. ops/status hit its catch handler). Avoids a stale rate
    // surviving across a transient outage.
    if (!sseBus || !sseBus.enabled) {
      prevSampleRef.current = null;
      setRates(null);
      return;
    }
    const now = Date.now();
    const prev = prevSampleRef.current;
    if (prev) {
      const dtSec = (now - prev.at) / 1000;
      const pubDelta = sseBus.publishesSent - prev.publishesSent;
      const recvDelta = sseBus.framesReceived - prev.framesReceived;
      // Three reset conditions, all of which mean the prior baseline is
      // not comparable to the current snapshot:
      //   1. dtSec < 5  → poll fired too fast (React StrictMode double
      //      render in dev, or React Query–style refetch immediately
      //      after a manual refresh). A 5s floor keeps the per-minute
      //      extrapolation from blowing up by 30× on tiny intervals.
      //   2. dtSec > 90 → page was likely backgrounded (the parent uses
      //      visibility-aware polling at 30s; anything >90s means we
      //      missed at least one tick and the delta represents events
      //      "since last visible" not "in the last 30s" — which would
      //      be misleading to display as "/min" without context).
      //   3. Either delta is negative → the api-server restarted (or
      //      __resetForTests was called) and counters went backwards.
      //      Drop this sample and rebaseline so the next pair is clean.
      if (dtSec >= 5 && dtSec <= 90 && pubDelta >= 0 && recvDelta >= 0) {
        const pubPerMin = Math.round((pubDelta / dtSec) * 60);
        const recvPerMin = Math.round((recvDelta / dtSec) * 60);
        // Only update state when the rounded values actually change to
        // avoid a no-op re-render of the parent metrics card on every
        // poll when the bus is idle (both rates 0).
        setRates((prevRates) => {
          if (
            prevRates !== null &&
            prevRates.pubPerMin === pubPerMin &&
            prevRates.recvPerMin === recvPerMin
          ) {
            return prevRates;
          }
          return { pubPerMin, recvPerMin };
        });
      } else {
        setRates(null);
      }
    }
    // Update baseline AFTER computing the rate so the next render uses
    // this snapshot as its prior. Storing in a ref means no follow-up
    // re-render is triggered just from the baseline shifting.
    prevSampleRef.current = {
      publishesSent: sseBus.publishesSent,
      framesReceived: sseBus.framesReceived,
      at: now,
    };
  }, [sseBus]);

  // Treat missing field as "off" (single-instance default).
  if (!sseBus || sseBus.health === "off") {
    return (
      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm">Cross-instance SSE bus</div>
            <div className="text-xs text-muted-foreground">
              {sseBus?.summary ??
                "Disabled — single-instance fanout only. Set REDIS_URL on the api service to enable cross-instance SSE."}
            </div>
          </div>
          <Badge
            variant="outline"
            className="bg-muted text-muted-foreground border-muted-foreground/30"
          >
            Disabled
          </Badge>
        </div>
        {detailHref && <DetailLink href={detailHref} />}
      </div>
    );
  }

  // Bus enabled — render the label + (optionally) a compact metrics line so
  // operators can see at a glance whether the bus is actually doing work.
  // `framesReceived` is the most useful signal: if it's >0 we KNOW another
  // instance is publishing AND we're receiving. `publishesSent` is local
  // and confirms our outbound side is healthy.
  const metrics: string[] = [];
  if (sseBus.publishesSent > 0) metrics.push(`${sseBus.publishesSent.toLocaleString()} sent`);
  if (sseBus.framesReceived > 0) metrics.push(`${sseBus.framesReceived.toLocaleString()} received`);
  if (sseBus.reconnects > 0) metrics.push(`${sseBus.reconnects.toLocaleString()} reconnects`);
  const metricsLine = metrics.length > 0 ? ` · ${metrics.join(" · ")}` : "";

  // Live rate line — combines two data sources for a "current vs recent
  // peak" comparison, the most operationally useful single line on the
  // tile because it answers BOTH "is the bus busy right now?" AND "is
  // this normal or unusually busy/quiet?" without scrolling to the detail
  // page.
  //
  //   • CURRENT rate comes from the tile's own client-side delta sampling
  //     (the `rates` state above) — smoother than the server-side 10s
  //     samples because it averages over the longer 30s polling window,
  //     and works as a fallback even on older api-server builds that
  //     don't yet expose `recentRates`.
  //
  //   • 5-MINUTE PEAK comes from `sseBus.recentRates` — the server-side
  //     ring buffer added in the same milestone. We use it ONLY for the
  //     peak (not for current) so the two numbers come from independent
  //     sources and won't drift surprisingly when one is stale.
  //
  // Per-side rendering (sent / received) handled by `formatRateForSide`
  // so the same three-case logic doesn't get duplicated:
  //   1. current > 0, peak > current   → "~12/min sent (peak 24)"
  //   2. current > 0, peak <= current  → "~12/min sent" (no peak suffix
  //      — would just say "(peak 12)" which is noise)
  //   3. current = 0, peak > 0         → "5m peak 24/min sent" — bus is
  //      idle now but had recent traffic, useful "not broken, just quiet
  //      since the burst" signal
  //   4. current = 0, peak = 0         → null — the cumulative metrics
  //      line above already tells operators "the bus is up but quiet"
  const recentRates = sseBus.recentRates ?? [];
  const pub5mPeak =
    recentRates.length > 0 ? Math.max(...recentRates.map((r) => r.pubPerMin)) : 0;
  const recv5mPeak =
    recentRates.length > 0 ? Math.max(...recentRates.map((r) => r.recvPerMin)) : 0;
  const sentPart = formatRateForSide("sent", rates?.pubPerMin ?? 0, pub5mPeak);
  const recvPart = formatRateForSide("received", rates?.recvPerMin ?? 0, recv5mPeak);
  const rateParts = [sentPart, recvPart].filter((x): x is string => x !== null);
  const showRate = rateParts.length > 0;

  // Build the "recent errors" list from the snapshot. Both timestamps are
  // 0 by default (sentinel for "never"); we only render the expander row
  // when at least one is non-zero. This keeps the tile clean during normal
  // healthy operation and surfaces the error history precisely when it's
  // useful for debugging — without making operators tail logs to find out
  // why the bus reconnected last Tuesday.
  const errors: Array<{ kind: "publish" | "receive"; at: number; msg: string }> = [];
  if (sseBus.lastPublishErrorAt > 0) {
    errors.push({
      kind: "publish",
      at: sseBus.lastPublishErrorAt,
      msg: sseBus.lastPublishErrorMsg,
    });
  }
  if (sseBus.lastReceiveErrorAt > 0) {
    errors.push({
      kind: "receive",
      at: sseBus.lastReceiveErrorAt,
      msg: sseBus.lastReceiveErrorMsg,
    });
  }
  const hasErrors = errors.length > 0;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm">Cross-instance SSE bus</div>
          <div className="text-xs text-muted-foreground truncate">
            {sseBus.summary}
            {metricsLine}
          </div>
          {showRate && (
            <div className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {rateParts.join(" · ")}
            </div>
          )}
        </div>
        <StatusBadge status={sseBus.health === "ok" ? "ok" : "degraded"} />
      </div>

      {hasErrors && (
        <>
          {/* Expander button — text-only chevron keeps the dependency
              footprint at zero (no new icon imports). The amber warning
              icon makes the row recognisable at a glance even when the
              overall bus health is "ok" (i.e. errors that happened in the
              past but the bus has since recovered, which is the most
              common state for this row). */}
          <button
            type="button"
            onClick={() => setErrorsExpanded((v) => !v)}
            className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={errorsExpanded}
          >
            <AlertTriangle className="w-3 h-3 text-amber-600" aria-hidden="true" />
            <span>
              {errors.length === 1
                ? "1 recent error"
                : `${errors.length} recent errors`}
            </span>
            <span className="ml-0.5" aria-hidden="true">
              {errorsExpanded ? "▾" : "▸"}
            </span>
          </button>
          {errorsExpanded && (
            <div className="mt-2 space-y-2 rounded-md bg-muted/40 p-2.5">
              {errors.map((e) => (
                <div key={e.kind} className="text-xs">
                  <div className="font-medium text-foreground">
                    Last {e.kind} error
                    <span className="font-normal text-muted-foreground">
                      {" · "}
                      {formatTimeAgo(e.at)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-muted-foreground break-words">
                    {e.msg || "(no message captured)"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {detailHref && <DetailLink href={detailHref} />}
    </div>
  );
}

/**
 * Bottom-right "Details →" link rendered when `detailHref` is provided.
 *
 * Kept as a tiny dedicated component (rather than inlined twice) so the
 * disabled and enabled branches of `SseBusTile` render identical link
 * markup — important because the link is the operator's entry point to
 * the detail page from BOTH states. A divider line above visually
 * separates it from the rest of the tile content so it doesn't look like
 * it's part of the metrics or errors panel above.
 */
function DetailLink({ href }: { href: string }) {
  return (
    <div className="mt-2 pt-2 border-t flex justify-end">
      <Link
        href={href}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Details →
      </Link>
    </div>
  );
}
