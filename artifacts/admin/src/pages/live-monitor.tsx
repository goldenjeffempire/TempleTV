import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSSE, useSSEEvent } from "@/contexts/sse-context";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Signal, Users, Activity, RefreshCw, Wifi } from "lucide-react";

interface LiveMonitorData {
  viewersByPlatform: Array<{ platform: string; count: number }>;
  peakViewers: number;
  avgWatchTime: number;
  bufferingRate: number;
  bitrateLadder: Array<{ label: string; viewers: number }>;
}

export default function LiveMonitorPage() {
  const qc = useQueryClient();
  const { lastStatusPayload } = useSSE();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["live-monitor"],
    queryFn: () => api.get<LiveMonitorData>("/admin/live/monitor").catch(() => null),
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  useSSEEvent("status", () => { void qc.invalidateQueries({ queryKey: ["live-monitor"] }); });

  const totalViewers = lastStatusPayload?.deviceCount ?? 0;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Live Monitor"
        description="Real-time viewer analytics during live broadcasts."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {/* Top stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{totalViewers.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1"><Users size={11} /> Live viewers</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{isLoading ? "–" : (data?.peakViewers?.toLocaleString() ?? "—")}</div>
            <div className="text-xs text-muted-foreground mt-1">Peak viewers</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{isLoading ? "–" : (data?.bufferingRate != null ? `${data.bufferingRate}%` : "—")}</div>
            <div className="text-xs text-muted-foreground mt-1">Buffering rate</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">
              {isLoading ? "–" : (data?.avgWatchTime != null ? `${Math.floor(data.avgWatchTime / 60)}m` : "—")}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Avg watch time</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Viewers by platform */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Signal size={15} /> Viewers by Platform</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (data?.viewersByPlatform?.length ?? 0) > 0 ? (
              <div className="space-y-3">
                {data?.viewersByPlatform?.map(p => (
                  <div key={p.platform}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm capitalize">{p.platform}</span>
                      <span className="text-sm font-medium">{p.count}</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${totalViewers > 0 ? (p.count / totalViewers) * 100 : 0}%`, minWidth: p.count > 0 ? 4 : 0 }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Wifi size={24} className="text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">No viewer data — start a broadcast first</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Bitrate ladder */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Activity size={15} /> Bitrate Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (data?.bitrateLadder?.length ?? 0) > 0 ? (
              <div className="space-y-2">
                {data?.bitrateLadder?.map(tier => (
                  <div key={tier.label} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <span className="text-sm">{tier.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">{tier.viewers} viewers</span>
                      <Badge variant="outline" className="text-[10px]">
                        {totalViewers > 0 ? `${Math.round((tier.viewers / totalViewers) * 100)}%` : "0%"}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Activity size={24} className="text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">No bitrate data available</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
