import { useCallback, useEffect, useState } from "react";
import {
  Radio,
  Plus,
  RefreshCw,
  Trash2,
  KeyRound,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Activity,
  Copy,
  Power,
  Zap,
  Loader2,
  Eye,
  EyeOff,
} from "lucide-react";
import { LivePreviewPlayer } from "@/components/live-ingest/LivePreviewPlayer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import {
  AdminApiError,
  liveIngestApi,
  type LiveIngestEndpoint,
  type LiveIngestEndpointInput,
  type LiveIngestEndpointList,
  type LiveIngestProtocol,
} from "@/services/adminApi";
import { useSSEEvent } from "@/contexts/SSEContext";

const PROTOCOLS: LiveIngestProtocol[] = ["rtmp", "rtmps", "srt", "hls", "whip"];

function HealthBadge({ status }: { status: string }) {
  if (status === "healthy") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 gap-1.5">
        <CheckCircle2 className="w-3 h-3" /> Healthy
      </Badge>
    );
  }
  if (status === "degraded") {
    return (
      <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 gap-1.5">
        <Activity className="w-3 h-3" /> Degraded
      </Badge>
    );
  }
  if (status === "unhealthy") {
    return (
      <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30 gap-1.5">
        <AlertTriangle className="w-3 h-3" /> Unhealthy
      </Badge>
    );
  }
  return (
    <Badge className="bg-muted text-muted-foreground border-border gap-1.5">
      <Activity className="w-3 h-3" /> Unknown
    </Badge>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { toast } = useToast();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast({ title: `${label} copied`, description: "Pasted into your clipboard." });
        } catch {
          toast({ title: "Copy failed", description: "Clipboard access denied.", variant: "destructive" });
        }
      }}
    >
      <Copy className="w-3 h-3" /> Copy
    </Button>
  );
}

