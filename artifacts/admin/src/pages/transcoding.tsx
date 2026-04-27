import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Cpu,
  Clock,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Trash2,
  RefreshCw,
  Film,
  Loader2,
  AlertCircle,
  Zap,
  Activity,
  Ban,
  ChevronDown,
  Info,
} from "lucide-react";
import { AdminApiError, transcodingApi, type TranscodingJob, type TranscodingJobDetail, type TranscodingQueue } from "@/services/adminApi";
import { PageHeader } from "@/components/shared/page-header";
import { usePollingWhenVisible } from "@/hooks/usePollingWhenVisible";
import { ErrorAlert } from "@/components/shared/error-alert";

type JobStatus = TranscodingJob["status"];

function StatusBadge({ status }: { status: JobStatus }) {
  switch (status) {
    case "processing":
      return (
        <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Processing
        </Badge>
      );
    case "queued":
      return (
        <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 gap-1.5">
          <Clock className="w-3 h-3" /> Queued
        </Badge>
      );
    case "done":
      return (
        <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 gap-1.5">
          <CheckCircle2 className="w-3 h-3" /> Done
        </Badge>
      );
    case "failed":
      return (
        <Badge className="bg-red-500/15 text-red-600 border-red-500/30 gap-1.5">
          <XCircle className="w-3 h-3" /> Failed
        </Badge>
      );
    case "cancelled":
      return (
        <Badge className="bg-muted text-muted-foreground border-border gap-1.5">
          <Ban className="w-3 h-3" /> Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  if (Number.isNaN(s)) return "—";
  const eRaw = end ? new Date(end).getTime() : Date.now();
  const e = Number.isNaN(eRaw) ? Date.now() : eRaw;
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtRelative(date: string): string {
  if (!date) return "—";
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface JobRowProps {
  job: TranscodingJob;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onDetails: (id: string) => void;
  retrying: string | null;
  cancelling: string | null;
}

function JobRow({ job, onRetry, onCancel, onDetails, retrying, cancelling }: JobRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="flex items-start gap-4">
        {job.videoThumbnail ? (
          <img
            src={job.videoThumbnail}
            alt=""
            className="w-16 h-10 object-cover rounded shrink-0 bg-muted"
          />
        ) : (
          <div className="w-16 h-10 bg-muted rounded shrink-0 flex items-center justify-center">
            <Film className="w-4 h-4 text-muted-foreground" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{job.videoTitle}</span>
            <StatusBadge status={job.status} />
            {job.priority > 0 && (
              <Badge variant="outline" className="text-xs gap-1">
                <Zap className="w-2.5 h-2.5" /> P{job.priority}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
            <span>Queued {fmtRelative(job.createdAt)}</span>
            {job.startedAt && (
              <span>Duration: {fmtDuration(job.startedAt, job.completedAt)}</span>
            )}
            <span className="font-mono text-[10px] opacity-50">{job.id.slice(0, 8)}…</span>
          </div>

          {job.status === "processing" && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Encoding 1080p · 720p · 480p variants…</span>
                <span className="font-semibold">{job.progress}%</span>
              </div>
              <Progress value={job.progress} className="h-1.5" />
            </div>
          )}

          {job.status === "done" && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-600">
              <CheckCircle2 className="w-3.5 h-3.5" />
              HLS adaptive streaming ready — 1080p, 720p, 480p
            </div>
          )}

          {job.status === "failed" && job.errorMessage && (
            <div className="mt-1.5 text-xs text-red-600">
              <button
                className="flex items-start gap-1.5 hover:underline text-left w-full"
                onClick={() => setExpanded((v) => !v)}
              >
                <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className={expanded ? "" : "line-clamp-1"}>{job.errorMessage}</span>
              </button>
              {job.errorMessage.length > 80 && (
                <button onClick={() => setExpanded((v) => !v)} className="ml-5 text-red-400 hover:text-red-600">
                  {expanded ? "Show less" : "Show full error"}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            onClick={() => onDetails(job.id)}
            title="View job details"
          >
            <Info className="w-3.5 h-3.5" />
          </Button>
          {job.status === "failed" && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              disabled={retrying === job.id}
              onClick={() => onRetry(job.id)}
            >
              {retrying === job.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <RotateCcw className="w-3.5 h-3.5" />}
              Retry
            </Button>
          )}
          {job.status === "queued" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-muted-foreground"
              disabled={cancelling === job.id}
              onClick={() => onCancel(job.id)}
            >
              {cancelling === job.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2 className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Transcoding() {
  const [data, setData] = useState<TranscodingQueue | null>(null);
  const [loading, setLoading] = useState(true);
  // Round 4l: track transient flag separately so the page can render a softer
  // "reconnecting" indicator during the workflow-restart window instead of a
  // destructive red banner that overstates the severity. The 5s polling tick
  // will clear the error on the next successful fetch.
  const [error, setError] = useState<{ message: string; transient: boolean } | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailJob, setDetailJob] = useState<TranscodingJobDetail | null>(null);
  const { toast } = useToast();

  const handleDetails = useCallback(async (jobId: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetailJob(null);
    try {
      const job = await transcodingApi.getJob(jobId);
      setDetailJob(job);
    } catch (err: unknown) {
      setDetailError((err as Error)?.message ?? "Failed to load job details");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const res = await transcodingApi.getQueue();
      setData(res);
      setError(null);
    } catch (err: unknown) {
      const message = (err as Error)?.message ?? "Failed to load transcoding queue";
      const transient = err instanceof AdminApiError && err.transient === true;
      setError({ message, transient });
    } finally {
      setLoading(false);
    }
  }, []);

  // Visibility-aware polling — pauses when the operator switches tabs and
  // fires immediately on return. Cadence raised from 5s to 15s: an HLS
  // transcode job typically takes 30s–10min depending on source duration,
  // so a 5s refresh was 3–120x finer-grained than any real state change
  // could ever be. The Operations page already shows higher-level pipeline
  // health on a faster cadence; this page is for inspecting individual
  // jobs, where 15s is plenty.
  usePollingWhenVisible(loadQueue, 15_000);

  const handleRetry = async (jobId: string) => {
    setRetrying(jobId);
    try {
      await transcodingApi.retryJob(jobId);
      toast({ title: "Job re-queued for processing" });
      await loadQueue();
    } catch (err: unknown) {
      toast({ title: (err as Error)?.message ?? "Failed to retry job", variant: "destructive" });
    } finally {
      setRetrying(null);
    }
  };

  const handleCancel = async (jobId: string) => {
    setCancelling(jobId);
    try {
      await transcodingApi.cancelJob(jobId);
      toast({ title: "Job cancelled" });
      await loadQueue();
    } catch (err: unknown) {
      toast({ title: (err as Error)?.message ?? "Failed to cancel job", variant: "destructive" });
    } finally {
      setCancelling(null);
    }
  };

  const handleClearHistory = async (status: "done" | "failed" | "cancelled" | "all") => {
    setClearing(true);
    try {
      const res = await transcodingApi.clearHistory(status);
      toast({ title: `Cleared ${res.cleared ?? 0} job${res.cleared !== 1 ? "s" : ""}` });
      await loadQueue();
    } catch (err: unknown) {
      toast({ title: (err as Error)?.message ?? "Failed to clear history", variant: "destructive" });
    } finally {
      setClearing(false);
    }
  };

  const stats = data?.stats;
  // Defensive: only treat the response as a list when it really is one.
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const activeJobs = jobs.filter((j) => j.status === "processing");
  const queuedJobs = jobs.filter((j) => j.status === "queued");
  const completedJobs = jobs.filter((j) => j.status === "done" || j.status === "failed" || j.status === "cancelled");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transcoding Queue"
        description="Monitor video encoding jobs across 1080p, 720p, and 480p quality variants."
        actions={
          <div className="flex items-center gap-2">
            {completedJobs.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={clearing}>
                    {clearing
                      ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      : <Trash2 className="w-4 h-4 mr-2" />}
                    Clear History
                    <ChevronDown className="w-3.5 h-3.5 ml-1.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleClearHistory("done")}>
                    <CheckCircle2 className="w-4 h-4 mr-2 text-emerald-600" /> Clear completed
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleClearHistory("failed")}>
                    <XCircle className="w-4 h-4 mr-2 text-red-600" /> Clear failed
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleClearHistory("cancelled")}>
                    <Ban className="w-4 h-4 mr-2 text-muted-foreground" /> Clear cancelled
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleClearHistory("all")} className="text-destructive focus:text-destructive">
                    <Trash2 className="w-4 h-4 mr-2" /> Clear all history
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="outline" size="sm" onClick={loadQueue}>
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
          </div>
        }
      />

      {error && (
        <ErrorAlert
          title={error.transient ? undefined : "Transcoding queue unavailable"}
          message={error.transient ? undefined : error.message}
          onRetry={loadQueue}
          transient={error.transient}
        />
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Processing", value: stats?.activeCount ?? 0, icon: Cpu, color: "text-blue-600", bg: "bg-blue-500/10" },
          { label: "Queued", value: stats?.queuedCount ?? 0, icon: Clock, color: "text-amber-600", bg: "bg-amber-500/10" },
          { label: "Completed Today", value: stats?.completedToday ?? 0, icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-500/10" },
          { label: "Failed Today", value: stats?.failedToday ?? 0, icon: AlertCircle, color: "text-red-600", bg: "bg-red-500/10" },
        ].map((card) => (
          <div key={card.label} className="bg-card border rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg ${card.bg} flex items-center justify-center shrink-0`}>
                <card.icon className={`w-5 h-5 ${card.color}`} />
              </div>
              <div>
                <div className="text-2xl font-bold">{card.value}</div>
                <div className="text-xs text-muted-foreground">{card.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="bg-card border rounded-lg p-12 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 flex flex-col items-center gap-3 text-center">
          <Film className="w-12 h-12 text-muted-foreground/30" />
          <div>
            <p className="font-medium">No transcoding jobs</p>
            <p className="text-sm text-muted-foreground mt-1">
              Upload a local video file and it will be automatically queued for HLS transcoding.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {activeJobs.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-500" /> Active ({activeJobs.length})
              </h2>
              <div className="space-y-2">
                {activeJobs.map((job) => (
                  <JobRow key={job.id} job={job} onRetry={handleRetry} onCancel={handleCancel} onDetails={handleDetails} retrying={retrying} cancelling={cancelling} />
                ))}
              </div>
            </section>
          )}

          {queuedJobs.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-500" /> Queued ({queuedJobs.length})
              </h2>
              <div className="space-y-2">
                {queuedJobs.map((job) => (
                  <JobRow key={job.id} job={job} onRetry={handleRetry} onCancel={handleCancel} onDetails={handleDetails} retrying={retrying} cancelling={cancelling} />
                ))}
              </div>
            </section>
          )}

          {completedJobs.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-muted-foreground" /> History ({completedJobs.length})
              </h2>
              <div className="space-y-2">
                {completedJobs.map((job) => (
                  <JobRow key={job.id} job={job} onRetry={handleRetry} onCancel={handleCancel} onDetails={handleDetails} retrying={retrying} cancelling={cancelling} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="bg-muted/40 border rounded-lg p-4">
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Film className="w-4 h-4" /> Adaptive Bitrate Streaming
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Each uploaded video is transcoded into three HLS quality variants using FFmpeg. The player automatically
          selects the best quality based on network conditions — 1080p (4 Mbps), 720p (2.5 Mbps), and 480p (1.2 Mbps).
          All variants use H.264 video with AAC audio and 6-second segments for low-latency playback.
        </p>
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cpu className="w-4 h-4" /> Job Details
            </DialogTitle>
            <DialogDescription>
              Full transcoding job record including timestamps and any error output.
            </DialogDescription>
          </DialogHeader>

          {detailLoading && (
            <div className="py-8 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {detailError && !detailLoading && (
            <div className="py-4 text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{detailError}</span>
            </div>
          )}

          {detailJob && !detailLoading && (
            <div className="space-y-4 text-sm">
              <div className="flex items-start gap-3">
                {detailJob.videoThumbnail ? (
                  <img src={detailJob.videoThumbnail} alt="" className="w-20 h-12 object-cover rounded bg-muted shrink-0" />
                ) : (
                  <div className="w-20 h-12 bg-muted rounded flex items-center justify-center shrink-0">
                    <Film className="w-4 h-4 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{detailJob.videoTitle ?? "Untitled video"}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={detailJob.status} />
                    {detailJob.priority > 0 && (
                      <Badge variant="outline" className="text-xs gap-1">
                        <Zap className="w-2.5 h-2.5" /> P{detailJob.priority}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-muted/40 rounded p-2">
                  <div className="text-muted-foreground uppercase tracking-wider mb-0.5">Job ID</div>
                  <div className="font-mono break-all">{detailJob.id}</div>
                </div>
                <div className="bg-muted/40 rounded p-2">
                  <div className="text-muted-foreground uppercase tracking-wider mb-0.5">Video ID</div>
                  <div className="font-mono break-all">{detailJob.videoId}</div>
                </div>
                <div className="bg-muted/40 rounded p-2">
                  <div className="text-muted-foreground uppercase tracking-wider mb-0.5">Attempts</div>
                  <div className="font-semibold">{detailJob.attempts ?? 0}</div>
                </div>
                <div className="bg-muted/40 rounded p-2">
                  <div className="text-muted-foreground uppercase tracking-wider mb-0.5">Progress</div>
                  <div className="font-semibold">{detailJob.progress}%</div>
                </div>
                <div className="bg-muted/40 rounded p-2 col-span-2">
                  <div className="text-muted-foreground uppercase tracking-wider mb-0.5">Created</div>
                  <div>{new Date(detailJob.createdAt).toLocaleString()}</div>
                </div>
                {detailJob.startedAt && (
                  <div className="bg-muted/40 rounded p-2 col-span-2">
                    <div className="text-muted-foreground uppercase tracking-wider mb-0.5">Started</div>
                    <div>{new Date(detailJob.startedAt).toLocaleString()}</div>
                  </div>
                )}
                {detailJob.completedAt && (
                  <div className="bg-muted/40 rounded p-2 col-span-2">
                    <div className="text-muted-foreground uppercase tracking-wider mb-0.5">Completed</div>
                    <div>
                      {new Date(detailJob.completedAt).toLocaleString()}
                      {detailJob.startedAt && (
                        <span className="text-muted-foreground ml-2">
                          (took {fmtDuration(detailJob.startedAt, detailJob.completedAt)})
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {detailJob.errorMessage && (
                <div className="rounded border border-red-500/30 bg-red-500/5 p-3">
                  <div className="text-xs font-semibold text-red-600 uppercase tracking-wider mb-1 flex items-center gap-1">
                    <XCircle className="w-3.5 h-3.5" /> Error Output
                  </div>
                  <pre className="text-xs whitespace-pre-wrap break-words text-red-700 dark:text-red-400 font-mono max-h-48 overflow-auto">
{detailJob.errorMessage}
                  </pre>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            {detailJob?.status === "failed" && (
              <Button
                variant="outline"
                size="sm"
                disabled={retrying === detailJob.id}
                onClick={async () => {
                  await handleRetry(detailJob.id);
                  setDetailOpen(false);
                }}
              >
                {retrying === detailJob.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                ) : (
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                )}
                Retry job
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setDetailOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
