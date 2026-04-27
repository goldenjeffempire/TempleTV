import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Gauge,
  Heart,
  Radio,
  RefreshCw,
  Signal,
  TrendingUp,
  Users,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { useSSEEvent } from "@/contexts/SSEContext";
import { usePollingWhenVisible } from "@/hooks/usePollingWhenVisible";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-access";
import { fetchWithTransientRetry } from "@/services/adminApi";
import { apiBase } from "@/lib/api-base";
import { ProcessStatusPanel } from "@/components/ProcessStatusPanel";

interface LiveEventRecord {
  ts: number;
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  method: string | null;
}

interface ViewerSnapshot {
  ts: number;
  count: number;
}

interface StreamHealthSnapshot {
  ts: number;
  viewerCount: number;
  viewersByPlatform: { tv: number; mobile: number; admin: number; unknown: number };
  droppedFrameRate: number | null;
  decodedFramesWindow: number;
  droppedFramesWindow: number;
  reportingClients: number;
  recoveriesByPlatform: { tv: number; mobile: number; admin: number; unknown: number };
  recoveryRatePerMin: number;
  isOnAir: boolean;
  currentTitle: string | null;
  itemUptimeSecs: number;
  serverUptimeSecs: number;
  bitrateKbps: number | null;
  segmentLatencyMs: number | null;
  deliveryOk: boolean;
  lastProbeAgoMs: number;
  stabilityPercent: number;
  connectionFailureRate: number;
  syncOk: boolean;
  progressPercent: number | null;
  health: "healthy" | "warning" | "critical";
  healthReason: string;
}

