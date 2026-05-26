import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Clapperboard, RefreshCw, CheckCircle2, XCircle, Loader2,
  Clock, AlertCircle, RotateCcw, Zap, Ban,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface TranscodingJob {
  id: string;
  videoId: string;
  title?: string;
  status: "queued" | "encoding" | "processing" | "ready" | "hls_ready" | "failed" | "cancelled";
  progress?: number;
  createdAt: string;
  updatedAt?: string;
  errorMessage?: string;
}

const STATUS_CONFIG = {
  queued:     { label: "Queued",      color: "outline",     icon: <Clock size={13} className="text-muted-foreground" /> },
  encoding:   { label: "Encoding",    color: "secondary",   icon: <Loader2 size={13} className="animate-spin text-amber-500" /> },
  processing: { label: "Processing",  color: "secondary",   icon: <Loader2 size={13} className="animate-spin text-blue-500" /> },
  ready:      { label: "Ready",       color: "default",     icon: <CheckCircle2 size={13} className="text-green-500" /> },
  hls_ready:  { label: "HLS Ready",   color: "default",     icon: <CheckCircle2 size={13} className="text-green-500" /> },
  failed:     { label: "Failed",      color: "destructive", icon: <XCircle size={13} className="text-red-500" /> },
  cancelled:  { label: "Cancelled",   color: "outline",     icon: <AlertCircle size={13} className="text-muted-foreground" /> },
} as const;

export default function TranscodingPage() {
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["transcoding-queue"],
    queryFn: () => api.get<{ jobs: TranscodingJob[] }>("/admin/transcoding/queue"),
    refetchInterval: 8_000,
    staleTime: 6_000,
  });

  useSSEEvent("transcoding-update", () => { void qc.invalidateQueries({ queryKey: ["transcoding-queue"] }); });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/admin/transcoding/retry/${jobId}`),
    onSuccess: () => {
      toast.success("Job requeued for transcoding");
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Retry failed"),
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/admin/transcoding/cancel/${jobId}`),
    onSuccess: () => {
      toast.success("Job cancelled");
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Cancel failed"),
  });

  const bulkTranscodeMutation = useMutation({
    mutationFn: () => api.post<{ queued: number; skipped: number; message: string }>("/admin/videos/bulk-transcode"),
    onSuccess: (res) => {
      toast.success(res.message);
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Bulk transcode failed"),
  });

  const jobs = data?.jobs ?? [];
  const active = jobs.filter(j => ["queued", "encoding", "processing"].includes(j.status));
  const done = jobs.filter(j => ["ready", "hls_ready", "failed", "cancelled"].includes(j.status));

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Transcoding Pipeline"
        description="Monitor HLS encoding jobs and processing status."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => bulkTranscodeMutation.mutate()}
              disabled={bulkTranscodeMutation.isPending}
              className="gap-1.5"
            >
              {bulkTranscodeMutation.isPending
                ? <><Loader2 size={13} className="animate-spin" /> Queuing…</>
                : <><Zap size={13} /> Transcode All Unprocessed</>}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
              <RefreshCw size={13} /> Refresh
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

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Active",   count: active.length,                                   color: "text-amber-500" },
          { label: "Queued",   count: jobs.filter(j => j.status === "queued").length,   color: "text-muted-foreground" },
          { label: "Complete", count: jobs.filter(j => j.status === "hls_ready").length, color: "text-green-500" },
          { label: "Failed",   count: jobs.filter(j => j.status === "failed").length,   color: "text-red-500" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="pt-4 pb-3">
              <div className={`text-2xl font-bold ${s.color}`}>{isLoading ? "–" : s.count}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Active Jobs */}
      {(active.length > 0 || isLoading) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Loader2 size={15} className="animate-spin text-amber-500" />
              Active Jobs ({active.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">{[1,2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
            ) : (
              <div className="space-y-3">
                {active.map(job => {
                  const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.queued;
                  return (
                    <div key={job.id} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        {cfg.icon}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{job.title || job.videoId}</p>
                          <p className="text-xs text-muted-foreground font-mono">{job.id.slice(0, 20)}…</p>
                        </div>
                        <Badge variant={cfg.color as "outline" | "secondary" | "default" | "destructive"}>
                          {cfg.label}
                        </Badge>
                      </div>
                      {job.status === "encoding" && (
                        <div className="space-y-1">
                          <Progress value={job.progress ?? 0} className="h-1.5" />
                          {job.progress != null && (
                            <p className="text-xs text-muted-foreground">{job.progress}% complete</p>
                          )}
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          Started {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                        </p>
                        {job.status === "queued" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[11px] gap-1 text-muted-foreground hover:text-destructive"
                            onClick={() => cancelMutation.mutate(job.id)}
                            disabled={cancelMutation.isPending}
                            title="Cancel this queued job"
                          >
                            <Ban size={11} /> Cancel
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Completed / Failed Jobs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clapperboard size={15} />
            {active.length === 0 && jobs.length === 0 ? "All Jobs" : "Completed / Failed"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <CheckCircle2 size={28} className="text-green-500" />
              <p className="font-medium text-sm">Queue is empty</p>
              <p className="text-xs text-muted-foreground">No transcoding jobs pending.</p>
            </div>
          ) : done.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No completed jobs yet.</p>
          ) : (
            <div className="space-y-1">
              {done.slice(0, 30).map(job => {
                const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.cancelled;
                return (
                  <div key={job.id} className="flex items-start gap-2.5 py-2.5 border-b last:border-0 group">
                    <div className="mt-0.5 flex-shrink-0">{cfg.icon}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{job.title || job.videoId}</p>
                      {job.errorMessage && (
                        <p className="text-xs text-red-500 truncate mt-0.5">{job.errorMessage}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(job.updatedAt ?? job.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {job.status === "failed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-xs gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => retryMutation.mutate(job.id)}
                          disabled={retryMutation.isPending}
                          title="Retry transcoding"
                        >
                          <RotateCcw size={11} /> Retry
                        </Button>
                      )}
                      <Badge
                        variant={cfg.color as "outline" | "secondary" | "default" | "destructive"}
                      >
                        {cfg.label}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
