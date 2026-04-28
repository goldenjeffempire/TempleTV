import { useCallback, useRef, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { sseBusApi, type SSEBusStatus } from "@/services/adminApi";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { SseBusTile } from "@/components/operations/sse-bus-tile";
import { usePollingWhenVisible } from "@/hooks/usePollingWhenVisible";

/**
 * Cross-instance SSE bus detail page.
 *
 * A drill-down from the Operations page bus tile, shown when an operator
 * wants more than the at-a-glance summary — typically when investigating
 * "why did the bus reconnect?" or "is fanout traffic actually flowing right
 * now?". Three sections:
 *
 *   1. **Status overview** — reuses the same `SseBusTile` component that
 *      lives on the Operations page, so the headline status, badge, and
 *      errors expander look identical and behave identically here. This is
 *      the entire point of having extracted the tile in the previous round.
 *   2. **5-minute rate history** — twin sparklines (publishes/min sent,
 *      frames/min received) computed entirely on the client from the
 *      `publishesSent` / `framesReceived` cumulative counters. Shows ~20
 *      samples over a rolling 5-minute window at the page's 15s polling
 *      cadence — good trend resolution without hammering the (cheap)
 *      `/api/admin/sse-bus` endpoint.
 *   3. **Configuration** — instance ID, channel name, uptime, full
 *      counter breakdown including the dropped-frame counters that the
 *      operations tile elides for space (`framesDroppedSelf`,
 *      `framesDroppedMalformed`, `publishesFailed`,
 *      `publishesSkippedDisconnected`).
 *
 * Polling cadence: **15s** (vs Operations page's 30s). Justified because
 * (a) this is a focused page an operator is actively staring at, and
 * (b) `/api/admin/sse-bus` is cheap — it just reads the in-memory bus
 * snapshot, no DB queries. Visibility-aware via `usePollingWhenVisible`,
 * so backgrounding the tab still pauses polling.
 */
export default function SseBusDetailPage() {
  const [snapshot, setSnapshot] = useState<SSEBusStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Sparkline ring buffer ─────────────────────────────────────────────
  // Same client-side delta-sampling approach as `SseBusTile`'s internal
  // rate calc, but here we keep the FULL history (capped at 30 samples =
  // 5 min at 15s polling) so we can render a sparkline. Deliberately NOT
  // shared with the tile's own rate state: the two components compute
  // their rates independently and stay self-contained. The numbers will
  // match within rounding because both are sampling the same underlying
  // counters at roughly the same time.
  const prevSampleRef = useRef<{
    publishesSent: number;
    framesReceived: number;
    at: number;
  } | null>(null);
  const [history, setHistory] = useState<
    Array<{ at: number; pubPerMin: number; recvPerMin: number }>
  >([]);

  const load = useCallback(async () => {
    try {
      const s = await sseBusApi.getStatus();
      setSnapshot(s);
      setError(null);

      // Reset baseline when bus is disabled — no point sampling rates
      // off a disabled bus, and we want the "Collecting samples…"
      // placeholder to appear immediately if it gets re-enabled.
      if (!s.enabled) {
        prevSampleRef.current = null;
        setHistory([]);
        return;
      }

      const now = Date.now();
      const prev = prevSampleRef.current;
      if (prev) {
        const dtSec = (now - prev.at) / 1000;
        const pubDelta = s.publishesSent - prev.publishesSent;
        const recvDelta = s.framesReceived - prev.framesReceived;
        // Same three reset conditions as the tile's rate calc:
        //   1. dtSec < 5  → poll fired too fast (StrictMode dev double
        //      render, or React Query–style refetch). Floor protects
        //      against /min extrapolation blowing up.
        //   2. dtSec > 90 → tab was backgrounded long enough that this
        //      delta no longer represents recent activity.
        //   3. Negative deltas → api-server restarted; rebaseline.
        if (dtSec >= 5 && dtSec <= 90 && pubDelta >= 0 && recvDelta >= 0) {
          const pubPerMin = Math.round((pubDelta / dtSec) * 60);
          const recvPerMin = Math.round((recvDelta / dtSec) * 60);
          setHistory((prevHist) => {
            const next = [...prevHist, { at: now, pubPerMin, recvPerMin }];
            // Cap at 30 samples (5 min at 15s cadence). Sliding window
            // means the sparkline always shows "the last 5 minutes" not
            // "since I opened this page", which is what an operator
            // actually wants.
            return next.length > 30 ? next.slice(-30) : next;
          });
        } else if (pubDelta < 0 || recvDelta < 0) {
          // Server restart — clear history so the sparkline doesn't
          // misleadingly imply continuity across the restart boundary.
          setHistory([]);
        }
      }
      prevSampleRef.current = {
        publishesSent: s.publishesSent,
        framesReceived: s.framesReceived,
        at: now,
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load bus status");
    } finally {
      setLoading(false);
    }
  }, []);

  usePollingWhenVisible(load, 15_000);

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <PageHeader
        title="Cross-instance SSE bus"
        description="Redis pub/sub bridge for fanning out live updates across multiple api-server instances. Disabled by default; enable by setting REDIS_URL on the api service."
        actions={
          <Link
            href="/operations"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to Operations
          </Link>
        }
      />

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {loading && !snapshot ? (
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-48" />
          <Skeleton className="h-64" />
        </div>
      ) : snapshot ? (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Status</CardTitle>
            </CardHeader>
            <CardContent>
              <SseBusTile sseBus={snapshot} />
            </CardContent>
          </Card>

          {snapshot.enabled && <RateHistoryCard history={history} />}

          <ConfigCard snapshot={snapshot} />
        </>
      ) : null}
    </div>
  );
}

/**
 * 5-minute rate history sparkline card.
 *
 * Two stacked rows (sent + received), each with a sparkline + three stats
 * (current, peak, avg). Stats are computed inline rather than memoized —
 * the history array is capped at 30 entries and only changes once every
 * 15s, so the cost is trivial.
 *
 * When fewer than 2 samples exist, the sparkline shows a "Collecting
 * samples…" placeholder. This is normal on first load (need at least one
 * delta pair before any rate exists) and after any reset condition fires.
 */
function RateHistoryCard({
  history,
}: {
  history: Array<{ at: number; pubPerMin: number; recvPerMin: number }>;
}) {
  const sentSeries = history.map((h) => h.pubPerMin);
  const recvSeries = history.map((h) => h.recvPerMin);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">5-minute rate history</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Per-minute rates sampled every 15s on the client. Up to 20 samples
          shown over a rolling 5-minute window. Resets if the bus is
          disconnected or the api-server restarts.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <RateRow
          label="Publishes sent / min"
          color="rgb(16 185 129)"
          series={sentSeries}
        />
        <RateRow
          label="Frames received / min"
          color="rgb(59 130 246)"
          series={recvSeries}
        />
      </CardContent>
    </Card>
  );
}

