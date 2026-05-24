import { Component, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { MetricCard } from "@/components/shared/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BarChart2, Eye, Clock, Film, Tv2, Smartphone, Monitor, TrendingUp, CheckCircle2, RefreshCw, Download } from "lucide-react";
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
} from "@/lib/recharts-shim";
import { format, parseISO } from "date-fns";

// ── Chart-level error boundary ─────────────────────────────────────────────
// Prevents a Recharts render error (e.g. bad data shape, SVG bug) from
// crashing the entire analytics page. Each chart section is wrapped
// independently so the rest of the page stays functional.
interface ChartEBState { failed: boolean; message: string }
class ChartErrorBoundary extends Component<{ children: ReactNode; label?: string }, ChartEBState> {
  state: ChartEBState = { failed: false, message: "" };

  static getDerivedStateFromError(err: Error): ChartEBState {
    return { failed: true, message: err.message };
  }

  componentDidCatch(err: Error) {
    console.error("[ChartErrorBoundary]", err);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex flex-col items-center justify-center h-56 gap-2 text-sm text-muted-foreground">
          <span className="text-xs text-destructive/80">
            {this.props.label ?? "Chart"} failed to render
          </span>
          <button
            type="button"
            className="text-xs text-primary underline underline-offset-2"
            onClick={() => this.setState({ failed: false, message: "" })}
          >
            Retry
          </button>
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

const RANGE_OPTIONS: { label: string; value: RangeKey }[] = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
];

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
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
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>("30d");

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["analytics-overview", range],
    queryFn: () =>
      api.get<AnalyticsOverview>(`/admin/analytics/overview?range=${range}`),
    staleTime: 60_000,
  });

  // Memoize chart transforms so Recharts tooltip hover (which triggers a
  // re-render of the parent) doesn't rebuild the entire dataset on every
  // mouse move. Without memoization a 90-day range rebuilds ~90 objects
  // dozens of times per second while the user hovers the chart.
  const chartData = useMemo(
    () =>
      (data?.dailyViews ?? []).map((d) => ({
        date: fmtDate(d.date),
        views: d.views,
      })),
    [data?.dailyViews],
  );

  const topVideosChart = useMemo(
    () =>
      (data?.topVideos ?? []).slice(0, 8).map((v) => ({
        name: v.title.length > 22 ? v.title.slice(0, 22) + "…" : v.title,
        views: v.viewCount,
      })),
    [data?.topVideos],
  );

  const totalPlatformSessions = useMemo(
    () => (data?.platformBreakdown ?? []).reduce((s, p) => s + p.sessions, 0),
    [data?.platformBreakdown],
  );

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Analytics"
        description="Viewer engagement, watch-time trends and content performance."
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
                // Range-tagged filename so multiple exports don't collide.
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
            <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5 h-7" aria-label="Refresh analytics">
              <RefreshCw size={12} />
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

      {/* Top metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total Views"
          value={data?.totalViews?.toLocaleString()}
          icon={<Eye size={16} />}
          loading={isLoading}
        />
        <MetricCard
          title="Sessions"
          value={data?.totalSessions?.toLocaleString()}
          icon={<TrendingUp size={16} />}
          loading={isLoading}
        />
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Daily views trend — spans 2 columns */}
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
                  <Area
                    type="monotone"
                    dataKey="views"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#viewsGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: "hsl(var(--primary))" }}
                  />
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

        {/* Platform breakdown */}
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
                        <Cell
                          key={entry.platform}
                          fill={PLATFORM_COLORS[entry.platform] ?? PIE_COLORS[index % PIE_COLORS.length]}
                        />
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
                        <div
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ background: PLATFORM_COLORS[p.platform] ?? PIE_COLORS[i % PIE_COLORS.length] }}
                        />
                        <span className="flex items-center gap-1 capitalize text-xs">
                          {PLATFORM_ICONS[p.platform]}
                          {p.platform}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{p.sessions.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {totalPlatformSessions > 0
                            ? `${Math.round((p.sessions / totalPlatformSessions) * 100)}%`
                            : "0%"}
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

      {/* Top videos */}
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
                <XAxis
                  type="number"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
                />
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

      {/* Top videos list with thumbnails */}
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
                  <span className="w-5 text-center text-xs font-bold text-muted-foreground/50 flex-shrink-0">
                    {idx + 1}
                  </span>
                  {video.thumbnailUrl && (
                    <img
                      src={video.thumbnailUrl}
                      alt=""
                      className="w-14 h-8 object-contain rounded flex-shrink-0 bg-black"
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
