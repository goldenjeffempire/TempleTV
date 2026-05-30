import { Component, useMemo, useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, isTransientError } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { MetricCard } from "@/components/shared/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart2, Eye, Clock, Film, Tv2, Smartphone, Monitor,
  TrendingUp, CheckCircle2, RefreshCw, Download, Users, Zap, Radio,
} from "lucide-react";
import { exportRowsAsCsv } from "@/lib/csv-export";
import { toast } from "sonner";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "@/lib/recharts-shim";
import { format, parseISO } from "date-fns";

// ── Chart-level error boundary ─────────────────────────────────────────────
interface ChartEBState { failed: boolean; message: string }
class ChartErrorBoundary extends Component<{ children: ReactNode; label?: string }, ChartEBState> {
  state: ChartEBState = { failed: false, message: "" };
  static getDerivedStateFromError(err: Error): ChartEBState {
    return { failed: true, message: err.message };
  }
  componentDidCatch(err: Error) { console.error("[ChartErrorBoundary]", err); }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex flex-col items-center justify-center h-56 gap-2 text-sm text-muted-foreground">
          <span className="text-xs text-destructive/80">{this.props.label ?? "Chart"} failed to render</span>
          <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => this.setState({ failed: false, message: "" })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

type RangeKey = "7d" | "30d" | "90d";

interface AnalyticsOverview {
  totalViews: number;
  totalSessions: number;
  completionRate: number;
  avgWatchSecs: number;
  platformBreakdown: Array<{ platform: string; sessions: number }>;
  dailyViews: Array<{ date: string; views: number }>;
  topVideos: Array<{ id: string; title: string; viewCount: number; thumbnailUrl: string }>;
  generatedAt: string;
}

interface ConcurrentBucket {
  ts: string;
  concurrent: number;
  tv: number;
  mobile: number;
  web: number;
}

interface ConcurrentViewers {
  buckets: ConcurrentBucket[];
  peak: { concurrent: number; ts: string };
  granularity: "hour" | "4h" | "day";
  generatedAt: string;
}

interface DailyPlatformDay {
  date: string;
  tv: number;
  mobile: number;
  web: number;
  total: number;
}

interface DailyPlatformTrends {
  days: DailyPlatformDay[];
  generatedAt: string;
}

const RANGE_OPTIONS: { label: string; value: RangeKey }[] = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
];

const PLATFORM_ICONS: Record<string, ReactNode> = {
  tv: <Tv2 size={13} />,
  mobile: <Smartphone size={13} />,
  web: <Monitor size={13} />,
};

const PLATFORM_COLORS: Record<string, string> = {
  tv: "hsl(var(--primary))",
  mobile: "#22c55e",
  web: "#f59e0b",
};

