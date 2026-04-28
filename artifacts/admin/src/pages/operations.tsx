import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Clock3,
  Database,
  Gauge,
  HardDrive,
  Loader2,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Timer,
  Upload,
  Wifi,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  opsApi,
  slowRequestsApi,
  uploadsApi,
  AdminApiError,
  type ActiveUploadSession,
  type OpsStatus,
  type S3TelemetrySummary,
  type SlowRequestsSnapshot,
} from "@/services/adminApi";
import { PageHeader } from "@/components/shared/page-header";
import { usePollingWhenVisible } from "@/hooks/usePollingWhenVisible";
import { ErrorAlert } from "@/components/shared/error-alert";
import { MetricCard } from "@/components/shared/metric-card";
import { SseBusTile } from "@/components/operations/sse-bus-tile";
import { StatusBadge, StatusIcon, type CheckStatus } from "@/components/operations/status-badge";
import { useRecentSSEEvents, useSSE } from "@/contexts/SSEContext";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function OverallStatusCard({ status }: { status: OpsStatus }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-card border-b">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold">Platform Status</h2>
                <StatusBadge status={status.overallStatus} />
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {status.overallStatus === "ok"
                  ? "All core systems operating normally."
                  : "One or more systems require operator review."}
              </p>
            </div>
          </div>
          <div className="text-xs text-muted-foreground shrink-0">
            Updated {new Date(status.generatedAt).toLocaleTimeString()} · {status.environment}
          </div>
        </div>
        {Array.isArray(status.checks) && status.checks.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x">
            {status.checks.map((check) => (
              <div key={check.key} className="p-4 flex items-center gap-2.5">
                <StatusIcon status={check.status} />
                <div>
                  <div className="text-sm font-medium">{check.label}</div>
                  <div className="text-xs text-muted-foreground capitalize">{check.status}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function eventBadge(event: string) {
  switch (event) {
    case "status":
      return <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400 text-[10px]">status</Badge>;
    case "broadcast-control-updated":
      return <Badge variant="outline" className="border-red-500/40 text-red-700 dark:text-red-400 text-[10px]">control</Badge>;
    case "broadcast-queue-updated":
      return <Badge variant="outline" className="border-blue-500/40 text-blue-700 dark:text-blue-400 text-[10px]">queue</Badge>;
    case "override-expired":
      return <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400 text-[10px]">override</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px]">{event}</Badge>;
  }
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function ActiveUploadsCard() {
  const [sessions, setSessions] = useState<ActiveUploadSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  // Tick every 5s to refresh server data + every 1s to keep relative times
  // crisp without re-fetching.
  const [, setTick] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await uploadsApi.listActive(signal);
      // Defensive: only accept the response when it really is a list.
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load uploads");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    const poll = window.setInterval(() => load(), 5_000);
    const tick = window.setInterval(() => setTick((t) => t + 1), 1_000);
    return () => {
      ctl.abort();
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [load]);

  const handleCancel = useCallback(async (sessionId: string) => {
    if (!window.confirm("Cancel this upload? Any uploaded chunks will be discarded.")) return;
    setCancelling((c) => ({ ...c, [sessionId]: true }));
    try {
      await uploadsApi.cancel(sessionId);
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    } catch (err: unknown) {
      // Translate the machine-readable 409 code into a human sentence.
      const raw = err instanceof Error ? err.message : "Cancel failed";
      const friendly =
        raw === "finalize_in_progress"
          ? "This upload is currently being finalized and cannot be cancelled. It will complete or fail on its own shortly."
          : raw;
      window.alert(`Could not cancel upload: ${friendly}`);
      // Refresh the list so the operator sees the up-to-date state of this row.
      load();
    } finally {
      setCancelling((c) => {
        const next = { ...c };
        delete next[sessionId];
        return next;
      });
    }
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Upload className="w-4 h-4 text-primary" />
          Active Uploads
          <Badge variant="outline" className="ml-auto text-[10px] tabular-nums">
            {sessions.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="text-sm text-red-600 py-2">{error}</div>
        ) : sessions.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center border border-dashed rounded-md bg-muted/10">
            No active uploads.
          </div>
        ) : (
          <ul className="divide-y -mx-1">
            {sessions.map((s) => {
              const stuck = !s.finalizing && s.idleSecs > 60;
              const lastActivityTs = new Date(s.lastActivity).getTime();
              return (
                <li key={s.sessionId} className="py-2.5 px-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm font-medium">
                      {s.title || s.originalFilename || s.sessionId.slice(0, 8)}
                    </span>
                    {s.finalizing ? (
                      <Badge variant="outline" className="border-blue-500/40 text-blue-700 dark:text-blue-400 text-[10px]">
                        finalizing
                      </Badge>
                    ) : stuck ? (
                      <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400 text-[10px]">
                        stuck
                      </Badge>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      disabled={s.finalizing || !!cancelling[s.sessionId]}
                      onClick={() => handleCancel(s.sessionId)}
                      title={s.finalizing ? "Cannot cancel during finalization" : "Cancel upload"}
                    >
                      {cancelling[s.sessionId] ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <X className="w-3.5 h-3.5" />
                      )}
                    </Button>
                  </div>
                  <Progress value={s.progressPercent} className="h-1.5" />
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                    <span>
                      {formatBytes(s.receivedBytes)} / {formatBytes(s.totalBytes)} ·{" "}
                      {s.uploadedChunks}/{s.totalChunks} chunks · {s.progressPercent}%
                    </span>
                    <span>last activity {relativeTime(lastActivityTs)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function formatBitrate(bps: number | null): string {
  if (!bps || bps <= 0) return "—";
  const mbps = (bps * 8) / 1_000_000;
  if (mbps >= 100) return `${mbps.toFixed(0)} Mbps`;
  if (mbps >= 10) return `${mbps.toFixed(1)} Mbps`;
  if (mbps >= 1) return `${mbps.toFixed(2)} Mbps`;
  return `${(mbps * 1000).toFixed(0)} Kbps`;
}

function S3DirectUploadTelemetryCard() {
  const [windowHours, setWindowHours] = useState<number>(24);
  const [data, setData] = useState<S3TelemetrySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await uploadsApi.s3TelemetrySummary(windowHours, signal);
        setData(res ?? null);
        setError(null);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load telemetry");
      } finally {
        setLoading(false);
      }
    },
    [windowHours],
  );

  useEffect(() => {
    setLoading(true);
    const ctl = new AbortController();
    load(ctl.signal);
    const poll = window.setInterval(() => load(), 15_000);
    return () => {
      ctl.abort();
      window.clearInterval(poll);
    };
  }, [load]);

  const successColor =
    data?.successRatePct == null
      ? "text-muted-foreground"
      : data.successRatePct >= 95
        ? "text-emerald-600"
        : data.successRatePct >= 80
          ? "text-amber-600"
          : "text-red-600";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Upload className="w-4 h-4 text-primary" />
            Direct S3 Upload Telemetry
          </CardTitle>
          <div className="flex gap-1">
            {[1, 24, 168].map((h) => (
              <Button
                key={h}
                size="sm"
                variant={windowHours === h ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setWindowHours(h)}
                data-testid={`button-s3-tel-${h}h`}
              >
                {h === 1 ? "1h" : h === 24 ? "24h" : "7d"}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => load()}
              disabled={loading}
              data-testid="button-s3-tel-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && <ErrorAlert message={error} />}
        {loading && !data ? (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : !data || data.attempts === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No direct-S3 uploads in the last{" "}
            {windowHours === 1 ? "hour" : windowHours === 24 ? "24 hours" : "7 days"}.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Attempts
                </div>
                <div className="text-2xl font-semibold">{data.attempts}</div>
                <div className="text-[11px] text-muted-foreground">
                  {data.successes} ok · {data.failures} failed
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Success rate
                </div>
                <div className={`text-2xl font-semibold ${successColor}`}>
                  {data.successRatePct == null ? "—" : `${data.successRatePct.toFixed(1)}%`}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  finalize / init ratio
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Throughput p50
                </div>
                <div className="text-2xl font-semibold">
                  {formatBitrate(data.throughput.p50Bps)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  p95 {formatBitrate(data.throughput.p95Bps)}
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Bytes uploaded
                </div>
                <div className="text-2xl font-semibold">
                  {formatBytes(data.throughput.totalBytes ?? 0)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  avg {formatBytes(data.throughput.avgSizeBytes ?? 0)} / file
                </div>
              </div>
            </div>

            {data.topErrors.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Top errors
                </div>
                <div className="space-y-1.5">
                  {data.topErrors.map((e, i) => (
                    <div
                      key={i}
                      className="flex items-start justify-between gap-3 rounded border bg-card p-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[11px] text-amber-700 dark:text-amber-400">
                          {e.errorKind ?? "unknown"}
                        </div>
                        <div className="text-muted-foreground truncate" title={e.errorMessage ?? ""}>
                          {e.errorMessage ?? "—"}
                        </div>
                      </div>
                      <Badge variant="secondary" className="shrink-0">
                        {e.count}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              {Object.entries(data.counts).map(([ev, n]) => (
                <span
                  key={ev}
                  className="rounded bg-muted/50 px-1.5 py-0.5 font-mono"
                  data-testid={`s3-tel-count-${ev}`}
                >
                  {ev}: {n}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SignedUrlCacheCard({ data }: { data: NonNullable<OpsStatus["infrastructure"]["signedUrlCache"]> }) {
  // Hit-rate is the headline number: cached / hits. Anything 80%+ on
  // sustained playback traffic means the cache is doing its job (a steady
  // viewer no longer triggers a fresh S3 SigV4 sign on every ~5s HTML5
  // Range request). Below 50% with non-trivial traffic suggests cache
  // thrash — TTL too short, key churn, or the cache being bypassed.
  const totalHits = data.total.hits;
  const hitPct = Math.round(data.total.hitRate * 100);
  const status: CheckStatus =
    totalHits < 20 ? "ok" : hitPct >= 80 ? "ok" : hitPct >= 50 ? "degraded" : "critical";

  // The two sources should both report a hit-rate, but each one's traffic
  // pattern is different: `s3-redirect-first` covers full-length MP4s
  // requested through /api/uploads/<key>, `s3-redirect` is the static
  // fallback path. Both deserve their own row so a regression on one
  // doesn't get masked by health on the other.
  const sourceLabels: Record<string, string> = {
    "s3-redirect-first": "Uploads (/api/uploads/*)",
    "s3-redirect": "Static fallback",
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Signed-URL Cache
          </CardTitle>
          <StatusBadge status={status} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Per-process counters from the two media-redirect middlewares. Reset on every deploy
          ({formatUptime(data.uptimeSecs)} ago).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="text-2xl font-semibold tabular-nums">
              {totalHits === 0 ? "—" : `${hitPct}%`}
            </div>
            <div className="text-xs text-muted-foreground">Hit rate</div>
          </div>
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="text-2xl font-semibold tabular-nums">
              {data.total.cached.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">Cached (re-used)</div>
          </div>
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="text-2xl font-semibold tabular-nums">
              {data.total.fresh.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">Fresh (S3 signed)</div>
          </div>
        </div>

        {totalHits === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No video redirects served yet on this instance — counters populate as soon as a viewer
            opens an uploaded MP4.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2 font-medium text-right">Hits</th>
                  <th className="pb-2 font-medium text-right">Cached</th>
                  <th className="pb-2 font-medium text-right">Fresh</th>
                  <th className="pb-2 font-medium text-right">Hit rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(Object.entries(data.bySource) as Array<[
                  "s3-redirect-first" | "s3-redirect",
                  { fresh: number; cached: number; hits: number; hitRate: number },
                ]>).map(([key, row]) => (
                  <tr key={key}>
                    <td className="py-2">{sourceLabels[key] ?? key}</td>
                    <td className="py-2 text-right tabular-nums">{row.hits.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{row.cached.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {row.fresh.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {row.hits === 0 ? "—" : `${Math.round(row.hitRate * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BroadcastBuildLatencyCard({
  data,
}: {
  data: NonNullable<OpsStatus["infrastructure"]["broadcastBuildLatency"]>;
}) {
  // Cold p95 is the headline. Healthy is sub-100ms; the watchdog pages
  // on-call when it stays >=500ms for 5 consecutive minutes. Anything
  // between is degraded — workable but worth investigating before
  // viewers feel it as SSE desync.
  const coldSamples = data.cold.samples;
  const coldP95 = data.cold.p95;
  const status: CheckStatus =
    coldSamples < 10 ? "ok" : coldP95 < 200 ? "ok" : coldP95 < 500 ? "degraded" : "critical";

  // Format helper — treats <1ms as "<1ms" so the cell never reads "0ms"
  // for the perfectly-cached hot path (which is genuinely sub-millisecond
  // and would mislead an operator scanning for actual zero values).
  const fmt = (n: number) => (n === 0 ? "—" : n < 1 ? "<1ms" : `${n}ms`);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="w-4 h-4 text-primary" />
            Broadcast Build Latency
          </CardTitle>
          <StatusBadge status={status} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Per-call timing histogram for <code className="text-[10px]">buildBroadcastCurrentPayload</code>{" "}
          — the function powering <code className="text-[10px]">/api/broadcast/current</code> and the
          live-state SSE event. Last 500 samples per path. Reset every deploy
          ({formatUptime(data.uptimeSecs)} ago).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="text-2xl font-semibold tabular-nums">
              {coldSamples === 0 ? "—" : `${coldP95}ms`}
            </div>
            <div className="text-xs text-muted-foreground">Cold p95</div>
          </div>
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="text-2xl font-semibold tabular-nums">
              {data.cold.total.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">Cold builds (PG)</div>
          </div>
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="text-2xl font-semibold tabular-nums">
              {data.hot.total.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">Hot builds (cache)</div>
          </div>
        </div>

        {data.cold.total + data.hot.total === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No payloads built yet on this instance — counters populate as soon as a viewer or the
            transition ticker requests live state.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="pb-2 font-medium">Path</th>
                  <th className="pb-2 font-medium text-right">Samples</th>
                  <th className="pb-2 font-medium text-right">p50</th>
                  <th className="pb-2 font-medium text-right">p95</th>
                  <th className="pb-2 font-medium text-right">p99</th>
                  <th className="pb-2 font-medium text-right">Max</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr>
                  <td className="py-2">Cold (PG re-read)</td>
                  <td className="py-2 text-right tabular-nums">
                    {data.cold.samples.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmt(data.cold.p50)}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(data.cold.p95)}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(data.cold.p99)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {fmt(data.cold.max)}
                  </td>
                </tr>
                <tr>
                  <td className="py-2">Hot (cache hit)</td>
                  <td className="py-2 text-right tabular-nums">
                    {data.hot.samples.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmt(data.hot.p50)}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(data.hot.p95)}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(data.hot.p99)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {fmt(data.hot.max)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Healthy cold p95 is &lt;100ms. The latency watchdog pages on-call when cold p95 stays
          ≥500ms for 5 consecutive minutes — typically a PG pool exhaustion, slow query regression,
          or broadcast-cache invalidation thrash.
        </p>
      </CardContent>
    </Card>
  );
}

function ActivityFeedCard() {
  const events = useRecentSSEEvents();
  const { state } = useSSE();
  // Force re-render every 15s so relative times stay fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="w-4 h-4 text-primary" />
          Operational Activity Feed
          <Badge
            variant="outline"
            className={
              state === "connected"
                ? "ml-auto border-emerald-500/40 text-emerald-700 dark:text-emerald-400 text-[10px]"
                : state === "reconnecting" || state === "connecting"
                  ? "ml-auto border-amber-500/40 text-amber-700 dark:text-amber-400 text-[10px]"
                  : "ml-auto border-muted text-muted-foreground text-[10px]"
            }
          >
            {state}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center border border-dashed rounded-md bg-muted/10">
            Listening for live broadcast events…
          </div>
        ) : (
          <ul className="divide-y max-h-72 overflow-y-auto -mx-1">
            {events.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2 px-1">
                {eventBadge(entry.event)}
                <span className="flex-1 text-sm truncate">{entry.summary}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {relativeTime(entry.ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function relativeShort(ts: number | string): string {
  const t = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function durationTone(ms: number, threshold: number): string {
  if (ms >= threshold * 4) return "text-red-600 dark:text-red-400";
  if (ms >= threshold * 2) return "text-amber-600 dark:text-amber-400";
  return "text-foreground";
}

function statusTone(code: number): string {
  if (code >= 500) return "text-red-600 dark:text-red-400";
  if (code === 504) return "text-red-600 dark:text-red-400";
  if (code >= 400) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

function SlowRequestsCard() {
  const [snapshot, setSnapshot] = useState<SlowRequestsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await slowRequestsApi.get();
      setSnapshot(data);
      setErr(null);
    } catch (e) {
      setErr((e as Error)?.message ?? "Unable to load slow-request telemetry");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Polled separately from /admin/ops/status (10s) — slow-request telemetry
    // changes much less often, so 30s is plenty and keeps the per-route stats
    // payload off the busier status path.
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (loading && !snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Timer className="w-4 h-4 text-primary" />
            Slow Requests
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 rounded-md" />
        </CardContent>
      </Card>
    );
  }

  if (err && !snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Timer className="w-4 h-4 text-primary" />
            Slow Requests
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">{err}</div>
        </CardContent>
      </Card>
    );
  }

  if (!snapshot) return null;

  const { thresholdMs, entries, routes, capturedCount, bufferSize, bufferMaxAgeMs } = snapshot;
  const ageWindow = `${Math.round(bufferMaxAgeMs / 60_000)}m`;

  return (
    <Card data-testid="slow-requests-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Timer className="w-4 h-4 text-primary" />
          Slow Requests
          <Badge
            variant="outline"
            className="ml-auto text-[10px] font-mono border-muted text-muted-foreground"
          >
            ≥ {thresholdMs}ms · last {ageWindow}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {entries.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/10 p-5 text-center text-sm text-muted-foreground">
            No requests have exceeded {thresholdMs}ms in the last {ageWindow}.
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">
                Recent slow requests
              </div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {capturedCount} captured · buffer {bufferSize}
              </div>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Method</th>
                    <th className="px-3 py-2 font-medium">Path</th>
                    <th className="px-3 py-2 font-medium text-right">Status</th>
                    <th className="px-3 py-2 font-medium text-right">Duration</th>
                    <th className="px-3 py-2 font-medium text-right">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entries.slice(0, 15).map((e, i) => (
                    <tr key={`${e.at}-${i}`} data-testid="slow-request-row">
                      <td className="px-3 py-2 font-mono text-[11px]">{e.method}</td>
                      <td
                        className="px-3 py-2 font-mono text-[11px] text-muted-foreground truncate max-w-[280px]"
                        title={e.rawPath}
                      >
                        {e.path}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${statusTone(e.statusCode)}`}>
                        {e.statusCode}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-medium ${durationTone(e.durationMs, thresholdMs)}`}>
                        {e.durationMs.toLocaleString()}ms
                      </td>
                      <td className="px-3 py-2 text-right text-[11px] text-muted-foreground tabular-nums">
                        {relativeShort(e.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {routes.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              Per-route latency (top {Math.min(10, routes.length)})
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Method</th>
                    <th className="px-3 py-2 font-medium">Route</th>
                    <th className="px-3 py-2 font-medium text-right">Total</th>
                    <th className="px-3 py-2 font-medium text-right">Errors</th>
                    <th className="px-3 py-2 font-medium text-right">Slow</th>
                    <th className="px-3 py-2 font-medium text-right">Avg</th>
                    <th className="px-3 py-2 font-medium text-right">Max</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {routes.slice(0, 10).map((r) => (
                    <tr key={`${r.method} ${r.path}`} data-testid="slow-route-row">
                      <td className="px-3 py-2 font-mono text-[11px]">{r.method}</td>
                      <td
                        className="px-3 py-2 font-mono text-[11px] text-muted-foreground truncate max-w-[260px]"
                        title={r.path}
                      >
                        {r.path}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.total.toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.errors > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                        {r.errors}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.slowCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                        {r.slowCount}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {r.averageMs.toLocaleString()}ms
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${durationTone(r.maxMs, thresholdMs)}`}>
                        {r.maxMs.toLocaleString()}ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Operations() {
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Round 4l hotfix #3: error carries a `transient` flag so the page can
  // render the soft "Reconnecting…" indicator (instead of a destructive
  // banner) for the workflow-restart race that fetchWithTransientRetry
  // already swallows internally most of the time. Same shape used by
  // transcoding.tsx — see ErrorAlert.transient for the visual treatment.
  const [error, setError] = useState<{ message: string; transient: boolean } | null>(null);

  const loadStatus = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const data = await opsApi.getStatus();
      setStatus(data);
      setError(null);
    } catch (err: unknown) {
      const message = (err as Error)?.message ?? "Unable to load platform status";
      const transient = err instanceof AdminApiError && err.transient === true;
      setError({ message, transient });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Visibility-aware polling — pauses entirely when the operator switches
  // tabs or backgrounds the browser, and fires immediately on return so the
  // first thing they see on focus is fresh data. /admin/ops/status runs four
  // PG count queries plus several in-memory metric snapshots per call; with
  // the historical 10s cadence and N admin tabs left open across the team
  // that was the dominant source of admin-driven backend load. Bumped to 30s
  // because every metric on this page is slow-changing infrastructure data
  // (uptime, DB connectivity, cache backend, queue counts, signed-URL hit
  // rate) that nobody monitors second-by-second; the visibility gate is the
  // bigger multiplier (instant 100% reduction for inactive tabs).
  usePollingWhenVisible(loadStatus, 30_000);

  const requestMetrics = useMemo(
    () => (Array.isArray(status?.metrics?.requests) ? status.metrics.requests : []),
    [status],
  );
  const totalRequests = useMemo(
    () => requestMetrics.reduce((t, r) => t + r.total, 0),
    [requestMetrics],
  );
  const totalErrors = useMemo(
    () => requestMetrics.reduce((t, r) => t + r.errors, 0),
    [requestMetrics],
  );

  const pipeline = status?.videoPipeline;
  const pipelineTotal = pipeline
    ? pipeline.processing + pipeline.queued + pipeline.done + pipeline.failed + pipeline.cancelled
    : 0;
  const successPct = pipelineTotal > 0
    ? Math.round((pipeline!.done / pipelineTotal) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations Center"
        description="Production readiness, streaming health, and platform telemetry."
        actions={
          <Button variant="outline" size="sm" onClick={() => loadStatus(true)} disabled={refreshing}>
            {refreshing
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <RefreshCw className="w-4 h-4 mr-2" />}
            Refresh
          </Button>
        }
      />

      {error && (
        error.transient ? (
          <ErrorAlert transient onRetry={() => loadStatus(true)} />
        ) : (
          <ErrorAlert
            title="Operations status unavailable"
            message={error.message}
            onRetry={() => loadStatus(true)}
          />
        )
      )}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-36 rounded-xl" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : status ? (
        <>
          <OverallStatusCard status={status} />

          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="API Uptime"
              value={formatUptime(status.metrics.uptimeSecs)}
              subtitle={`${status.metrics.activeRequests} active requests`}
              icon={<Server className="h-4 w-4" />}
            />
            <MetricCard
              title="HTTP Requests"
              value={totalRequests.toLocaleString()}
              subtitle={`${totalErrors} server errors`}
              icon={<Activity className="h-4 w-4" />}
              highlight={totalErrors > 0 ? "warning" : undefined}
            />
            <MetricCard
              title="Registered Devices"
              value={status.database.counts.registeredDevices.toLocaleString()}
              subtitle="Push notification endpoints"
              icon={<Smartphone className="h-4 w-4" />}
            />
            <MetricCard
              title="Broadcast Queue"
              value={status.broadcast.activeQueueItems}
              subtitle={`${status.broadcast.activeLiveOverrides} live override(s) active`}
              icon={<Radio className="h-4 w-4" />}
              highlight={status.broadcast.activeLiveOverrides > 0 ? "danger" : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Database className="w-4 h-4 text-primary" />
                  Content Database
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                {[
                  { label: "Videos", value: status.database.counts.videos, href: "/videos" },
                  { label: "Local uploads", value: status.database.counts.localVideos, href: "/videos" },
                  { label: "Playlists", value: status.database.counts.playlists, href: "/playlists" },
                  { label: "Schedule slots", value: status.database.counts.activeScheduleEntries, href: "/schedule" },
                ].map(({ label, value, href }) => (
                  <Link
                    key={label}
                    href={href}
                    className="rounded-lg border bg-muted/30 p-3 block hover:bg-muted hover:border-primary/30 transition-colors group"
                  >
                    <div className="text-xl font-bold group-hover:text-primary transition-colors">{value}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                  </Link>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Wifi className="w-4 h-4 text-primary" />
                  Infrastructure
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Distributed cache */}
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium text-sm">Distributed cache</div>
                    <div className="text-xs text-muted-foreground">
                      {status.infrastructure?.cache?.redis?.connected
                        ? "Redis — low-latency distributed"
                        : status.infrastructure?.cache?.postgresql?.connected
                          ? "PostgreSQL — multi-instance safe"
                          : "Memory fallback (single instance only)"}
                    </div>
                  </div>
                  <StatusBadge
                    status={
                      status.infrastructure?.cache?.redis?.connected || status.infrastructure?.cache?.postgresql?.connected
                        ? "ok"
                        : "degraded"
                    }
                  />
                </div>
                {/* Cross-instance SSE bus (Redis pub/sub bridge).
                    "off" is a NORMAL state for single-instance deploys —
                    render it as a neutral badge, not amber/red. The
                    StatusBadge component only knows ok/degraded/critical
                    so we render the disabled-state badge inline here. */}
                <SseBusTile sseBus={status.infrastructure?.sseBus} />
                {/* AWS Cloud storage */}
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium text-sm">AWS Cloud storage</div>
                    <div className="text-xs text-muted-foreground">
                      {status.infrastructure?.objectStorage?.configured
                        ? `AWS S3 bucket active${status.infrastructure?.objectStorage?.bucket ? ` — ${status.infrastructure.objectStorage.bucket}` : ""}${status.infrastructure?.objectStorage?.region ? ` (${status.infrastructure.objectStorage.region})` : ""}`
                        : "AWS S3 not configured — check credentials and bucket settings"}
                    </div>
                  </div>
                  <StatusBadge
                    status={status.infrastructure?.objectStorage?.configured ? "ok" : "degraded"}
                  />
                </div>
                {/* HLS transcoder */}
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium text-sm">HLS transcoder (ffmpeg)</div>
                    <div className="text-xs text-muted-foreground">
                      {status.infrastructure?.transcoder?.ffmpegReady
                        ? `ABR pipeline ready — cloud upload ${status.infrastructure?.transcoder?.cloudUploadEnabled ? "enabled" : "disabled"}`
                        : "ffmpeg unavailable — transcoding disabled"}
                    </div>
                  </div>
                  <StatusBadge
                    status={status.infrastructure?.transcoder?.ffmpegReady ? "ok" : "critical"}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="text-lg font-semibold">{status.broadcast.connectedAdminClients}</div>
                    <div className="text-xs text-muted-foreground">Admin SSE clients</div>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="text-lg font-semibold">{status.uploadSessions.active}</div>
                    <div className="text-xs text-muted-foreground">Active upload sessions</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <ActivityFeedCard />
            <ActiveUploadsCard />
          </div>

          <S3DirectUploadTelemetryCard />

          {status.infrastructure?.signedUrlCache && (
            <SignedUrlCacheCard data={status.infrastructure.signedUrlCache} />
          )}

          {status.infrastructure?.broadcastBuildLatency && (
            <BroadcastBuildLatencyCard data={status.infrastructure.broadcastBuildLatency} />
          )}

          {pipeline && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <HardDrive className="w-4 h-4 text-primary" />
                  Video Pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="text-muted-foreground">Successful encodes</span>
                    <span className="font-semibold">{successPct}%</span>
                  </div>
                  <Progress value={successPct} className="h-2" />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {[
                    { label: "Processing", value: pipeline.processing, href: "/transcoding", danger: false },
                    { label: "Queued", value: pipeline.queued, href: "/transcoding", danger: false },
                    { label: "Done", value: pipeline.done, href: "/transcoding", danger: false },
                    { label: "Failed", value: pipeline.failed, href: "/transcoding", danger: pipeline.failed > 0 },
                    { label: "Cancelled", value: pipeline.cancelled, href: "/transcoding", danger: false },
                  ].map(({ label, value, href, danger }) => (
                    <Link
                      key={label}
                      href={href}
                      className={`rounded-lg border p-3 block hover:border-primary/40 hover:bg-muted/40 transition-colors group ${danger ? "border-red-500/30 bg-red-500/5" : ""}`}
                    >
                      <div className={`text-xl font-semibold group-hover:text-primary transition-colors ${danger ? "text-red-600" : ""}`}>
                        {value}
                      </div>
                      <div className="text-xs text-muted-foreground">{label}</div>
                    </Link>
                  ))}
                </div>
                <div className="grid md:grid-cols-2 gap-3 pt-1">
                  <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div>
                      <div className="text-sm font-medium">{formatBytes(pipeline.uploadBytes)}</div>
                      <div className="text-xs text-muted-foreground">Uploaded media storage</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <Clock3 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div>
                      <div className="text-sm font-medium">{formatBytes(pipeline.hlsBytes)}</div>
                      <div className="text-xs text-muted-foreground">Adaptive streaming renditions</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {requestMetrics.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Activity className="w-4 h-4 text-primary" />
                  Request Metrics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="pb-2 font-medium">Method / Route</th>
                        <th className="pb-2 font-medium text-right">Total</th>
                        <th className="pb-2 font-medium text-right">Errors</th>
                        <th className="pb-2 font-medium text-right">Avg ms</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {requestMetrics.map((r, i) => (
                        <tr key={i}>
                          <td className="py-2 font-mono text-xs">{r.method}</td>
                          <td className="py-2 text-right tabular-nums">{r.total.toLocaleString()}</td>
                          <td className={`py-2 text-right tabular-nums ${r.errors > 0 ? "text-red-500" : ""}`}>
                            {r.errors}
                          </td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">{r.averageMs}ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          <SlowRequestsCard />
        </>
      ) : !error ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            Operations status is unavailable.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