function RateRow({
  label,
  color,
  series,
}: {
  label: string;
  color: string;
  series: number[];
}) {
  const current = series.length > 0 ? series[series.length - 1] : 0;
  const peak = series.length > 0 ? Math.max(...series) : 0;
  const avg =
    series.length > 0
      ? Math.round(series.reduce((a, b) => a + b, 0) / series.length)
      : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="text-sm font-medium">{label}</div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
          <span>
            now: <span className="text-foreground font-medium">{current}</span>
          </span>
          <span>
            peak: <span className="text-foreground font-medium">{peak}</span>
          </span>
          <span>
            avg: <span className="text-foreground font-medium">{avg}</span>
          </span>
        </div>
      </div>
      <Sparkline data={series} color={color} />
    </div>
  );
}

/**
 * Tiny dependency-free SVG sparkline.
 *
 * Inline rather than a chart library because (a) we have exactly one
 * consumer, (b) chart libs add 50–200KB of bundle weight for a 200×40
 * line, and (c) the rendering needs are trivial: plot N points, anchor
 * the y-axis at 0 (so an idle bus shows a flat line at the bottom rather
 * than a misleading "everything's the same" plot floating mid-canvas),
 * scale the upper bound to the max value (or 1 to avoid div-by-zero on
 * an all-zeros series).
 */
