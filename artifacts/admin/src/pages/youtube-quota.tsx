import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, Tv2, AlertTriangle } from "lucide-react";

interface QuotaStatus {
  used: number;
  total: number;
  resetsAt: string;
  operations: Array<{ operation: string; cost: number; count: number }>;
}

export default function YoutubeQuotaPage() {
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["youtube-quota"],
    queryFn: () => api.get<QuotaStatus>("/admin/youtube/quota").catch(() => null),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  // Refresh immediately when quota events arrive so operators see the updated
  // usage figures without waiting for the next 60-second poll.
  useSSEEvent("youtube-quota-throttled", () => { void qc.invalidateQueries({ queryKey: ["youtube-quota"] }); });
  useSSEEvent("youtube-quota-exhausted", () => { void qc.invalidateQueries({ queryKey: ["youtube-quota"] }); });
  useSSEEvent("youtube-quota-warning",   () => { void qc.invalidateQueries({ queryKey: ["youtube-quota"] }); });

  const pct = data ? Math.round((data.used / data.total) * 100) : 0;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader
        title="YouTube Quota"
        description="Monitor YouTube API daily quota consumption and operation costs."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Tv2 size={15} /> Daily Quota Usage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? <Skeleton className="h-20 w-full" /> : !data ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Tv2 size={28} className="text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">YouTube API not configured</p>
              <p className="text-xs text-muted-foreground">Set up YouTube API credentials to track quota.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{data.used.toLocaleString()} / {data.total.toLocaleString()} units</span>
                <Badge variant={pct > 90 ? "destructive" : pct > 70 ? "secondary" : "outline"}>
                  {pct}% used
                </Badge>
              </div>
              <Progress value={pct} className="h-3" />
              {pct > 80 && (
                <div className="flex items-center gap-2 text-amber-600 text-sm">
                  <AlertTriangle size={14} />
                  <span>Quota running low — resets {new Date(data.resetsAt).toLocaleString()}</span>
                </div>
              )}
              {!isLoading && data.resetsAt && pct <= 80 && (
                <p className="text-xs text-muted-foreground">Resets {new Date(data.resetsAt).toLocaleString()}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {data?.operations && data.operations.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Operations Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="p-0 divide-y">
            {data.operations.map(op => (
              <div key={op.operation} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium capitalize">{op.operation.replace(/_/g, " ")}</p>
                  <p className="text-xs text-muted-foreground">{op.count} calls × {op.cost} units each</p>
                </div>
                <Badge variant="outline" className="font-mono">{(op.count * op.cost).toLocaleString()}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
