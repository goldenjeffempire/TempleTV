/**
 * ViewerCountPanel
 *
 * Real-time viewer tracking card for the Master Control page.
 * Powered by the viewer-tracking heartbeat system (Redis ZSET backend).
 *
 * Shows:
 *  - Current live viewer count across all streams (or a specific streamId)
 *  - All-time peak for this session
 *  - 5-minute sparkline trend (recharts AreaChart)
 *  - Per-stream breakdown when multiple streams are active
 *
 * Data is invalidated by the `viewer-count-updated` SSE event so latency
 * is typically <5 s from when a viewer joins/leaves.
 */
import { memo } from "react";
import { Users, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
} from "@/lib/recharts-shim";
import { useViewerTracking, type TrendPoint } from "@/hooks/useViewerTracking";

interface Props {
  streamId?: string;
}

function formatRelativeTime(ts: number, now: number): string {
  const diffS = Math.round((now - ts) / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  return `${Math.round(diffS / 60)}m ago`;
}

function Sparkline({ trend }: { trend: TrendPoint[] }) {
  if (trend.length < 2) {
    return (
      <div className="h-12 flex items-center justify-center text-xs text-muted-foreground">
        Collecting data…
      </div>
    );
  }

  const now = Date.now();
  const data = trend.map((p) => ({
    label: formatRelativeTime(p.ts, now),
    count: p.count,
  }));

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <ResponsiveContainer width="100%" height={52}>
      <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="vtGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" hide />
        <YAxis domain={[0, maxCount + 1]} hide />
        <RechartsTooltip
          contentStyle={{ fontSize: 11, padding: "2px 8px" }}
          formatter={(val: number) => [`${val} viewers`, ""]}
          labelFormatter={(label: string) => label}
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke="#3b82f6"
          strokeWidth={1.5}
          fill="url(#vtGrad)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function TrendIcon({ trend }: { trend: TrendPoint[] }) {
  if (trend.length < 2) return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  const recent = trend.slice(-3);
  const first  = recent[0]?.count ?? 0;
  const last   = recent[recent.length - 1]?.count ?? 0;
  if (last > first) return <TrendingUp   className="h-3.5 w-3.5 text-emerald-500" />;
  if (last < first) return <TrendingDown className="h-3.5 w-3.5 text-amber-500" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

export const ViewerCountPanel = memo(function ViewerCountPanel({ streamId }: Props) {
  const { data, isLoading } = useViewerTracking(streamId);

  const totalCurrent = data?.totalCurrent ?? 0;
  const totalPeak    = data?.totalPeak    ?? 0;
  const streams      = data?.streams      ?? [];

  // Combine trend across all streams for the aggregate view
  const aggregateTrend: TrendPoint[] = (() => {
    if (!data || streams.length === 0) return [];
    if (streamId) {
      return streams[0]?.trend ?? [];
    }
    // Merge per-stream trends into a single time-bucketed series
    const buckets = new Map<number, number>();
    for (const s of streams) {
      for (const p of s.trend) {
        buckets.set(p.ts, (buckets.get(p.ts) ?? 0) + p.count);
      }
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, count]) => ({ ts, count }));
  })();

  return (
    <Card>
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Users className="h-4 w-4 text-blue-500 shrink-0" />
          <CardTitle className="text-sm">
            {streamId ? "Stream Viewers" : "Real-Time Viewers"}
          </CardTitle>
          <Badge
            variant={totalCurrent > 0 ? "default" : "secondary"}
            className="ml-0.5 tabular-nums"
          >
            {isLoading && totalCurrent === 0 ? "—" : totalCurrent.toLocaleString()}
          </Badge>
          <TrendIcon trend={aggregateTrend} />
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            Peak: {totalPeak.toLocaleString()}
          </span>
        </div>
      </CardHeader>
      <CardContent className="pb-4 space-y-3">
        {/* Sparkline — 5-min rolling trend */}
        <Sparkline trend={aggregateTrend} />

        {/* Per-stream breakdown (only when >1 stream active) */}
        {streams.length > 1 && (
          <div className="grid gap-1 text-xs pt-1 border-t">
            {streams.map((s) => (
              <div key={s.streamId} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground truncate max-w-[160px]" title={s.streamId}>
                  {s.streamId}
                </span>
                <span className="tabular-nums font-medium">{s.current.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}

        {!isLoading && totalCurrent === 0 && streams.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-1">
            No active viewers — heartbeats appear within 10 s of a session joining.
          </p>
        )}
      </CardContent>
    </Card>
  );
});