interface LiveHealthData {
  current: {
    isLive: boolean;
    videoId: string | null;
    title: string | null;
    checkedAt: number;
    staleSec: number;
    detectionMethod?: string;
    uptimeSecs: number;
    liveSessionStartedAt: number | null;
    viewerCount: number | null;
  };
  polling: {
    intervalMs: number;
    mode: "normal" | "burst";
    lastStateChangeAt: number;
  };
  history: LiveEventRecord[];
  viewerHistory: ViewerSnapshot[];
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function formatTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatViewerCount(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function UptimeClock({ startSecs }: { startSecs: number }) {
  const [elapsed, setElapsed] = useState(startSecs);
  useEffect(() => {
    setElapsed(startSecs);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [startSecs]);
  return <span>{formatDuration(elapsed)}</span>;
}

function apiUrl(path: string) {
  // Delegate to the centralized helper so VITE_API_BASE_URL is honored in
  // split-domain production setups (admin SPA + API on different hostnames).
  return `${apiBase()}${path}`;
}

const VIEWER_HISTORY_STORAGE_KEY = "templeTv.admin.viewerHistory.v1";
const VIEWER_HISTORY_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const VIEWER_HISTORY_MAX_POINTS = 240;

function loadStoredViewerHistory(): ViewerSnapshot[] {
  try {
    const raw = localStorage.getItem(VIEWER_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - VIEWER_HISTORY_MAX_AGE_MS;
    return parsed.filter(
      (p): p is ViewerSnapshot =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as ViewerSnapshot).ts === "number" &&
        typeof (p as ViewerSnapshot).count === "number" &&
        (p as ViewerSnapshot).ts >= cutoff,
    );
  } catch {
    return [];
  }
}

function persistViewerHistory(snapshots: ViewerSnapshot[]) {
  try {
    localStorage.setItem(VIEWER_HISTORY_STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // ignore quota errors
  }
}

function mergeViewerHistory(stored: ViewerSnapshot[], incoming: ViewerSnapshot[]): ViewerSnapshot[] {
  const cutoff = Date.now() - VIEWER_HISTORY_MAX_AGE_MS;
  const map = new Map<number, number>();
  for (const s of stored) {
    if (s.ts >= cutoff) map.set(s.ts, s.count);
  }
  for (const s of incoming) {
    if (s.ts >= cutoff) map.set(s.ts, s.count);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(-VIEWER_HISTORY_MAX_POINTS)
    .map(([ts, count]) => ({ ts, count }));
}

interface ChartPoint {
  label: string;
  count: number;
  ts: number;
}

function buildChartData(snapshots: ViewerSnapshot[]): ChartPoint[] {
  return snapshots.map((s) => ({
    ts: s.ts,
    label: new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    count: s.count,
  }));
}

function ViewerChart({ data }: { data: ViewerSnapshot[] }) {
  const chartData = buildChartData(data);
  const maxVal = Math.max(...chartData.map((d) => d.count), 1);
  const yMax = Math.ceil(maxVal * 1.2);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="viewerGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[0, yMax]}
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))}
          width={36}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
            fontSize: "12px",
          }}
          labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600 }}
          formatter={(value: number) => [value.toLocaleString(), "Viewers"]}
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke="#ef4444"
          strokeWidth={2}
          fill="url(#viewerGradient)"
          dot={false}
          activeDot={{ r: 4, fill: "#ef4444" }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Realtime Stream Health card — driven entirely by the per-second SSE feed
// from `streamHealth.ts` on the server. No polling. Every metric here is a
// live measurement, refreshed at 1 Hz, with explicit stale-data handling.
// ───────────────────────────────────────────────────────────────────────────
function RealtimeStreamHealth({
  snapshot,
  stale,
  staleMs,
}: {
  snapshot: StreamHealthSnapshot | null;
  stale: boolean;
  staleMs: number;
}) {
  // Sparkline buffer — last 60 latency samples (one per second). Plain array
  // ref is fine; we re-render via the snapshot prop every tick anyway.
  const latencyHistoryRef = useRef<number[]>([]);
  const viewerHistoryRef = useRef<number[]>([]);
  if (snapshot) {
    if (typeof snapshot.segmentLatencyMs === "number") {
      latencyHistoryRef.current = [...latencyHistoryRef.current, snapshot.segmentLatencyMs].slice(-60);
    }
    viewerHistoryRef.current = [...viewerHistoryRef.current, snapshot.viewerCount].slice(-60);
  }

  const healthClass = useMemo(() => {
    if (!snapshot) return "border-muted bg-card";
    switch (snapshot.health) {
      case "critical":
        return "border-red-500/40 bg-red-500/5";
      case "warning":
        return "border-amber-500/40 bg-amber-500/5";
      default:
        return "border-emerald-500/30 bg-emerald-500/5";
    }
  }, [snapshot]);

  const healthBadge = useMemo(() => {
    if (!snapshot) return { label: "Connecting…", color: "bg-muted text-muted-foreground" };
    if (stale) return { label: "Stale feed", color: "bg-amber-500/15 text-amber-600 border-amber-500/30" };
    switch (snapshot.health) {
      case "critical":
        return { label: "Critical", color: "bg-red-500/15 text-red-600 border-red-500/30" };
      case "warning":
        return { label: "Warning", color: "bg-amber-500/15 text-amber-600 border-amber-500/30" };
      default:
        return { label: "Healthy", color: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" };
    }
  }, [snapshot, stale]);

  return (
    <Card className={`border ${healthClass} transition-colors`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Heart
              className={`w-4 h-4 ${
                snapshot?.health === "healthy"
                  ? "text-emerald-500 animate-pulse"
                  : snapshot?.health === "warning"
                  ? "text-amber-500"
                  : snapshot?.health === "critical"
                  ? "text-red-500"
                  : "text-muted-foreground"
              }`}
            />
            <CardTitle className="text-sm font-semibold">Realtime Stream Health</CardTitle>
            <span className={`text-[10px] uppercase tracking-wide font-medium px-2 py-0.5 rounded-full border ${healthBadge.color}`}>
              {healthBadge.label}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${stale ? "bg-amber-500" : "bg-emerald-500 animate-pulse"}`} />
            {stale ? `Stale ${Math.floor(staleMs / 1000)}s` : "1 Hz live"}
          </div>
        </div>
        {snapshot?.healthReason && (
          <p className="text-xs text-muted-foreground mt-1.5 ml-6">{snapshot.healthReason}</p>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-3">
          <HealthMetric
            icon={<Users className="w-3.5 h-3.5" />}
            label="Viewers"
            value={snapshot ? snapshot.viewerCount.toLocaleString() : "—"}
            sub={
              snapshot
                ? (() => {
                    const p = snapshot.viewersByPlatform;
                    const parts: string[] = [];
                    if (p.tv) parts.push(`${p.tv} TV`);
                    if (p.mobile) parts.push(`${p.mobile} mobile`);
                    if (p.admin) parts.push(`${p.admin} admin`);
                    if (p.unknown) parts.push(`${p.unknown} other`);
                    return parts.length > 0 ? parts.join(" · ") : "no clients";
                  })()
                : "connected now"
            }
            sparkline={viewerHistoryRef.current}
            sparkColor="#3b82f6"
          />
          <HealthMetric
            icon={<Gauge className="w-3.5 h-3.5" />}
            label="Bitrate"
            value={snapshot?.bitrateKbps ? `${(snapshot.bitrateKbps / 1000).toFixed(2)} Mbps` : "—"}
            sub={snapshot?.bitrateKbps ? `${snapshot.bitrateKbps} kbps peak` : "n/a for source"}
          />
          <HealthMetric
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            label="Dropped frames"
            value={
              snapshot && snapshot.droppedFrameRate !== null
                ? `${(snapshot.droppedFrameRate * 100).toFixed(2)}%`
                : "—"
            }
            sub={
              snapshot && snapshot.droppedFrameRate !== null
                ? `${snapshot.droppedFramesWindow.toLocaleString()} of ${snapshot.decodedFramesWindow.toLocaleString()} (60s)`
                : snapshot
                ? "no client telemetry"
                : "—"
            }
            tone={
              snapshot && snapshot.droppedFrameRate !== null
                ? snapshot.droppedFrameRate > 0.05
                  ? "critical"
                  : snapshot.droppedFrameRate > 0.01
                  ? "warning"
                  : "ok"
                : undefined
            }
          />
          <HealthMetric
            icon={<Activity className="w-3.5 h-3.5" />}
            label="Segment latency"
            value={snapshot?.segmentLatencyMs !== null && snapshot?.segmentLatencyMs !== undefined ? `${snapshot.segmentLatencyMs} ms` : "—"}
            sub={
              snapshot?.segmentLatencyMs !== null && snapshot?.segmentLatencyMs !== undefined
                ? snapshot.segmentLatencyMs > 1500
                  ? "above critical"
                  : snapshot.segmentLatencyMs > 800
                  ? "above optimal"
                  : "optimal"
                : "no probe data"
            }
            tone={
              snapshot?.segmentLatencyMs !== null && snapshot?.segmentLatencyMs !== undefined
                ? snapshot.segmentLatencyMs > 1500
                  ? "critical"
                  : snapshot.segmentLatencyMs > 800
                  ? "warning"
                  : "ok"
                : undefined
            }
            sparkline={latencyHistoryRef.current}
            sparkColor="#a855f7"
          />
          <HealthMetric
            icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            label="Stability"
            value={snapshot ? `${snapshot.stabilityPercent.toFixed(1)}%` : "—"}
            sub={
              snapshot
                ? snapshot.connectionFailureRate === 0
                  ? "0 dropped writes"
                  : `${(snapshot.connectionFailureRate * 100).toFixed(2)}% drop`
                : "—"
            }
            tone={
              snapshot
                ? snapshot.connectionFailureRate > 0.05
                  ? "warning"
                  : "ok"
                : undefined
            }
          />
          {/* Per-platform recovery rate. Counts every viewer-side
              `recoverBroadcastPlayback()` invocation in the last 60 s and
              shows the breakdown so operators can tell whether a surge is
              concentrated on one surface (one CDN edge / carrier) or
              system-wide. Tone thresholds are deliberately loose: a few
              recoveries per minute is healthy plumbing absorbing flaky
              edges; warning at >10/min, critical at >30/min — empirically
              the inflection where viewer churn starts in production. */}
          <HealthMetric
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            label="Recoveries (60s)"
            value={snapshot ? `${snapshot.recoveryRatePerMin.toFixed(1)}/min` : "—"}
            sub={
              snapshot
                ? (() => {
                    const r = snapshot.recoveriesByPlatform;
                    const parts: string[] = [];
                    if (r.tv) parts.push(`${r.tv} TV`);
                    if (r.mobile) parts.push(`${r.mobile} mobile`);
                    if (r.admin) parts.push(`${r.admin} admin`);
                    if (r.unknown) parts.push(`${r.unknown} other`);
                    return parts.length > 0 ? parts.join(" · ") : "no recoveries";
                  })()
                : "—"
            }
            tone={
              snapshot
                ? snapshot.recoveryRatePerMin > 30
                  ? "critical"
                  : snapshot.recoveryRatePerMin > 10
                  ? "warning"
                  : "ok"
                : undefined
            }
          />
          <HealthMetric
            icon={<Clock className="w-3.5 h-3.5" />}
            label="Item uptime"
            value={snapshot && snapshot.isOnAir ? formatDuration(snapshot.itemUptimeSecs) : "—"}
            sub={snapshot?.currentTitle ? truncate(snapshot.currentTitle, 22) : "off air"}
          />
          <HealthMetric
            icon={<Signal className="w-3.5 h-3.5" />}
            label="Sync state"
            value={snapshot?.syncOk ? "Anchored" : snapshot ? "Drifting" : "—"}
            sub={
              snapshot
                ? snapshot.progressPercent !== null
                  ? `${snapshot.progressPercent}% through item`
                  : "no anchor"
                : "—"
            }
            tone={snapshot ? (snapshot.syncOk ? "ok" : "warning") : undefined}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// HealthMetric and Sparkline both render at 1Hz inside RealtimeStreamHealth
// (one per `stream-health` SSE frame). Wrapping them in React.memo with a
// custom comparator means a metric whose props haven't actually changed
// between two ticks does not re-render at all — the parent still ticks, but
// React skips the child reconciliation. The most expensive child here is
// the Sparkline polyline string, which is rebuilt from a 60-element array
// on every render without memoisation; with React.memo + a tail-element
// equality check, an unchanged sparkline costs zero work.
const HealthMetric = React.memo(
  function HealthMetric({
    icon,
    label,
    value,
    sub,
    tone,
    sparkline,
    sparkColor,
  }: {
    icon: React.ReactNode;
    label: string;
    value: string;
    sub?: string;
    tone?: "ok" | "warning" | "critical";
    sparkline?: number[];
    sparkColor?: string;
  }) {
    const valueColor =
      tone === "critical"
        ? "text-red-500"
        : tone === "warning"
        ? "text-amber-600"
        : tone === "ok"
        ? "text-emerald-600"
        : "text-foreground";
    return (
      <div className="rounded-md bg-background/40 border border-border/40 p-3 min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
          {icon}
          <span className="truncate">{label}</span>
        </div>
        <div className={`text-lg font-bold font-mono leading-tight tabular-nums ${valueColor}`}>{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{sub}</div>}
        {sparkline && sparkline.length > 1 && (
          <Sparkline data={sparkline} color={sparkColor ?? "#3b82f6"} />
        )}
      </div>
    );
  },
  // Custom comparator: skip the icon node (it's a static JSX element each
  // render anyway), and compare the sparkline by length + last sample only.
  // The sparkline is appended to monotonically (push + slice -60), so a
  // length-and-tail check is sufficient to know the visible curve changed.
  (prev, next) => {
    if (prev.label !== next.label) return false;
    if (prev.value !== next.value) return false;
    if (prev.sub !== next.sub) return false;
    if (prev.tone !== next.tone) return false;
    if (prev.sparkColor !== next.sparkColor) return false;
    const a = prev.sparkline;
    const b = next.sparkline;
    if (a === b) return true;
    if (!a || !b) return a === b;
    if (a.length !== b.length) return false;
    return a[a.length - 1] === b[b.length - 1];
  },
);

const Sparkline = React.memo(
  function Sparkline({ data, color }: { data: number[]; color: string }) {
    if (data.length < 2) return null;
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const w = 100;
    const h = 22;
    const step = w / (data.length - 1);
    const points = data
      .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
      .join(" ");
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-5 mt-1.5" preserveAspectRatio="none">
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      </svg>
    );
  },
  // Same length + tail-sample comparison as HealthMetric — anything else
  // would be lying about the polyline having changed.
  (prev, next) => {
    if (prev.color !== next.color) return false;
    if (prev.data.length !== next.data.length) return false;
    if (prev.data === next.data) return true;
    return prev.data[prev.data.length - 1] === next.data[next.data.length - 1];
  },
);

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function LiveMonitor() {
  const { toast } = useToast();
  const [data, setData] = useState<LiveHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const [sseError, setSseError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [alertVisible, setAlertVisible] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const prevIsLive = useRef<boolean | null>(null);
  const storedHistoryRef = useRef<ViewerSnapshot[]>(loadStoredViewerHistory());

  const fetchHealth = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const token = getAdminToken();
      const headers: HeadersInit = token ? { "X-Admin-Token": token } : {};
      // Round 4l: wrap in the shared retry helper so a workflow-restart race
      // doesn't surface as "Unexpected non-JSON response from live health
      // endpoint". This is a pure GET, safe to retry.
      const res = await fetchWithTransientRetry(() =>
        fetch(apiUrl("/admin/live/health"), { headers }),
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Safe-parse: if a proxy returns the SPA HTML fallback by mistake,
      // surface a clean error instead of a raw "Unexpected token '<'".
      const text = await res.text();
      let json: LiveHealthData;
      try {
        json = JSON.parse(text) as LiveHealthData;
      } catch {
        throw new Error("Unexpected non-JSON response from live health endpoint");
      }
      // Defensive: coerce list fields to arrays at ingress so downstream
      // .length/.map/.reduce calls can never crash on contract drift.
      const safeViewer = Array.isArray(json.viewerHistory) ? json.viewerHistory : [];
      const safeHistory = Array.isArray(json.history) ? json.history : [];
      const merged = mergeViewerHistory(storedHistoryRef.current, safeViewer);
      storedHistoryRef.current = merged;
      persistViewerHistory(merged);
      setData({ ...json, viewerHistory: merged, history: safeHistory });
      setFetchError(null);
    } catch (err) {
      // Surface the underlying cause to the operator instead of swallowing it
      // — without this, a 401 (rotated admin key) is indistinguishable from a
      // network outage from a malformed proxy response.
      const message = err instanceof Error ? err.message : "Could not reach /admin/live/health.";
      setFetchError(message);
      if (!silent) {
        toast({
          title: "Failed to load live health data",
          description: message,
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  // Visibility-aware belt-and-suspenders poll. Cadence stays at 60 s — the
  // per-second `stream-health` SSE drives the realtime card and the
  // YouTube-status SSE drives liveness changes, so this exists only to
  // refresh the historical viewer-snapshot list and aggregate stats. Now
  // gated by tab visibility so a backgrounded tab adds zero load. The hook
  // also fires once on mount (and on tab return), replacing the prior
  // `fetchHealth()` mount call that lived in the removed `useEffect`.
  usePollingWhenVisible(() => fetchHealth(true), 60_000);

  // ───────────────────────────────────────────────────────────────────────
  // Realtime stream-health subscription — pushed every 1 s by the API server
  // ───────────────────────────────────────────────────────────────────────
  const [streamHealth, setStreamHealth] = useState<StreamHealthSnapshot | null>(null);
  const [healthLastSeen, setHealthLastSeen] = useState<number>(0);
  useSSEEvent("stream-health", (data) => {
    if (!data || typeof data !== "object") return;
    setStreamHealth(data as StreamHealthSnapshot);
    setHealthLastSeen(Date.now());
  });
  // "Live ticker" — surfaces a stale-data warning if no health frame arrives
  // for >5 s (would imply the SSE socket dropped or the server timer stalled).
  const [tickerNow, setTickerNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTickerNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const healthStaleMs = healthLastSeen ? tickerNow - healthLastSeen : 0;
  const healthIsStale = healthLastSeen > 0 && healthStaleMs > 5_000;

  useEffect(() => {
    const token = getAdminToken();
    const url = token
      ? `${apiUrl("/youtube/live/events")}?token=${encodeURIComponent(token)}`
      : apiUrl("/youtube/live/events");

    const es = new EventSource(url);

    es.onopen = () => { setSseConnected(true); setSseError(false); };
    es.addEventListener("connected", () => { setSseConnected(true); setSseError(false); });
    es.addEventListener("heartbeat", () => { setSseConnected(true); });

    es.addEventListener("yt-status", (e) => {
      let payload: { isLive: boolean; videoId: string | null; title: string | null };
      try {
        payload = JSON.parse((e as MessageEvent).data);
        if (typeof payload?.isLive !== "boolean") return;
      } catch {
        // Malformed event payload — ignore rather than crash the listener.
        return;
      }

      if (prevIsLive.current !== null && prevIsLive.current !== payload.isLive) {
        if (!payload.isLive) {
          setAlertVisible(true);
          toast({ title: "⚠️ Stream went offline", description: "Temple TV is no longer live.", variant: "destructive" });
          setTimeout(() => setAlertVisible(false), 8000);
        } else {
          toast({ title: "🔴 Stream is LIVE!", description: payload.title ?? "Temple TV has started a live stream." });
        }
      }
      prevIsLive.current = payload.isLive;
      fetchHealth(true);
    });

    es.onerror = () => { setSseConnected(false); setSseError(true); };
    return () => es.close();
  }, [fetchHealth, toast]);

  const peakViewers = data?.viewerHistory?.length
    ? Math.max(...data.viewerHistory.map((s) => s.count))
    : null;

  const avgViewers = data?.viewerHistory?.length
    ? Math.round(data.viewerHistory.reduce((s, p) => s + p.count, 0) / data.viewerHistory.length)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Stream Monitor</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Real-time health monitoring for the Temple TV YouTube live stream
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border ${
            sseConnected
              ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
              : sseError
              ? "bg-red-500/10 text-red-500 border-red-500/20"
              : "bg-amber-500/10 text-amber-600 border-amber-500/20"
          }`}>
            {sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {sseConnected ? "Real-time" : sseError ? "SSE Error" : "Connecting…"}
          </div>
          <Button size="sm" variant="outline" onClick={() => fetchHealth()} disabled={refreshing}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {alertVisible && (
        <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/25 rounded-lg px-4 py-3 text-red-600">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <p className="font-semibold text-sm">Stream Offline Alert</p>
            <p className="text-xs text-red-500/80">The live stream has gone offline. Check YouTube Studio for details.</p>
          </div>
        </div>
      )}

      <ProcessStatusPanel />

      <RealtimeStreamHealth snapshot={streamHealth} stale={healthIsStale} staleMs={healthStaleMs} />

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <div className="h-4 bg-muted rounded animate-pulse mb-3 w-1/2" />
                <div className="h-7 bg-muted rounded animate-pulse w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card className={data.current.isLive ? "border-red-500/40 bg-red-500/5" : ""}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Stream Status</span>
                  <Radio className={`w-4 h-4 ${data.current.isLive ? "text-red-500" : "text-muted-foreground"}`} />
                </div>
                <div className={`text-2xl font-bold ${data.current.isLive ? "text-red-500" : "text-foreground"}`}>
                  {data.current.isLive ? "LIVE" : "OFF AIR"}
                </div>
                {data.current.isLive && data.current.title && (
                  <p className="text-xs text-muted-foreground mt-1 truncate">{data.current.title}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Concurrent Viewers</span>
                  <Users className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className={`text-2xl font-bold font-mono ${data.current.isLive ? "" : "text-muted-foreground"}`}>
                  {data.current.isLive
                    ? data.current.viewerCount !== null
                      ? data.current.viewerCount.toLocaleString()
                      : <span className="text-base text-muted-foreground">Fetching…</span>
                    : "—"}
                </div>
                {data.current.isLive && peakViewers !== null && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Peak: {peakViewers.toLocaleString()}
                    {avgViewers !== null && <span className="ml-2">Avg: {avgViewers.toLocaleString()}</span>}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Stream Uptime</span>
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-bold font-mono">
                  {data.current.isLive && data.current.uptimeSecs > 0 ? (
                    <UptimeClock startSecs={data.current.uptimeSecs} />
                  ) : (
                    <span className="text-muted-foreground text-lg">—</span>
                  )}
                </div>
                {data.current.liveSessionStartedAt && data.current.isLive && (
                  <p className="text-xs text-muted-foreground mt-1">Since {formatTime(data.current.liveSessionStartedAt)}</p>
                )}
              </CardContent>
            </Card>

            <Card
              className={
                data.current.staleSec > Math.max(120, (data.polling.intervalMs / 1000) * 3)
                  ? "border-amber-500/40 bg-amber-500/5"
                  : ""
              }
            >
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Check</span>
                  <Activity
                    className={`w-4 h-4 ${
                      data.current.staleSec > Math.max(120, (data.polling.intervalMs / 1000) * 3)
                        ? "text-amber-500"
                        : "text-muted-foreground"
                    }`}
                  />
                </div>
                <div className="text-2xl font-bold">{data.current.staleSec}s ago</div>
                <p className="text-xs text-muted-foreground mt-1">
                  via <code className="font-mono text-[11px]">{data.current.detectionMethod ?? "—"}</code>
                </p>
                {data.current.staleSec > Math.max(120, (data.polling.intervalMs / 1000) * 3) && (
                  <p className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Detection lag — last poll exceeds expected interval
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Poll Interval</span>
                  <Zap className={`w-4 h-4 ${data.polling.mode === "burst" ? "text-amber-500" : "text-muted-foreground"}`} />
                </div>
                <div className="text-2xl font-bold">{data.polling.intervalMs / 1000}s</div>
                <div className="mt-1">
                  <Badge
                    variant="secondary"
                    className={`text-xs ${data.polling.mode === "burst" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : ""}`}
                  >
                    {data.polling.mode === "burst" ? "⚡ Burst mode" : "Normal mode"}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Viewer Snapshots</span>
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-bold">{data.viewerHistory.length}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {data.viewerHistory.length > 0
                    ? `From ${formatTime(data.viewerHistory[0]!.ts)} to ${formatTime(data.viewerHistory[data.viewerHistory.length - 1]!.ts)}`
                    : "No data collected yet"}
                </p>
              </CardContent>
            </Card>
          </div>

          {data.current.isLive && data.current.videoId && (
            <Card className="border-red-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  Currently Live
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-4">
                  <img
                    src={`https://img.youtube.com/vi/${data.current.videoId}/mqdefault.jpg`}
                    alt="Live thumbnail"
                    className="w-40 h-24 object-cover rounded-md border shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-base leading-tight mb-2">
                      {data.current.title ?? "Untitled stream"}
                    </p>
                    <p className="text-xs text-muted-foreground mb-3">
                      Video ID: <code className="font-mono bg-muted px-1 py-0.5 rounded">{data.current.videoId}</code>
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      <a
                        href={`https://www.youtube.com/watch?v=${data.current.videoId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button size="sm" variant="outline">
                          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                          Watch on YouTube
                        </Button>
                      </a>
                      <a
                        href={`https://studio.youtube.com/video/${data.current.videoId}/livestreaming`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button size="sm" variant="outline">
                          <Signal className="w-3.5 h-3.5 mr-1.5" />
                          YouTube Studio
                        </Button>
                      </a>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Concurrent Viewer Trend</CardTitle>
                {data.current.isLive && data.current.viewerCount !== null && (
                  <Badge className="bg-red-500/10 text-red-600 border-red-500/20 text-xs">
                    {data.current.viewerCount.toLocaleString()} now
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {data.viewerHistory.length < 2 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <Users className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-sm">
                    {data.current.isLive
                      ? "Collecting viewer data… Check back in a minute."
                      : "Viewer trend appears here during a live stream."}
                  </p>
                  <p className="text-xs mt-1 opacity-70">Data is sampled once per poll cycle (every {data.polling.intervalMs / 1000}s)</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-6 text-sm">
                    <div>
                      <span className="text-muted-foreground text-xs">Current</span>
                      <p className="font-semibold">{formatViewerCount(data.current.viewerCount)}</p>
                    </div>
                    {peakViewers !== null && (
                      <div>
                        <span className="text-muted-foreground text-xs">Peak</span>
                        <p className="font-semibold text-red-500">{peakViewers.toLocaleString()}</p>
                      </div>
                    )}
                    {avgViewers !== null && (
                      <div>
                        <span className="text-muted-foreground text-xs">Avg</span>
                        <p className="font-semibold">{avgViewers.toLocaleString()}</p>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground text-xs">Samples</span>
                      <p className="font-semibold">{data.viewerHistory.length}</p>
                    </div>
                  </div>
                  <ViewerChart data={data.viewerHistory} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Event History</CardTitle>
            </CardHeader>
            <CardContent>
              {data.history.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground text-sm">
                  <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  No state changes recorded yet. Events appear here when the stream goes live or offline.
                </div>
              ) : (
                <div className="space-y-2">
                  {data.history.map((event, i) => (
                    <div
                      key={event.ts}
                      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border text-sm ${i === 0 ? "bg-muted/60" : ""}`}
                    >
                      <div className="mt-0.5 shrink-0">
                        {event.isLive ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <WifiOff className="w-4 h-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant="secondary"
                            className={
                              event.isLive
                                ? "bg-red-500/10 text-red-600 border-red-500/20 text-xs"
                                : "text-xs"
                            }
                          >
                            {event.isLive ? "Went Live" : "Went Offline"}
                          </Badge>
                          {i === 0 && <Badge variant="outline" className="text-xs">Latest</Badge>}
                          {event.method && (
                            <span className="text-xs text-muted-foreground">
                              via <code className="font-mono">{event.method}</code>
                            </span>
                          )}
                        </div>
                        {event.title && (
                          <p className="text-xs text-muted-foreground mt-1 truncate">{event.title}</p>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0 text-right">
                        {formatDateTime(event.ts)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Polling Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Current Mode</p>
                  <p className="font-medium capitalize">{data.polling.mode}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Check Interval</p>
                  <p className="font-medium">{formatDuration(data.polling.intervalMs / 1000)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Last State Change</p>
                  <p className="font-medium">
                    {data.polling.lastStateChangeAt ? formatDateTime(data.polling.lastStateChangeAt) : "None yet"}
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
                Normal mode polls every 60 seconds. Burst mode (15s interval) activates for 10 minutes after any state
                change. Viewer count is scraped from the YouTube watch page on every poll cycle when live.
              </p>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="flex items-start gap-3 py-6 text-muted-foreground">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-destructive" />
            <div className="flex-1 space-y-2">
              <p className="font-medium text-foreground">Failed to load monitoring data.</p>
              {fetchError ? (
                <p className="text-sm break-all">{fetchError}</p>
              ) : (
                <p className="text-sm">Check that the API server is running.</p>
              )}
              <Button size="sm" variant="outline" onClick={() => fetchHealth()} disabled={refreshing}>
                <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