export default function LiveIngest() {
  const { toast } = useToast();
  const [data, setData] = useState<LiveIngestEndpointList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const result = await liveIngestApi.list(signal);
      setData(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof AdminApiError || err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const interval = setInterval(() => load(), 20_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [load]);

  // Real-time updates from the health monitor SSE stream
  useSSEEvent("live-ingest-health", () => { load(); });
  useSSEEvent("live-ingest-promoted", () => { load(); });
  useSSEEvent("live-ingest-stopped", () => { load(); });
  useSSEEvent("live-ingest-failover", (payload: unknown) => {
    load();
    const data = payload as { reason?: string } | null;
    toast({
      title: "Auto-failover triggered",
      description: data?.reason ?? "Stream switched to a healthy fallback.",
      variant: "destructive",
    });
  });
  useSSEEvent("live-ingest-recovered", (payload: unknown) => {
    load();
    const data = payload as { reason?: string } | null;
    toast({
      title: "Auto-recovery — preferred source restored",
      description: data?.reason ?? "Stream switched back to the preferred source.",
    });
  });

  const onCreate = async (input: LiveIngestEndpointInput) => {
    setCreating(true);
    try {
      await liveIngestApi.create(input);
      toast({ title: "Endpoint created", description: `${input.name} added to your ingest pool.` });
      setCreateOpen(false);
      load();
    } catch (err) {
      toast({
        title: "Failed to create endpoint",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const onPromote = async (endpoint: LiveIngestEndpoint) => {
    setActionId(endpoint.id);
    try {
      await liveIngestApi.promote(endpoint.id);
      toast({
        title: "Now broadcasting",
        description: `${endpoint.name} is live across every platform.`,
      });
      load();
    } catch (err) {
      toast({
        title: "Promotion failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setActionId(null);
    }
  };

  const onStop = async () => {
    if (!confirm("Take all live ingest endpoints off-air? The 24/7 broadcast queue will resume immediately.")) return;
    try {
      await liveIngestApi.stop();
      toast({ title: "Live broadcast stopped", description: "Broadcast queue resumed." });
      load();
    } catch (err) {
      toast({
        title: "Stop failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  };

  const onProbe = async (endpoint: LiveIngestEndpoint) => {
    setActionId(endpoint.id);
    try {
      const result = await liveIngestApi.probe(endpoint.id);
      toast({
        title: result.ok ? "Stream healthy" : "Stream unhealthy",
        description: result.ok
          ? `${result.bitrateKbps ?? "?"} kbps · ${result.latencyMs}ms manifest fetch`
          : (result.error ?? "Unknown error"),
        variant: result.ok ? undefined : "destructive",
      });
      load();
    } catch (err) {
      toast({
        title: "Probe failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setActionId(null);
    }
  };

  const onRotateKey = async (endpoint: LiveIngestEndpoint) => {
    if (!confirm(`Rotate stream key for "${endpoint.name}"? The current encoder session will stop receiving frames.`)) return;
    setActionId(endpoint.id);
    try {
      await liveIngestApi.rotateKey(endpoint.id);
      toast({ title: "Stream key rotated", description: "Update your encoder with the new key." });
      load();
    } catch (err) {
      toast({
        title: "Rotation failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setActionId(null);
    }
  };

  const onDelete = async (endpoint: LiveIngestEndpoint) => {
    if (!confirm(`Delete endpoint "${endpoint.name}"? This cannot be undone.`)) return;
    setActionId(endpoint.id);
    try {
      await liveIngestApi.remove(endpoint.id);
      toast({ title: "Endpoint deleted" });
      load();
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setActionId(null);
    }
  };

  const summary = data?.summary;

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <PageHeader
        title="Broadcast Operations Center"
        description="Manage live ingest endpoints, monitor stream health, and orchestrate fail-safe automatic failover."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={onStop} className="gap-1.5">
              <Power className="w-4 h-4" /> Take Off-Air
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="w-4 h-4" /> New Ingest Endpoint
            </Button>
          </div>
        }
      />

      {error && <ErrorAlert message={error} />}

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <SummaryTile label="Total" value={summary.total} />
          <SummaryTile label="Active" value={summary.active} />
          <SummaryTile label="Healthy" value={summary.healthy} tone="emerald" />
          <SummaryTile label="Degraded" value={summary.degraded} tone="amber" />
          <SummaryTile label="Unhealthy" value={summary.unhealthy} tone="red" />
        </div>
      )}

      {!loading && data?.endpoints.length === 0 && (
        <div className="border border-dashed rounded-lg p-12 text-center bg-card">
          <Radio className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold">No ingest endpoints configured</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            Create your first endpoint to start broadcasting from vMix, OBS, Wirecast, or any RTMP/SRT-capable encoder.
          </p>
          <Button className="mt-4 gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" /> Create First Endpoint
          </Button>
        </div>
      )}

      <div className="space-y-3">
        {data?.endpoints.map((endpoint) => (
          <EndpointCard
            key={endpoint.id}
            endpoint={endpoint}
            busy={actionId === endpoint.id}
            onPromote={() => onPromote(endpoint)}
            onProbe={() => onProbe(endpoint)}
            onRotateKey={() => onRotateKey(endpoint)}
            onDelete={() => onDelete(endpoint)}
          />
        ))}
      </div>

      <CreateEndpointDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={onCreate}
        submitting={creating}
      />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber" | "red";
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "red"
          ? "text-red-600 dark:text-red-400"
          : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${toneClass}`}>{value}</div>
    </div>
  );
}

function EndpointCard({
  endpoint,
  busy,
  onPromote,
  onProbe,
  onRotateKey,
  onDelete,
}: {
  endpoint: LiveIngestEndpoint;
  busy: boolean;
  onPromote: () => void;
  onProbe: () => void;
  onRotateKey: () => void;
  onDelete: () => void;
}) {
  const [previewOn, setPreviewOn] = useState(false);
  return (
    <div
      className={`rounded-lg border bg-card p-5 transition-shadow ${
        endpoint.isPrimary ? "ring-2 ring-red-500/40 shadow-lg" : ""
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {endpoint.isPrimary && (
              <Badge className="bg-red-500 text-white border-red-500 gap-1.5 px-2 py-0.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                </span>
                ON AIR
              </Badge>
            )}
            <h3 className="font-semibold text-lg truncate">{endpoint.name}</h3>
            <Badge variant="outline" className="uppercase text-[10px] tracking-wider">
              {endpoint.protocol}
            </Badge>
            <HealthBadge status={endpoint.healthStatus} />
            {!endpoint.isActive && (
              <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>
            )}
          </div>
          {endpoint.notes && (
            <p className="text-sm text-muted-foreground mt-1.5">{endpoint.notes}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {!endpoint.isPrimary && (
            <Button
              size="sm"
              onClick={onPromote}
              disabled={busy}
              className="gap-1.5 bg-red-500 hover:bg-red-600 text-white border-0"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Go Live
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPreviewOn((v) => !v)}
            className="gap-1.5"
          >
            {previewOn ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {previewOn ? "Hide Preview" : "Preview"}
          </Button>
          <Button size="sm" variant="outline" onClick={onProbe} disabled={busy} className="gap-1.5">
            <Activity className="w-3.5 h-3.5" /> Probe
          </Button>
          <Button size="sm" variant="outline" onClick={onRotateKey} disabled={busy} className="gap-1.5">
            <KeyRound className="w-3.5 h-3.5" /> Rotate Key
          </Button>
          <Button size="sm" variant="outline" onClick={onDelete} disabled={busy} className="gap-1.5 text-red-600">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Live preview — only mounts the player when the operator clicks
          "Preview" to keep network footprint minimal on a dashboard with
          many endpoints. */}
      <div className="mt-4">
        <LivePreviewPlayer hlsUrl={endpoint.hlsPlaybackUrl} enabled={previewOn} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        <FieldRow label="Ingest URL (encoder side)" value={endpoint.ingestUrl} />
        <FieldRow label="Stream Key" value={endpoint.streamKey} secret />
        <FieldRow label="HLS Playback URL" value={endpoint.hlsPlaybackUrl} />
        <FieldRow
          label="YouTube Fallback"
          value={endpoint.fallbackYoutubeUrl ?? "— not set —"}
          muted={!endpoint.fallbackYoutubeUrl}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 text-xs">
        <Stat label="Bitrate" value={endpoint.lastBitrateKbps ? `${Math.round(endpoint.lastBitrateKbps).toLocaleString()} kbps` : "—"} />
        <Stat label="Segment latency" value={endpoint.lastSegmentLatencyMs ? `${endpoint.lastSegmentLatencyMs}ms` : "—"} />
        <Stat label="Dropped frames" value={endpoint.droppedFramesPct != null ? `${endpoint.droppedFramesPct.toFixed(2)}%` : "—"} />
        <Stat label="Last check" value={timeAgo(endpoint.lastHealthAt)} />
        <Stat label="Last healthy" value={timeAgo(endpoint.lastHealthyAt)} />
      </div>

      {endpoint.lastError && endpoint.healthStatus !== "healthy" && (
        <div className="mt-3 rounded-md bg-red-500/10 border border-red-500/20 p-2.5 text-xs text-red-600 dark:text-red-400">
          <strong>Last error:</strong> {endpoint.lastError}
          {endpoint.consecutiveFailures > 0 && (
            <span className="ml-2 text-red-500/70">({endpoint.consecutiveFailures} consecutive failures)</span>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  value,
  secret,
  muted,
}: {
  label: string;
  value: string;
  secret?: boolean;
  muted?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const display = secret && !revealed ? "•".repeat(Math.min(value.length, 32)) : value;
  return (
    <div className="rounded-md border bg-muted/40 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        {label}
      </div>
      <div className="flex items-center justify-between gap-2 mt-0.5">
        <code className={`text-xs truncate font-mono ${muted ? "text-muted-foreground italic" : ""}`}>
          {display}
        </code>
        <div className="flex items-center gap-1 shrink-0">
          {secret && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? "Hide" : "Show"}
            </Button>
          )}
          {!muted && <CopyButton value={value} label={label} />}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-medium">{value}</div>
    </div>
  );
}

function CreateEndpointDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: LiveIngestEndpointInput) => void;
  submitting: boolean;
}) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<LiveIngestProtocol>("rtmps");
  const [ingestUrl, setIngestUrl] = useState("");
  const [hlsPlaybackUrl, setHlsPlaybackUrl] = useState("");
  const [fallbackYoutubeUrl, setFallbackYoutubeUrl] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setProtocol("rtmps");
      setIngestUrl("");
      setHlsPlaybackUrl("");
      setFallbackYoutubeUrl("");
      setNotes("");
    }
  }, [open]);

  const valid = name.trim() && ingestUrl.trim() && hlsPlaybackUrl.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New Ingest Endpoint</DialogTitle>
          <DialogDescription>
            Configure a vMix / OBS / Wirecast / Cloudflare Stream / Mux input. A secure stream key is generated automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="ingest-name">Name</Label>
            <Input
              id="ingest-name"
              placeholder="e.g. Sanctuary vMix · Backup studio · Mux primary"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ingest-protocol">Protocol</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as LiveIngestProtocol)}>
                <SelectTrigger id="ingest-protocol"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROTOCOLS.map((p) => (
                    <SelectItem key={p} value={p}>{p.toUpperCase()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="ingest-url">Ingest URL (push to this from encoder)</Label>
              <Input
                id="ingest-url"
                placeholder="rtmps://global-live.mux.com:443/app"
                value={ingestUrl}
                onChange={(e) => setIngestUrl(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="hls-url">HLS Playback URL (clients pull this)</Label>
            <Input
              id="hls-url"
              placeholder="https://stream.mux.com/abc123.m3u8"
              value={hlsPlaybackUrl}
              onChange={(e) => setHlsPlaybackUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              The health monitor probes this URL every 15 seconds.
            </p>
          </div>
          <div>
            <Label htmlFor="yt-fallback">YouTube Live Fallback URL <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              id="yt-fallback"
              placeholder="https://www.youtube.com/watch?v=…"
              value={fallbackYoutubeUrl}
              onChange={(e) => setFallbackYoutubeUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used automatically when every primary endpoint fails.
            </p>
          </div>
          <div>
            <Label htmlFor="notes">Notes <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="notes"
              placeholder="Operator notes — encoder, location, contact…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit({ name: name.trim(), protocol, ingestUrl: ingestUrl.trim(), hlsPlaybackUrl: hlsPlaybackUrl.trim(), fallbackYoutubeUrl: fallbackYoutubeUrl.trim() || undefined, notes: notes.trim() || undefined })}
            disabled={!valid || submitting}
            className="gap-1.5"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            Create Endpoint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