const PIE_COLORS = ["hsl(var(--primary))", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"];

function fmtSecs(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function fmtDate(dateStr: string): string {
  try { return format(parseISO(dateStr), "MMM d"); } catch { return dateStr; }
}

function fmtBucketTs(ts: string, gran: "hour" | "4h" | "day"): string {
  try {
    const d = new Date(ts);
    if (gran === "day") return format(d, "MMM d");
    return format(d, "MMM d HH:mm");
  } catch { return ts; }
}

// ── Live viewer count — polls /broadcast/viewers every 5 s ─────────────────
function useLiveViewerCount() {
  const [count, setCount] = useState<number | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against overlapping async polls: if the previous request hasn't
  // resolved yet by the time the next interval fires, skip that tick rather
  // than issuing a second concurrent request to the same endpoint.
  const inFlightRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await api.get<{ channelId: string; count: number }>("/broadcast/viewers");
        if (!mounted) return;
        setCount((c) => { setPrev(c); return res.count; });
      } catch { /* silent — offline or no viewers endpoint */ } finally {
        inFlightRef.current = false;
      }
    }
    void poll();
    intervalRef.current = setInterval(() => void poll(), 5000);
    return () => {
      mounted = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const trend: "up" | "down" | "flat" =
    prev === null || count === null || count === prev ? "flat"
    : count > prev ? "up" : "down";

  return { count, trend };
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>("30d");
  const { count: liveCount, trend: liveTrend } = useLiveViewerCount();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["analytics-overview", range],
    queryFn: () => api.get<AnalyticsOverview>(`/admin/analytics/overview?range=${range}`),
    staleTime: 120_000,
  });

  const concurrentRange: RangeKey = range === "90d" ? "90d" : range === "30d" ? "30d" : "7d";
  const { data: concData, isLoading: concLoading } = useQuery({
    queryKey: ["analytics-concurrent", concurrentRange],
    queryFn: () => api.get<ConcurrentViewers>(`/admin/analytics/concurrent?range=${concurrentRange}`),
    staleTime: 60_000,
  });

  const { data: platData, isLoading: platLoading } = useQuery({
    queryKey: ["analytics-platform-trends", range],
    queryFn: () => api.get<DailyPlatformTrends>(`/admin/analytics/platform-trends?range=${range}`),
    staleTime: 60_000,
  });

  const chartData = useMemo(
    () => (data?.dailyViews ?? []).map((d) => ({ date: fmtDate(d.date), views: d.views })),
    [data?.dailyViews],
  );

  const topVideosChart = useMemo(
    () => (data?.topVideos ?? []).slice(0, 8).map((v) => ({
      name: v.title.length > 22 ? v.title.slice(0, 22) + "…" : v.title,
      views: v.viewCount,
    })),
    [data?.topVideos],
  );

  const totalPlatformSessions = useMemo(
    () => (data?.platformBreakdown ?? []).reduce((s, p) => s + p.sessions, 0),
    [data?.platformBreakdown],
  );

  // Concurrent chart data — tick labels thinned for readability
  const concChartData = useMemo(() => {
    const buckets = concData?.buckets ?? [];
    const gran = concData?.granularity ?? "hour";
    // For 7d hourly (168 pts) thin to every 6th; 30d 4h (180 pts) every 6th; 90d daily keep all
    const step = gran === "day" ? 1 : gran === "4h" ? 6 : 6;
    return buckets.map((b, i) => ({
      ts: fmtBucketTs(b.ts, gran),
      rawTs: b.ts,
      concurrent: b.concurrent,
      tv: b.tv,
      mobile: b.mobile,
      web: b.web,
      labelTs: i % step === 0 ? fmtBucketTs(b.ts, gran) : "",
    }));
  }, [concData]);

  const peakTs = useMemo(() => {
    if (!concData?.peak.ts || !concData.peak.concurrent) return null;
    return fmtBucketTs(concData.peak.ts, concData.granularity ?? "hour");
  }, [concData]);

  const platChartData = useMemo(
    () => (platData?.days ?? []).map((d) => ({
      date: fmtDate(d.date),
      tv: d.tv,
      mobile: d.mobile,
      web: d.web,
    })),
    [platData?.days],
  );

  function handleRefreshAll() {
    void refetch();
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Analytics"
        description="Viewer engagement, concurrent audiences, watch-time trends and content performance."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex gap-1 border rounded-md p-0.5">
              {RANGE_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  variant={range === opt.value ? "default" : "ghost"}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setRange(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-7"
              disabled={!data || isFetching || (data.dailyViews?.length ?? 0) === 0}
              onClick={() => {
                if (!data) return;
                exportRowsAsCsv(
                  `temple-tv-analytics-${range}-${new Date().toISOString().slice(0, 10)}`,
                  data.dailyViews ?? [],
                  [
                    { header: "Date", value: (r) => r.date },
                    { header: "Views", value: (r) => r.views },
                  ],
                );
                toast.success("Daily views exported");
              }}
              aria-label="Export daily views as CSV"
              title="Export CSV"
            >
              <Download size={12} />
              <span className="hidden sm:inline">Export</span>
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefreshAll} className="gap-1.5 h-7" aria-label="Refresh analytics">
              <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            </Button>
          </div>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      {/* ── Row 1: key metrics including live count ── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Live viewer count — real-time */}
        <Card className="lg:col-span-1 border-primary/30 bg-primary/5">
          <CardContent className="p-4 flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">Live Now</span>
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <Radio size={11} className="text-green-500" />
              </div>
            </div>
            <div className="flex items-end gap-1.5">
              <span className="text-2xl font-bold tabular-nums leading-none">
                {liveCount !== null ? liveCount.toLocaleString() : "—"}
              </span>
              {liveTrend !== "flat" && (
                <span className={`text-xs mb-0.5 font-medium ${liveTrend === "up" ? "text-green-500" : "text-red-500"}`}>
                  {liveTrend === "up" ? "↑" : "↓"}
                </span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">concurrent viewers</p>
          </CardContent>
        </Card>

        <MetricCard title="Total Views" value={data?.totalViews?.toLocaleString()} icon={<Eye size={16} />} loading={isLoading} />
        <MetricCard title="Sessions" value={data?.totalSessions?.toLocaleString()} icon={<TrendingUp size={16} />} loading={isLoading} />
        <MetricCard
          title="Completion Rate"
          value={data ? `${Math.round((data.completionRate ?? 0) * 100)}%` : undefined}
          icon={<CheckCircle2 size={16} />}
          loading={isLoading}
        />
        <MetricCard
          title="Avg Watch Time"
          value={data ? fmtSecs(data.avgWatchSecs ?? 0) : undefined}
          icon={<Clock size={16} />}
          loading={isLoading}
        />
      </div>

      {/* ── Row 2: Concurrent viewers over time (full width) ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users size={15} /> Concurrent Viewers Over Time
              {concData?.peak.concurrent ? (
                <Badge variant="secondary" className="text-[10px] gap-1 font-normal">
                  <Zap size={9} className="text-amber-500" />
                  Peak: {concData.peak.concurrent.toLocaleString()}
                  {concData.peak.ts ? ` · ${fmtBucketTs(concData.peak.ts, concData.granularity)}` : ""}
                </Badge>
              ) : null}
            </CardTitle>
            <span className="text-[10px] text-muted-foreground">
              {concData?.granularity === "hour" ? "Hourly" : concData?.granularity === "4h" ? "4-hour" : "Daily"} buckets
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <ChartErrorBoundary label="Concurrent viewers chart">
            {concLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : concChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={concChartData} margin={{ left: 0, right: 8, top: 8, bottom: 4 }}>
                  <defs>
                    <linearGradient id="concGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.22} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="tvGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="mobileGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22c55e" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="webGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                  <XAxis
                    dataKey="labelTs"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(_label: unknown, payload: unknown) => {
                      const raw = (payload as Array<{ payload: ConcurrentBucket & { rawTs: string } }>)?.[0]?.payload?.rawTs;
                      try { return raw ? format(new Date(raw), "MMM d, HH:mm") : ""; } catch { return ""; }
                    }}
                    formatter={(v: number, name: string) => [v.toLocaleString(), name === "concurrent" ? "Total" : name.charAt(0).toUpperCase() + name.slice(1)]}
                  />
                  <Legend
                    iconType="square"
                    iconSize={8}
                    formatter={(value: string) => <span style={{ fontSize: 11 }}>{value === "concurrent" ? "Total" : value.charAt(0).toUpperCase() + value.slice(1)}</span>}
                  />
                  {/* Peak reference line */}
                  {peakTs && concData!.peak.concurrent > 0 && (
                    <ReferenceLine
                      x={peakTs}
                      stroke="#f59e0b"
                      strokeDasharray="4 3"
                      strokeWidth={1.5}
                      label={{ value: "Peak", position: "insideTopRight", fontSize: 10, fill: "#f59e0b" }}
                    />
                  )}
                  <Area type="monotone" dataKey="tv" stroke={PLATFORM_COLORS.tv} strokeWidth={1.5} fill="url(#tvGrad)" dot={false} activeDot={{ r: 3 }} />
                  <Area type="monotone" dataKey="mobile" stroke={PLATFORM_COLORS.mobile} strokeWidth={1.5} fill="url(#mobileGrad)" dot={false} activeDot={{ r: 3 }} />
                  <Area type="monotone" dataKey="web" stroke={PLATFORM_COLORS.web} strokeWidth={1.5} fill="url(#webGrad)" dot={false} activeDot={{ r: 3 }} />
                  <Area type="monotone" dataKey="concurrent" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#concGrad)" dot={false} activeDot={{ r: 4, fill: "hsl(var(--primary))" }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-56 text-sm text-muted-foreground">
                No concurrent viewer data for this period
              </div>
            )}
          </ChartErrorBoundary>
        </CardContent>
      </Card>

      {/* ── Row 3: Daily views trend + Platform breakdown ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp size={15} /> Daily View Sessions — Last {range}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartErrorBoundary label="Daily views chart">
              {isLoading ? (
                <Skeleton className="h-56 w-full" />
              ) : chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                    <defs>
                      <linearGradient id="viewsGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.12} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number) => [v.toLocaleString(), "Sessions"]}
                    />
                    <Area type="monotone" dataKey="views" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#viewsGrad)" dot={false} activeDot={{ r: 4, fill: "hsl(var(--primary))" }} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-56 text-sm text-muted-foreground">
                  No session data for this period yet
                </div>
              )}
            </ChartErrorBoundary>
          </CardContent>
        </Card>

        {/* Platform breakdown pie */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Monitor size={15} /> Platform Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartErrorBoundary label="Platform breakdown chart">
              {isLoading ? (
                <Skeleton className="h-56 w-full" />
              ) : (data?.platformBreakdown?.length ?? 0) > 0 ? (
                <div className="space-y-3">
                  <ResponsiveContainer width="100%" height={140}>
                    <PieChart>
                      <Pie
                        data={data?.platformBreakdown ?? []}
                        cx="50%"
                        cy="50%"
                        innerRadius={38}
                        outerRadius={60}
                        paddingAngle={3}
                        dataKey="sessions"
                        nameKey="platform"
                      >
                        {(data?.platformBreakdown ?? []).map((entry, index) => (
                          <Cell key={entry.platform} fill={PLATFORM_COLORS[entry.platform] ?? PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                        formatter={(v: number) => [v.toLocaleString(), "Sessions"]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-2">
                    {(data?.platformBreakdown ?? []).map((p, i) => (
                      <div key={p.platform} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: PLATFORM_COLORS[p.platform] ?? PIE_COLORS[i % PIE_COLORS.length] }} />
                          <span className="flex items-center gap-1 capitalize text-xs">
                            {PLATFORM_ICONS[p.platform]}
                            {p.platform}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{p.sessions.toLocaleString()}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {totalPlatformSessions > 0 ? `${Math.round((p.sessions / totalPlatformSessions) * 100)}%` : "0%"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-56 text-sm text-muted-foreground">
                  No platform data yet
                </div>
              )}
            </ChartErrorBoundary>
          </CardContent>
        </Card>
      </div>

      {/* ── Row 4: Daily platform stacked bar (device breakdown over time) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Tv2 size={15} /> Device Sessions Over Time
            <span className="text-[10px] text-muted-foreground font-normal ml-1">TV · Mobile · Web per day</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartErrorBoundary label="Device breakdown chart">
            {platLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : platChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={platChartData} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.12} vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number, name: string) => [v.toLocaleString(), name.charAt(0).toUpperCase() + name.slice(1)]}
                  />
                  <Legend
                    iconType="square"
                    iconSize={8}
                    formatter={(value: string) => <span style={{ fontSize: 11 }}>{value.charAt(0).toUpperCase() + value.slice(1)}</span>}
                  />
                  <Bar dataKey="tv" stackId="a" fill={PLATFORM_COLORS.tv} maxBarSize={40} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="mobile" stackId="a" fill={PLATFORM_COLORS.mobile} maxBarSize={40} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="web" stackId="a" fill={PLATFORM_COLORS.web} maxBarSize={40} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-56 text-sm text-muted-foreground">
                No device data for this period
              </div>
            )}
          </ChartErrorBoundary>
        </CardContent>
      </Card>

      {/* ── Row 5: Top videos bar chart ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart2 size={15} /> Top Videos by All-Time Views
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartErrorBoundary label="Top videos chart">
            {isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : topVideosChart.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={topVideosChart} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)} />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number) => [v.toLocaleString(), "Views"]}
                  />
                  <Bar dataKey="views" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-56 text-sm text-muted-foreground">
                No video data yet
              </div>
            )}
          </ChartErrorBoundary>
        </CardContent>
      </Card>

      {/* ── Row 6: Top videos list with thumbnails ── */}
      {(data?.topVideos?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Film size={15} /> Top 10 Videos
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {(data?.topVideos ?? []).map((video, idx) => (
                <div key={video.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-5 text-center text-xs font-bold text-muted-foreground/50 flex-shrink-0">{idx + 1}</span>
                  {video.thumbnailUrl && (
                    <img
                      src={video.thumbnailUrl}
                      alt=""
                      className="w-14 h-8 object-contain rounded flex-shrink-0 bg-black"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  )}
                  <p className="flex-1 text-sm truncate min-w-0">{video.title}</p>
                  <Badge variant="secondary" className="text-[10px] flex-shrink-0">
                    {Number(video.viewCount ?? 0).toLocaleString()} views
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
