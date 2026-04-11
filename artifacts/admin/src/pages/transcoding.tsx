import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
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
} from "lucide-react";

type JobStatus = "queued" | "processing" | "done" | "failed" | "cancelled";

interface TranscodingJob {
  id: string;
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  status: JobStatus;
  priority: number;
  progress: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface QueueData {
  jobs: TranscodingJob[];
  stats: {
    activeCount: number;
    queuedCount: number;
    failedCount: number;
    doneCount: number;
    total: number;
  };
}

function statusBadge(status: JobStatus) {
  switch (status) {
    case "processing":
      return (
        <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          Processing
        </Badge>
      );
    case "queued":
      return (
        <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 gap-1.5">
          <Clock className="w-3 h-3" />
          Queued
        </Badge>
      );
    case "done":
      return (
        <Badge className="bg-green-500/15 text-green-600 border-green-500/30 gap-1.5">
          <CheckCircle2 className="w-3 h-3" />
          Done
        </Badge>
      );
    case "failed":
      return (
        <Badge className="bg-red-500/15 text-red-600 border-red-500/30 gap-1.5">
          <XCircle className="w-3 h-3" />
          Failed
        </Badge>
      );
    case "cancelled":
      return (
        <Badge className="bg-muted text-muted-foreground border-border gap-1.5">
          <Ban className="w-3 h-3" />
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const seconds = Math.round((e - s) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${m}m ${rem}s`;
}

function formatRelative(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Transcoding() {
  const [data, setData] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/transcoding/queue");
      if (res.ok) {
        const json = await res.json() as QueueData;
        setData(json);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 3000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const handleRetry = async (jobId: string) => {
    setRetrying(jobId);
    try {
      const res = await fetch(`/api/admin/transcoding/retry/${jobId}`, { method: "POST" });
      if (res.ok) {
        toast({ title: "Job re-queued for processing" });
        await fetchQueue();
      } else {
        toast({ title: "Failed to retry job", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to retry job", variant: "destructive" });
    } finally {
      setRetrying(null);
    }
  };

  const handleCancel = async (jobId: string) => {
    setCancelling(jobId);
    try {
      const res = await fetch(`/api/admin/transcoding/${jobId}`, { method: "DELETE" });
      if (res.ok) {
        toast({ title: "Job cancelled" });
        await fetchQueue();
      } else {
        const err = await res.json() as { error?: string };
        toast({ title: err.error ?? "Failed to cancel job", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to cancel job", variant: "destructive" });
    } finally {
      setCancelling(null);
    }
  };

  const stats = data?.stats;
  const jobs = data?.jobs ?? [];

  const activeJobs = jobs.filter((j) => j.status === "processing");
  const queuedJobs = jobs.filter((j) => j.status === "queued");
  const completedJobs = jobs.filter((j) => j.status === "done" || j.status === "failed" || j.status === "cancelled");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Transcoding Queue</h1>
          <p className="text-muted-foreground mt-1">
            Monitor video encoding jobs across 1080p, 720p, and 480p quality variants.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchQueue}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Processing",
            value: stats?.activeCount ?? 0,
            icon: Cpu,
            color: "text-blue-600",
            bg: "bg-blue-500/10",
          },
          {
            label: "Queued",
            value: stats?.queuedCount ?? 0,
            icon: Clock,
            color: "text-amber-600",
            bg: "bg-amber-500/10",
          },
          {
            label: "Completed",
            value: stats?.doneCount ?? 0,
            icon: CheckCircle2,
            color: "text-green-600",
            bg: "bg-green-500/10",
          },
          {
            label: "Failed",
            value: stats?.failedCount ?? 0,
            icon: AlertCircle,
            color: "text-red-600",
            bg: "bg-red-500/10",
          },
        ].map((card) => (
          <div key={card.label} className="bg-card border rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg ${card.bg} flex items-center justify-center`}>
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

      <div className="space-y-4">
        {loading ? (
          <div className="bg-card border rounded-lg p-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="bg-card border rounded-lg p-12 flex flex-col items-center gap-3 text-center">
            <Film className="w-12 h-12 text-muted-foreground/40" />
            <div>
              <p className="font-medium">No transcoding jobs yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Upload a local video and it will automatically be queued for transcoding into HLS adaptive streaming format.
              </p>
            </div>
          </div>
        ) : (
          <>
            {activeJobs.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-blue-500" />
                  Active
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
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-500" />
                  Queued ({queuedJobs.length})
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
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
                  History ({completedJobs.length})
                </h2>
                <div className="space-y-2">
                  {completedJobs.map((job) => (
                    <JobRow key={job.id} job={job} onRetry={handleRetry} onCancel={handleCancel} retrying={retrying} cancelling={cancelling} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <div className="bg-muted/40 border rounded-lg p-4">
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Film className="w-4 h-4" />
          Adaptive Bitrate Streaming
        </h3>
        <p className="text-sm text-muted-foreground">
          Each uploaded video is transcoded into three HLS quality variants using FFmpeg. The mobile player automatically
          selects the best quality based on network conditions — 1080p (4 Mbps), 720p (2.5 Mbps), and 480p (1.2 Mbps).
          All variants use H.264 video with AAC audio and 6-second segments for low latency.
        </p>
      </div>
    </div>
  );
}

interface JobRowProps {
  job: TranscodingJob;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  retrying: string | null;
  cancelling: string | null;
}

function JobRow({ job, onRetry, onCancel, retrying, cancelling }: JobRowProps) {
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
            {statusBadge(job.status)}
            {job.priority > 0 && (
              <Badge variant="outline" className="text-xs gap-1">
                <Zap className="w-2.5 h-2.5" />
                P{job.priority}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
            <span>Queued {formatRelative(job.createdAt)}</span>
            {job.startedAt && (
              <span>Duration: {formatDuration(job.startedAt, job.completedAt)}</span>
            )}
            <span className="font-mono text-[10px] opacity-60">{job.id.slice(0, 8)}…</span>
          </div>

          {job.status === "processing" && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Encoding 1080p / 720p / 480p variants…</span>
                <span className="font-medium">{job.progress}%</span>
              </div>
              <Progress value={job.progress} className="h-1.5" />
            </div>
          )}

          {job.status === "done" && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-green-600">
              <CheckCircle2 className="w-3.5 h-3.5" />
              HLS master playlist ready — 1080p, 720p, 480p adaptive streaming enabled
            </div>
          )}

          {job.status === "failed" && job.errorMessage && (
            <div className="mt-1.5 flex items-start gap-1.5 text-xs text-red-600">
              <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="line-clamp-2">{job.errorMessage}</span>
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
              {retrying === job.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
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
              {cancelling === job.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