function Sparkline({
  data,
  color,
  height = 40,
}: {
  data: number[];
  color: string;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground italic rounded-md bg-muted/30"
        style={{ height }}
      >
        Collecting samples…
      </div>
    );
  }
  // viewBox-based sizing means the SVG scales fluidly to its container
  // width; we only fix the height for a consistent visual rhythm.
  const vbWidth = 100;
  const max = Math.max(...data, 1);
  const xStep = vbWidth / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * xStep;
      const y = height - (v / max) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  // Filled area under the line for visual weight, plus the line itself
  // on top for crispness. Both use the same colour with different alpha.
  const areaPoints = `0,${height} ${points} ${vbWidth},${height}`;
  return (
    <svg
      viewBox={`0 0 ${vbWidth} ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
      role="img"
      aria-label={`Sparkline showing ${data.length} data points, current value ${data[data.length - 1]}, peak ${max}`}
    >
      <polygon points={areaPoints} fill={color} fillOpacity="0.15" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Configuration & full counters card.
 *
 * Surfaces the bookkeeping fields that the operations tile deliberately
 * elides (instance ID, channel name, dropped-frame counters, etc.) so an
 * operator investigating an issue has all the data on one page without
 * needing to curl the endpoint.
 */
function ConfigCard({ snapshot }: { snapshot: SSEBusStatus }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Configuration & full counters</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
          <ConfigRow label="Enabled">
            {snapshot.enabled ? (
              <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400">
                Yes
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="bg-muted text-muted-foreground border-muted-foreground/30"
              >
                No
              </Badge>
            )}
          </ConfigRow>
          <ConfigRow label="Connected">
            {snapshot.connected ? (
              <span className="text-emerald-700 dark:text-emerald-400">Yes</span>
            ) : (
              <span className="text-muted-foreground">No</span>
            )}
          </ConfigRow>
          <ConfigRow label="Channel">
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              {snapshot.channel || "(none)"}
            </code>
          </ConfigRow>
          <ConfigRow label="Instance ID">
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              {snapshot.instanceId || "(none)"}
            </code>
          </ConfigRow>
          <ConfigRow label="Uptime">
            {formatUptime(snapshot.uptimeSec)}
          </ConfigRow>
          <ConfigRow label="Reconnects">
            <span className="tabular-nums">{snapshot.reconnects.toLocaleString()}</span>
          </ConfigRow>

          <div className="sm:col-span-2 mt-2 pt-3 border-t">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              Outbound (publish)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-1.5 text-sm">
              <CounterRow label="Sent" value={snapshot.publishesSent} />
              <CounterRow label="Failed" value={snapshot.publishesFailed} warn />
              <CounterRow
                label="Skipped (disconnected)"
                value={snapshot.publishesSkippedDisconnected}
                warn
              />
            </div>
          </div>

          <div className="sm:col-span-2 mt-2 pt-3 border-t">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              Inbound (receive)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-1.5 text-sm">
              <CounterRow label="Received" value={snapshot.framesReceived} />
              <CounterRow
                label="Dropped (self)"
                value={snapshot.framesDroppedSelf}
                hint="Frames published by this instance that came back over the bus — correctly ignored to prevent loops."
              />
              <CounterRow
                label="Dropped (malformed)"
                value={snapshot.framesDroppedMalformed}
                warn
              />
            </div>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function CounterRow({
  label,
  value,
  warn,
  hint,
}: {
  label: string;
  value: number;
  warn?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground text-xs" title={hint}>
        {label}
      </span>
      <span
        className={`tabular-nums font-medium ${
          warn && value > 0 ? "text-amber-700 dark:text-amber-400" : ""
        }`}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function formatUptime(secs: number): string {
  if (!secs) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
