import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { useAuth } from "@/contexts/use-auth";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Clapperboard, RefreshCw, CheckCircle2, XCircle, Loader2, Clock,
  AlertCircle, RotateCcw, Zap, Ban, Trash2, Server, History,
  AlertTriangle, Activity, ArrowRight, Skull, ListOrdered,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface TranscodingJob {
  id: string;
  videoId: string;
  videoTitle?: string | null;
  status: "queued" | "encoding" | "processing" | "ready" | "hls_ready" | "failed" | "cancelled" | "dead_letter";
  stage?: string | null;
  progress?: number;
  createdAt: string;
  startedAt?: string | null;
  lastProgressAt?: string | null;
  updatedAt?: string;
  errorMessage?: string | null;
  transcodingErrorCode?: string | null;
  leasedBy?: string | null;
  leaseExpiresAt?: string | null;
}

interface WorkerInfo {
  workerId: string;
  hostname: string;
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  currentJobId: string | null;
  currentStage: string | null;
  jobsCompleted: number;
  jobsFailed: number;
  version: string | null;
  isStale: boolean;
}

interface DlqEntry {
  id: string;
  jobId: string;
  videoId: string | null;
  videoTitle: string | null;
  attempts: number;
  lastError: string | null;
  errorCode: string | null;
  deadLetteredAt: string;
  requeuedAt: string | null;
  notes: string | null;
}

const STATUS_CONFIG = {
  queued:      { label: "Queued",       color: "outline",     icon: <Clock size={13} className="text-muted-foreground" /> },
  encoding:    { label: "Encoding",     color: "secondary",   icon: <Loader2 size={13} className="animate-spin text-amber-500" /> },
  processing:  { label: "Processing",   color: "secondary",   icon: <Loader2 size={13} className="animate-spin text-blue-500" /> },
  ready:       { label: "Ready",        color: "default",     icon: <CheckCircle2 size={13} className="text-green-500" /> },
  hls_ready:   { label: "HLS Ready",    color: "default",     icon: <CheckCircle2 size={13} className="text-green-500" /> },
  failed:      { label: "Failed",       color: "destructive", icon: <XCircle size={13} className="text-red-500" /> },
  cancelled:   { label: "Cancelled",    color: "outline",     icon: <AlertCircle size={13} className="text-muted-foreground" /> },
  dead_letter: { label: "Dead Letter",  color: "destructive", icon: <Skull size={13} className="text-red-600" /> },
} as const;

const STAGE_LABELS: Record<string, string> = {
  pending: "Pending",
  validating: "Validating",
  processing: "Processing",
  finalizing: "Finalizing",
  completed: "Completed",
};

