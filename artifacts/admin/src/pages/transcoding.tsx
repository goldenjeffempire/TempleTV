import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { useAuth } from "@/contexts/use-auth";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Clapperboard, RefreshCw, CheckCircle2, XCircle, Loader2,
  Clock, AlertCircle, RotateCcw, Zap, Ban, Trash2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface TranscodingJob {
  id: string;
  videoId: string;
  videoTitle?: string | null;
  status: "queued" | "encoding" | "processing" | "ready" | "hls_ready" | "failed" | "cancelled";
  progress?: number;
  createdAt: string;
  startedAt?: string | null;
  lastProgressAt?: string | null;
  updatedAt?: string;
  errorMessage?: string | null;
  transcodingErrorCode?: string | null;
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
  const { isAdmin } = useAuth();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["transcoding-queue"],
    queryFn: () => api.get<{ jobs: TranscodingJob[] }>("/admin/transcoding/queue"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  useSSEEvent("transcoding-update", () => { void qc.invalidateQueries({ queryKey: ["transcoding-queue"] }); });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/admin/transcoding/retry/${jobId}`),
    onSuccess: () => {
      toast.success("Job requeued for transcoding");
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      // Retry changes the video's transcodingStatus back to "queued" — sync the
      // Video Library badge so it stops showing "HLS failed" immediately.
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      // Retrying a job can change the broadcast queue's HLS-readiness state —
      // invalidate immediately without waiting for the next SSE cycle (which
      // only fires on pages where broadcast-v2 is mounted).
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Retry failed"),
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/admin/transcoding/cancel/${jobId}`),
    onSuccess: () => {
      toast.success("Job cancelled");
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      // Cancel changes transcodingStatus — reflect this in the Video Library
      // immediately rather than waiting for its next 30 s stale refresh.
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Cancel failed"),
  });

  const bulkTranscodeMutation = useMutation({
    mutationFn: () => api.post<{ queued: number; skipped: number; message: string }>("/admin/videos/bulk-transcode"),
    onSuccess: (res) => {
      toast.success(res.message);
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      // Sync the Video Library — bulk transcode sets many transcodingStatus
      // values to "queued"; without this the library tab continues to show
      // stale "HLS failed" or "none" badges until the user manually refreshes.
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Bulk transcode failed"),
  });

  const retryAllMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; retried: number }>("/admin/transcoding/retry-failed"),
    onSuccess: (res) => {
      toast.success(res.retried > 0 ? `Re-queued ${res.retried} failed job${res.retried !== 1 ? "s" : ""}` : "No failed jobs to retry");
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Retry all failed"),
  });

  // Admin-only: clear finished jobs (done/failed/cancelled).
  // Active (queued/processing) jobs are NEVER deleted by the server.
  const clearFinishedMutation = useMutation({
    mutationFn: () => api.delete<{ cleared: number }>("/admin/transcoding/clear?status=all"),
    onSuccess: (res) => {
      toast.success(res.cleared > 0 ? `Cleared ${res.cleared} finished job${res.cleared !== 1 ? "s" : ""}` : "No finished jobs to clear");
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      // Video Library shows per-row transcoding badges — clearing finished jobs
      // can affect the displayed status; sync it so stale "Encoding…" badges disappear.
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Clear finished jobs failed"),
  });

  const jobs = data?.jobs ?? [];
  const active = jobs.filter(j => ["queued", "encoding", "processing"].includes(j.status));
  const done = jobs.filter(j => ["ready", "hls_ready", "failed", "cancelled"].includes(j.status));
  const failedJobs = jobs.filter(j => j.status === "failed");

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Transcoding Pipeline"
        description="Monitor HLS encoding jobs and processing status."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Retry All Failed — editor+ */}
            {failedJobs.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={retryAllMutation.isPending}
                    className="gap-1.5"
                  >
                    {retryAllMutation.isPending
                      ? <><Loader2 size={13} className="animate-spin" /> Retrying…</>
                      : <><RotateCcw size={13} /> Retry All Failed</>}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Retry all {failedJobs.length} failed job{failedJobs.length !== 1 ? "s" : ""}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This re-queues every failed job and nudges the dispatcher to pick them up immediately.
                      Jobs whose source file is corrupted or missing will fail again.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => retryAllMutation.mutate()}>
                      Retry All
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}

            {/* Clear Finished Jobs — admin only */}
            {isAdmin && done.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={clearFinishedMutation.isPending}
                    className="gap-1.5 text-destructive hover:text-destructive"
                  >
                    {clearFinishedMutation.isPending
                      ? <><Loader2 size={13} className="animate-spin" /> Clearing…</>
                      : <><Trash2 size={13} /> Clear Finished</>}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear {done.length} finished job{done.length !== 1 ? "s" : ""}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes all completed, failed, and cancelled job records from the queue.
                      Active jobs (queued or encoding) are never affected. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => clearFinishedMutation.mutate()}
                    >
                      Clear Finished Jobs
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  disabled={bulkTranscodeMutation.isPending}
                  className="gap-1.5"
                >
                  {bulkTranscodeMutation.isPending
                    ? <><Loader2 size={13} className="animate-spin" /> Queuing…</>
                    : <><Zap size={13} /> Transcode All Unprocessed</>}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Transcode all unprocessed videos?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This queues an HLS encode job for every video that isn't already
                    processed. On a large library this can place heavy, sustained load on
                    the transcoding pipeline and slow other encodes. Continue?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={bulkTranscodeMutation.isPending}
                    onClick={() => bulkTranscodeMutation.mutate()}
                  >
                    Transcode All
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
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
                  const STALL_MS = 10 * 60_000; // 10 min without a progress update
                  const progressStalledMs = job.lastProgressAt
                    ? Date.now() - new Date(job.lastProgressAt).getTime()
                    : job.startedAt
                    ? Date.now() - new Date(job.startedAt).getTime()
                    : null;
                  const isProgressStalled =
                    job.status === "encoding" &&
                    progressStalledMs !== null &&
                    progressStalledMs > STALL_MS;
                  return (
                    <div
                      key={job.id}
                      className={`border rounded-lg p-3 space-y-2 ${isProgressStalled ? "border-amber-400/60 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        {cfg.icon}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{job.videoTitle || job.videoId}</p>
                          <p className="text-xs text-muted-foreground font-mono">{job.id.slice(0, 20)}…</p>
                        </div>
                        {isProgressStalled && (
                          <Badge variant="outline" className="border-amber-400 text-amber-600 dark:text-amber-400 gap-1 text-[11px] shrink-0">
                            <AlertCircle size={10} /> Stalled
                          </Badge>
                        )}
                        <Badge variant={cfg.color as "outline" | "secondary" | "default" | "destructive"}>
                          {cfg.label}
                        </Badge>
                      </div>
                      {job.status === "encoding" && (
                        <div className="space-y-1">
                          <Progress value={job.progress ?? 0} className="h-1.5" />
                          <div className="flex items-center justify-between">
                            {job.progress != null && (
                              <p className="text-xs text-muted-foreground">{job.progress}% complete</p>
                            )}
                            {isProgressStalled && progressStalledMs !== null && (
                              <p className="text-xs text-amber-600 dark:text-amber-400">
                                No progress update for {Math.round(progressStalledMs / 60_000)} min — watchdog will reset shortly
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          {job.startedAt
                            ? `Started ${formatDistanceToNow(new Date(job.startedAt), { addSuffix: true })}`
                            : `Queued ${formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}`}
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
                      <p className="text-sm truncate">{job.videoTitle || job.videoId}</p>
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
