import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
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
} from "lucide-react";
import { transcodingApi, type TranscodingJob, type TranscodingQueue } from "@/services/adminApi";
import { PageHeader } from "@/components/shared/page-header";
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
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtRelative(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
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
  retrying: string | null;
  cancelling: string | null;
}

function JobRow({ job, onRetry, onCancel, retrying, cancelling }: JobRowProps) {
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
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const { toast } = useToast();

  const loadQueue = useCallback(async () => {
    try {
      const res = await transcodingApi.getQueue();
      setData(res);
      setError(null);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to load transcoding queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
    const id = setInterval(loadQueue, 5000);
    return () => clearInterval(id);
  }, [loadQueue]);

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

  const handleClearHistory = async (status: string) => {
    setClearing(true);
    try {
      const token = (await import("@/lib/admin-access")).getAdminToken();
      const base = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/\/admin\/?$/, "");
      const res = await fetch(`${base}/api/admin/transcoding/clear?status=${status}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as { cleared?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Clear failed");
      toast({ title: `Cleared ${json.cleared ?? 0} job${json.cleared !== 1 ? "s" : ""}` });
      await loadQueue();
    } catch (err: unknown) {
      toast({ title: (err as Error)?.message ?? "Failed to clear history", variant: "destructive" });
    } finally {
      setClearing(false);
    }
  };

  const stats = data?.stats;
  const jobs = data?.jobs ?? [];
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
          title="Transcoding queue unavailable"
          message={error}
          onRetry={loadQueue}
        />
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Processing", value: stats?.activeCount ?? 0, icon: Cpu, color: "text-blue-600", bg: "bg-blue-500/10" },
          { label: "Queued", value: stats?.queuedCount ?? 0, icon: Clock, color: "text-amber-600", bg: "bg-amber-500/10" },
          { label: "Completed", value: (stats as any)?.doneCount ?? 0, icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-500/10" },
          { label: "Failed", value: (stats as any)?.failedCount ?? 0, icon: AlertCircle, color: "text-red-600", bg: "bg-red-500/10" },
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
                  <JobRow key={job.id} job={job} onRetry={handleRetry} onCancel={handleCancel} retrying={retrying} cancelling={cancelling} />
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
                  <JobRow key={job.id} job={job} onRetry={handleRetry} onCancel={handleCancel} retrying={retrying} cancelling={cancelling} />
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
                  <JobRow key={job.id} job={job} onRetry={handleRetry} onCancel={handleCancel} retrying={retrying} cancelling={cancelling} />
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
    </div>
  );
}