function StageBadge({ stage }: { stage?: string | null }) {
  if (!stage || stage === "pending") return null;
  const label = STAGE_LABELS[stage] ?? stage;
  const colorClass =
    stage === "completed" ? "text-green-600 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-900/20 dark:border-green-800" :
    stage === "finalizing" ? "text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-400 dark:bg-blue-900/20 dark:border-blue-800" :
    stage === "processing" ? "text-amber-600 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-900/20 dark:border-amber-800" :
    "text-muted-foreground bg-muted border-border";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border ${colorClass}`}>
      <ArrowRight size={9} />
      {label}
    </span>
  );
}

export default function TranscodingPage() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState("queue");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["transcoding-queue"],
    queryFn: () => api.get<{ jobs: TranscodingJob[] }>("/admin/transcoding/queue"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: workersData, isLoading: workersLoading, refetch: refetchWorkers } = useQuery({
    queryKey: ["transcoding-workers"],
    queryFn: () => api.get<{ workers: WorkerInfo[] }>("/admin/transcoding/workers"),
    refetchInterval: 30_000,
    staleTime: 15_000,
    enabled: tab === "workers",
  });

  const { data: dlqData, isLoading: dlqLoading, refetch: refetchDlq } = useQuery({
    queryKey: ["transcoding-dlq"],
    queryFn: () => api.get<{ entries: DlqEntry[]; total: number }>("/admin/transcoding/dlq"),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: tab === "dlq",
  });

  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
    void qc.invalidateQueries({ queryKey: ["transcoding-workers"] });
    void qc.invalidateQueries({ queryKey: ["transcoding-dlq"] });
  });
  useSSEEvent("transcoding-worker-update", () => {
    void qc.invalidateQueries({ queryKey: ["transcoding-workers"] });
  });

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
    void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
    void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
  };

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/admin/transcoding/retry/${jobId}`),
    onSuccess: () => { toast.success("Job requeued for transcoding"); invalidateAll(); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Retry failed"),
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/admin/transcoding/cancel/${jobId}`),
    onSuccess: () => { toast.success("Job cancelled"); invalidateAll(); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Cancel failed"),
  });

  const bulkTranscodeMutation = useMutation({
    mutationFn: () => api.post<{ queued: number; skipped: number; message: string }>("/admin/videos/bulk-transcode"),
    onSuccess: (res) => { toast.success(res.message); invalidateAll(); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Bulk transcode failed"),
  });

  const retryAllMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; retried: number }>("/admin/transcoding/retry-failed"),
    onSuccess: (res) => {
      toast.success(res.retried > 0 ? `Re-queued ${res.retried} failed job${res.retried !== 1 ? "s" : ""}` : "No failed jobs to retry");
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Retry all failed"),
  });

  const clearFinishedMutation = useMutation({
    mutationFn: () => api.delete<{ cleared: number }>("/admin/transcoding/clear?status=all"),
    onSuccess: (res) => {
      toast.success(res.cleared > 0 ? `Cleared ${res.cleared} finished job${res.cleared !== 1 ? "s" : ""}` : "No finished jobs to clear");
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Clear finished jobs failed"),
  });

  const dlqRequeueMutation = useMutation({
    mutationFn: (dlqId: string) => api.post<{ ok: boolean; jobId: string }>(`/admin/transcoding/dlq/${dlqId}/requeue`),
    onSuccess: () => {
      toast.success("Job re-queued from dead-letter queue");
      void qc.invalidateQueries({ queryKey: ["transcoding-dlq"] });
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Requeue failed"),
  });

  const dlqPurgeMutation = useMutation({
    mutationFn: (dlqId: string) => api.delete(`/admin/transcoding/dlq/${dlqId}`),
    onSuccess: () => {
      toast.success("DLQ entry purged");
      void qc.invalidateQueries({ queryKey: ["transcoding-dlq"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Purge failed"),
  });

  const dlqBulkPurgeMutation = useMutation({
    mutationFn: () => api.delete<{ ok: boolean; purged: number }>("/admin/transcoding/dlq"),
    onSuccess: (res) => {
      toast.success(res.purged > 0 ? `Purged ${res.purged} DLQ entr${res.purged !== 1 ? "ies" : "y"}` : "DLQ already empty");
      void qc.invalidateQueries({ queryKey: ["transcoding-dlq"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Bulk purge failed"),
  });

  // ── Timeline drawer ──────────────────────────────────────────────────────
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  interface JobEvent {
    id: string;
    eventType: string;
    stage: string | null;
    workerId: string | null;
    payload: Record<string, unknown> | null;
    createdAt: string;
  }

  const { data: eventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ["transcoding-job-events", selectedJobId],
    queryFn: () => api.get<{ events: JobEvent[] }>(`/admin/transcoding/jobs/${selectedJobId}/events`),
    enabled: !!selectedJobId,
    staleTime: 30_000,
  });

  const jobs = data?.jobs ?? [];
  const active = jobs.filter(j => ["queued", "encoding", "processing"].includes(j.status));
  const done = jobs.filter(j => ["ready", "hls_ready", "failed", "cancelled", "dead_letter"].includes(j.status));
  const failedJobs = jobs.filter(j => j.status === "failed");
  const workers = workersData?.workers ?? [];
  const dlqEntries = dlqData?.entries ?? [];

  const EVENT_TYPE_COLORS: Record<string, string> = {
    completed: "text-green-600 dark:text-green-400",
    dead_lettered: "text-red-600 dark:text-red-400",
    error: "text-red-500 dark:text-red-400",
    retried: "text-blue-600 dark:text-blue-400",
    started: "text-amber-600 dark:text-amber-400",
    stage_transition: "text-muted-foreground",
  };

  return (
    <>
    {/* ── Timeline Drawer ─────────────────────────────────────────────────── */}
    <Dialog open={!!selectedJobId} onOpenChange={(open) => { if (!open) setSelectedJobId(null); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ListOrdered size={15} />
            Job Timeline
          </DialogTitle>
        </DialogHeader>
        {eventsLoading ? (
          <div className="space-y-2 py-2">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : !eventsData?.events?.length ? (
          <p className="text-sm text-muted-foreground text-center py-6">No events recorded for this job.</p>
        ) : (
          <ScrollArea className="max-h-[420px] pr-1">
            <div className="space-y-0">
              {eventsData.events.map((ev, idx) => (
                <div key={ev.id} className="flex gap-3">
                  {/* Vertical timeline spine */}
                  <div className="flex flex-col items-center">
                    <div className={`w-2 h-2 rounded-full mt-3 shrink-0 ${
                      ev.eventType === "completed" ? "bg-green-500" :
                      ev.eventType === "dead_lettered" || ev.eventType === "error" ? "bg-red-500" :
                      ev.eventType === "retried" ? "bg-blue-500" :
                      ev.eventType === "started" ? "bg-amber-500" :
                      "bg-border"
                    }`} />
                    {idx < eventsData.events.length - 1 && (
                      <div className="w-px flex-1 bg-border mt-1 mb-1" />
                    )}
                  </div>
                  <div className="pb-3 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className={`text-xs font-medium capitalize ${EVENT_TYPE_COLORS[ev.eventType] ?? "text-foreground"}`}>
                        {ev.eventType.replace(/_/g, " ")}
                      </span>
                      {ev.stage && ev.eventType === "stage_transition" && (
                        <span className="text-[10px] text-muted-foreground">→ {STAGE_LABELS[ev.stage] ?? ev.stage}</span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(ev.createdAt), { addSuffix: true })}
                      {ev.workerId && ` · worker ${ev.workerId.slice(0, 8)}…`}
                    </p>
                    {ev.payload && Object.keys(ev.payload).length > 0 && (
                      <p className="text-[10px] text-muted-foreground font-mono break-all mt-0.5 line-clamp-2">
                        {Object.entries(ev.payload).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>

    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Transcoding Pipeline"
        description="Monitor HLS encoding jobs, worker processes, and the dead-letter queue."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {failedJobs.length > 0 && tab === "queue" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={retryAllMutation.isPending} className="gap-1.5">
                    {retryAllMutation.isPending ? <><Loader2 size={13} className="animate-spin" /> Retrying…</> : <><RotateCcw size={13} /> Retry All Failed</>}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Retry all {failedJobs.length} failed job{failedJobs.length !== 1 ? "s" : ""}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Re-queues every failed job and nudges the dispatcher immediately. Jobs with corrupt or missing source files will fail again.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => retryAllMutation.mutate()}>Retry All</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {isAdmin && done.length > 0 && tab === "queue" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={clearFinishedMutation.isPending} className="gap-1.5 text-destructive hover:text-destructive">
                    {clearFinishedMutation.isPending ? <><Loader2 size={13} className="animate-spin" /> Clearing…</> : <><Trash2 size={13} /> Clear Finished</>}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear {done.length} finished job{done.length !== 1 ? "s" : ""}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Permanently removes all completed, failed, and cancelled job records. Active jobs are never affected. Cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => clearFinishedMutation.mutate()}>
                      Clear Finished Jobs
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="default" size="sm" disabled={bulkTranscodeMutation.isPending} className="gap-1.5">
                  {bulkTranscodeMutation.isPending ? <><Loader2 size={13} className="animate-spin" /> Queuing…</> : <><Zap size={13} /> Transcode All</>}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Transcode all unprocessed videos?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Queues an HLS encode job for every video that isn't already processed. Can place heavy, sustained load on the pipeline.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction disabled={bulkTranscodeMutation.isPending} onClick={() => bulkTranscodeMutation.mutate()}>Transcode All</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button variant="outline" size="sm" onClick={() => { void refetch(); void refetchWorkers(); void refetchDlq(); }} className="gap-1.5">
              <RefreshCw size={13} /> Refresh
            </Button>
          </div>
        }
      />

      {error && <ErrorAlert message={(error as Error).message} onRetry={() => void refetch()} transient={isTransientError(error)} />}

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "Active",    count: active.length,                                    color: "text-amber-500" },
          { label: "Queued",    count: jobs.filter(j => j.status === "queued").length,   color: "text-muted-foreground" },
          { label: "Complete",  count: jobs.filter(j => j.status === "hls_ready").length, color: "text-green-500" },
          { label: "Failed",    count: jobs.filter(j => j.status === "failed").length,   color: "text-red-500" },
          { label: "DLQ",       count: dlqEntries.length,                                color: dlqEntries.length > 0 ? "text-orange-500" : "text-muted-foreground" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="pt-4 pb-3">
              <div className={`text-2xl font-bold ${s.color}`}>{isLoading ? "–" : s.count}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="queue" className="gap-1.5">
            <Clapperboard size={13} /> Queue
            {active.length > 0 && <Badge variant="secondary" className="h-4 text-[10px] px-1.5 ml-1">{active.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="workers" className="gap-1.5">
            <Server size={13} /> Workers
            {workers.length > 0 && <Badge variant="secondary" className="h-4 text-[10px] px-1.5 ml-1">{workers.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="dlq" className="gap-1.5">
            <AlertTriangle size={13} /> Dead Letter
            {dlqEntries.length > 0 && <Badge variant="destructive" className="h-4 text-[10px] px-1.5 ml-1">{dlqEntries.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History size={13} /> History
          </TabsTrigger>
        </TabsList>

        {/* ── Queue Tab ────────────────────────────────────────────────────── */}
        <TabsContent value="queue" className="space-y-4 mt-4">
          {/* Active Jobs */}
          {(active.length > 0 || isLoading) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity size={15} className="text-amber-500" />
                  Active Jobs ({active.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-3">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
                ) : (
                  <div className="space-y-3">
                    {active.map(job => {
                      const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.queued;
                      const STALL_MS = 10 * 60_000;
                      const progressStalledMs = job.lastProgressAt
                        ? Date.now() - new Date(job.lastProgressAt).getTime()
                        : job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : null;
                      const isProgressStalled = job.status === "encoding" && progressStalledMs !== null && progressStalledMs > STALL_MS;
                      return (
                        <div key={job.id} className={`border rounded-lg p-3 space-y-2 ${isProgressStalled ? "border-amber-400/60 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}>
                          <div className="flex items-center gap-2">
                            {cfg.icon}
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">{job.videoTitle || job.videoId}</p>
                              <p className="text-xs text-muted-foreground font-mono">{job.id.slice(0, 20)}…</p>
                            </div>
                            <StageBadge stage={job.stage} />
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
                                {job.progress != null && <p className="text-xs text-muted-foreground">{job.progress}% complete</p>}
                                {isProgressStalled && progressStalledMs !== null && (
                                  <p className="text-xs text-amber-600 dark:text-amber-400">
                                    No progress for {Math.round(progressStalledMs / 60_000)} min — watchdog will reset shortly
                                  </p>
                                )}
                              </div>
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <p className="text-xs text-muted-foreground">
                                {job.startedAt
                                  ? `Started ${formatDistanceToNow(new Date(job.startedAt), { addSuffix: true })}`
                                  : `Queued ${formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}`}
                              </p>
                              {job.leasedBy && (
                                <p className="text-xs text-muted-foreground font-mono">
                                  Worker: {job.leasedBy.slice(0, 8)}…
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                                onClick={() => setSelectedJobId(job.id)} title="View job event timeline">
                                <ListOrdered size={11} /> Timeline
                              </Button>
                              {job.status === "queued" && (
                                <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1 text-muted-foreground hover:text-destructive"
                                  onClick={() => cancelMutation.mutate(job.id)} disabled={cancelMutation.isPending} title="Cancel this queued job">
                                  <Ban size={11} /> Cancel
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Failed Jobs */}
          {failedJobs.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2 text-red-600 dark:text-red-400">
                  <XCircle size={15} />
                  Failed Jobs ({failedJobs.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {failedJobs.slice(0, 20).map(job => (
                    <div key={job.id} className="flex items-start gap-2.5 py-2.5 border-b last:border-0 group">
                      <XCircle size={13} className="mt-0.5 text-red-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{job.videoTitle || job.videoId}</p>
                        {job.transcodingErrorCode && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 mt-0.5 border-red-200 text-red-600 dark:text-red-400">
                            {job.transcodingErrorCode}
                          </Badge>
                        )}
                        {job.errorMessage && <p className="text-xs text-red-500 truncate mt-0.5">{job.errorMessage}</p>}
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatDistanceToNow(new Date(job.updatedAt ?? job.createdAt), { addSuffix: true })}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" className="h-6 text-xs gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => retryMutation.mutate(job.id)} disabled={retryMutation.isPending} title="Retry transcoding">
                        <RotateCcw size={11} /> Retry
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {active.length === 0 && failedJobs.length === 0 && !isLoading && (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <CheckCircle2 size={28} className="text-green-500" />
                <p className="font-medium text-sm">Queue is empty</p>
                <p className="text-xs text-muted-foreground">No active or failed transcoding jobs.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Workers Tab ──────────────────────────────────────────────────── */}
        <TabsContent value="workers" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Server size={15} />
                Active Worker Processes ({workers.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {workersLoading ? (
                <div className="space-y-3">{[1, 2].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
              ) : workers.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Server size={24} className="text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No workers registered</p>
                  <p className="text-xs text-muted-foreground">Workers register when the transcoder dispatcher starts.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {workers.map(w => {
                    const heartbeatAge = Date.now() - new Date(w.lastHeartbeatAt).getTime();
                    return (
                      <div key={w.workerId} className={`border rounded-lg p-3 ${w.isStale ? "border-red-200 bg-red-50/30 dark:border-red-900 dark:bg-red-900/10" : "border-border"}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${w.isStale ? "bg-red-500" : "bg-green-500"}`} />
                            <p className="text-sm font-medium">{w.hostname} <span className="text-muted-foreground text-xs">pid {w.pid}</span></p>
                          </div>
                          <Badge variant={w.isStale ? "destructive" : "secondary"}>
                            {w.isStale ? "Stale" : "Healthy"}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-muted-foreground">
                          <div>
                            <p className="font-medium text-foreground">{w.jobsCompleted}</p>
                            <p>Completed</p>
                          </div>
                          <div>
                            <p className={`font-medium ${w.jobsFailed > 0 ? "text-red-500" : "text-foreground"}`}>{w.jobsFailed}</p>
                            <p>Failed</p>
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{w.currentJobId ? w.currentJobId.slice(0, 8) + "…" : "–"}</p>
                            <p>Current Job</p>
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{w.currentStage ? (STAGE_LABELS[w.currentStage] ?? w.currentStage) : "–"}</p>
                            <p>Stage</p>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          Heartbeat {heartbeatAge < 5000 ? "just now" : formatDistanceToNow(new Date(w.lastHeartbeatAt), { addSuffix: true })}
                          {w.version && ` · v${w.version}`}
                          {` · started ${formatDistanceToNow(new Date(w.startedAt), { addSuffix: true })}`}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Dead Letter Queue Tab ─────────────────────────────────────────── */}
        <TabsContent value="dlq" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle size={15} className={dlqEntries.length > 0 ? "text-orange-500" : "text-muted-foreground"} />
                  Dead-Letter Queue ({dlqEntries.length} entries)
                </CardTitle>
                {isAdmin && dlqEntries.length > 0 && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-destructive hover:text-destructive" disabled={dlqBulkPurgeMutation.isPending}>
                        {dlqBulkPurgeMutation.isPending ? <><Loader2 size={11} className="animate-spin" /> Purging…</> : <><Trash2 size={11} /> Purge All</>}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Purge all {dlqEntries.length} DLQ entries?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Permanently removes all dead-letter entries that haven't been requeued. The underlying job records are not deleted. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => dlqBulkPurgeMutation.mutate()}>
                          Purge All
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {dlqLoading ? (
                <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
              ) : dlqEntries.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <CheckCircle2 size={24} className="text-green-500" />
                  <p className="text-sm font-medium">Dead-letter queue is empty</p>
                  <p className="text-xs text-muted-foreground">Jobs that exhaust their retry budget appear here for operator review.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {dlqEntries.map(entry => (
                    <div key={entry.id} className="border rounded-lg p-3 bg-orange-50/30 dark:bg-orange-900/10 border-orange-200 dark:border-orange-900">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium truncate">{entry.videoTitle || entry.videoId || "Unknown video"}</p>
                            {entry.errorCode && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-orange-300 text-orange-700 dark:text-orange-400">
                                {entry.errorCode}
                              </Badge>
                            )}
                          </div>
                          {entry.lastError && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{entry.lastError}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {entry.attempts} attempt{entry.attempts !== 1 ? "s" : ""} ·{" "}
                            Dead-lettered {formatDistanceToNow(new Date(entry.deadLetteredAt), { addSuffix: true })}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            size="sm" variant="outline"
                            className="h-7 text-xs gap-1"
                            onClick={() => dlqRequeueMutation.mutate(entry.id)}
                            disabled={dlqRequeueMutation.isPending}
                            title="Re-queue with fresh retry budget"
                          >
                            <RotateCcw size={11} /> Requeue
                          </Button>
                          {isAdmin && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" title="Purge permanently">
                                  <Trash2 size={12} />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Purge dead-letter entry?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This permanently removes the DLQ entry for "{entry.videoTitle || entry.jobId}". The job record itself is not deleted. This cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    onClick={() => dlqPurgeMutation.mutate(entry.id)}>
                                    Purge Entry
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── History Tab ──────────────────────────────────────────────────── */}
        <TabsContent value="history" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <History size={15} />
                Completed & Cancelled Jobs ({done.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : done.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No completed jobs yet.</p>
              ) : (
                <div className="space-y-1">
                  {done.slice(0, 50).map(job => {
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
                          <Button size="sm" variant="ghost"
                            className="h-6 text-[11px] gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                            onClick={() => setSelectedJobId(job.id)} title="View job event timeline">
                            <ListOrdered size={11} /> Timeline
                          </Button>
                          {job.status === "failed" && (
                            <Button size="sm" variant="outline"
                              className="h-6 text-xs gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => retryMutation.mutate(job.id)}
                              disabled={retryMutation.isPending}>
                              <RotateCcw size={11} /> Retry
                            </Button>
                          )}
                          <Badge variant={cfg.color as "outline" | "secondary" | "default" | "destructive"}>
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
        </TabsContent>
      </Tabs>
    </div>
    </>
  );
}
