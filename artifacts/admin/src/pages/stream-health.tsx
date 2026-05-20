import { useQuery } from "@tanstack/react-query";
import { api, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Activity, Wifi, Server, CheckCircle2, AlertCircle, RefreshCw,
} from "lucide-react";

interface NetworkStatus {
  encoderStatus: string;
  streamStatus: string;
  cdnStatus: string;
  playerStatus: string;
  lastCheckedAt: string;
}

interface ReadyzResponse {
  status: string;
  uptimeSec: number;
  version: string;
  dependencies: { database: string; cache: string; storage: string };
  broadcast: { channelId: string; viewerCount: number; hasCurrent: boolean };
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${ok ? "bg-green-500" : "bg-red-500"}`} />
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0">
      <div className="flex items-center gap-2.5">
        <StatusDot ok={ok} />
        <span className="text-sm">{label}</span>
      </div>
      <Badge variant={ok ? "outline" : "destructive"} className="capitalize text-[11px]">
        {value}
      </Badge>
    </div>
  );
}

export default function StreamHealthPage() {
  const qc = useQueryClient();

  const { data: readyz, isLoading: readyzLoading, error: readyzError, refetch } = useQuery({
    queryKey: ["readyz"],
    queryFn: () => api.get<ReadyzResponse>("/readyz"),
    refetchInterval: 15_000,
  });

  const { data: networkStatus, isLoading: networkLoading } = useQuery({
    queryKey: ["network-status"],
    queryFn: () => api.get<NetworkStatus>("/network/status").catch(() => null),
    refetchInterval: 15_000,
  });

  useSSEEvent("stream-health", () => { void qc.invalidateQueries({ queryKey: ["readyz"] }); });

  const deps = readyz?.dependencies;
  const allOk = deps ? Object.values(deps).every(v => v === "ok") : false;
  const uptimeHrs = readyz ? Math.floor(readyz.uptimeSec / 3600) : 0;
  const uptimeMins = readyz ? Math.floor((readyz.uptimeSec % 3600) / 60) : 0;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Stream Health"
        description="Real-time system health, uptime, and dependency status."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {readyzError && (
        <ErrorAlert
          message={(readyzError as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(readyzError)}
        />
      )}

      {/* Overall status */}
      <div className={`flex items-center gap-3 p-4 rounded-lg border ${allOk ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
        {readyzLoading ? <Skeleton className="h-6 w-48" /> : (
          <>
            {allOk ? <CheckCircle2 size={20} className="text-green-500" /> : <AlertCircle size={20} className="text-red-500" />}
            <div>
              <p className="font-semibold text-sm">{allOk ? "All systems operational" : "Degraded — check below"}</p>
              {readyz && (
                <p className="text-xs text-muted-foreground">
                  Uptime: {uptimeHrs}h {uptimeMins}m · v{readyz.version}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* API Dependencies */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Server size={15} /> API Dependencies</CardTitle>
          </CardHeader>
          <CardContent>
            {readyzLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : deps ? (
              <div>
                <StatusRow label="Database" value={deps.database} ok={deps.database === "ok"} />
                <StatusRow label="Cache" value={deps.cache} ok={deps.cache === "ok"} />
                <StatusRow label="Storage" value={deps.storage} ok={deps.storage === "ok"} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">No data</p>
            )}
          </CardContent>
        </Card>

        {/* Broadcast Status */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Activity size={15} /> Broadcast Engine</CardTitle>
          </CardHeader>
          <CardContent>
            {readyzLoading ? (
              <div className="space-y-2">{[1,2].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : readyz?.broadcast ? (
              <div>
                <StatusRow label="Current Program" value={readyz.broadcast.hasCurrent ? "active" : "idle"} ok={true} />
                <div className="flex items-center justify-between py-2.5 border-b last:border-0">
                  <div className="flex items-center gap-2.5">
                    <StatusDot ok={true} />
                    <span className="text-sm">Active Viewers</span>
                  </div>
                  <span className="font-semibold text-sm">{readyz.broadcast.viewerCount.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-2.5">
                    <StatusDot ok={true} />
                    <span className="text-sm">Channel</span>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground truncate max-w-[150px]">{readyz.broadcast.channelId}</span>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Network Status */}
        {networkStatus && (
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2"><Wifi size={15} /> Network Components</CardTitle>
            </CardHeader>
            <CardContent>
              {networkLoading ? (
                <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : (
                <div className="grid grid-cols-2 gap-x-8">
                  <StatusRow label="Encoder" value={networkStatus.encoderStatus} ok={networkStatus.encoderStatus === "ok"} />
                  <StatusRow label="Stream" value={networkStatus.streamStatus} ok={networkStatus.streamStatus === "ok"} />
                  <StatusRow label="CDN" value={networkStatus.cdnStatus} ok={networkStatus.cdnStatus === "ok"} />
                  <StatusRow label="Players" value={networkStatus.playerStatus} ok={networkStatus.playerStatus === "ok"} />
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
