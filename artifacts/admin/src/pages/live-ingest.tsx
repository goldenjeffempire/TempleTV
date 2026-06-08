import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  Wifi, Plus, Pencil, Trash2, RefreshCw, Activity,
  Copy, Eye, EyeOff, Star, RotateCcw, Loader2, AlertCircle,
} from "lucide-react";

type Protocol = "rtmp" | "rtmps" | "srt" | "hls" | "whip";
type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

interface Endpoint {
  id: string;
  name: string;
  protocol: Protocol;
  ingestUrl: string;
  streamKey: string;
  hlsPlaybackUrl: string;
  fallbackYoutubeUrl: string | null;
  isPrimary: boolean;
  isActive: boolean;
  priority: number;
  notes: string | null;
  healthStatus: HealthStatus;
  lastHealthAt: string | null;
  lastHealthyAt: string | null;
  consecutiveFailures: number;
  lastBitrateKbps: number | null;
  lastSegmentLatencyMs: number | null;
  droppedFramesPct: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  endpoints: Endpoint[];
  summary: {
    total: number;
    active: number;
    primary: string | null;
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}

const PROTOCOLS: Protocol[] = ["rtmp", "rtmps", "srt", "hls", "whip"];

const BLANK_FORM = {
  name: "",
  protocol: "rtmp" as Protocol,
  ingestUrl: "",
  streamKey: "",
  hlsPlaybackUrl: "",
  fallbackYoutubeUrl: "",
  isPrimary: false,
  isActive: true,
  priority: 100,
  notes: "",
};

function healthBadge(status: HealthStatus) {
  const cfg = {
    healthy:   { label: "Healthy",   cls: "bg-green-500/15 text-green-700 border-green-500/30" },
    degraded:  { label: "Degraded",  cls: "bg-amber-500/15 text-amber-700 border-amber-500/30" },
    unhealthy: { label: "Unhealthy", cls: "bg-red-500/15 text-red-700 border-red-500/30" },
    unknown:   { label: "Unknown",   cls: "bg-muted text-muted-foreground" },
  }[status];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium rounded border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the timer on unmount so setState never fires on an unmounted component.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Copy size={12} className={copied ? "text-green-600" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied!" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}

export default function LiveIngestPage() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen]        = useState(false);
  const [editEndpoint, setEditEndpoint] = useState<Endpoint | null>(null);
  const [deleteId, setDeleteId]      = useState<string | null>(null);
  const [probingId, setProbingId]    = useState<string | null>(null);
  const [revealKey, setRevealKey]    = useState<string | null>(null);
  const [form, setForm]              = useState(BLANK_FORM);

  const { data, isLoading, error, refetch } = useQuery<ListResponse>({
    queryKey: ["live-ingest-endpoints"],
    queryFn:  () => api.get<ListResponse>("/admin/live-ingest/endpoints"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof BLANK_FORM) =>
      api.post<Endpoint>("/admin/live-ingest/endpoints", {
        ...body,
        fallbackYoutubeUrl: body.fallbackYoutubeUrl.trim() || null,
        streamKey:          body.streamKey.trim() || undefined,
        notes:              body.notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Ingest endpoint created");
      void qc.invalidateQueries({ queryKey: ["live-ingest-endpoints"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setAddOpen(false);
      setForm(BLANK_FORM);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to create endpoint"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<typeof BLANK_FORM> }) =>
      api.patch<Endpoint>(`/admin/live-ingest/endpoints/${id}`, {
        ...patch,
        fallbackYoutubeUrl: patch.fallbackYoutubeUrl !== undefined ? (patch.fallbackYoutubeUrl.trim() || null) : undefined,
        notes: patch.notes !== undefined ? (patch.notes.trim() || null) : undefined,
      }),
    onSuccess: () => {
      toast.success("Endpoint updated");
      void qc.invalidateQueries({ queryKey: ["live-ingest-endpoints"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setEditEndpoint(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/live-ingest/endpoints/${id}`),
    onSuccess: () => {
      toast.success("Endpoint removed");
      void qc.invalidateQueries({ queryKey: ["live-ingest-endpoints"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setDeleteId(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to delete"),
  });

  const promoteMutation = useMutation({
    mutationFn: (id: string) => api.post<Endpoint>(`/admin/live-ingest/endpoints/${id}/promote`),
    onSuccess: (ep) => {
      toast.success(`"${ep.name}" is now the primary ingest`);
      void qc.invalidateQueries({ queryKey: ["live-ingest-endpoints"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Promotion failed"),
  });

  const rotateKeyMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ streamKey: string; endpoint: Endpoint }>(`/admin/live-ingest/endpoints/${id}/rotate-key`),
    onSuccess: () => {
      toast.success("Stream key rotated — update your encoder");
      void qc.invalidateQueries({ queryKey: ["live-ingest-endpoints"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Key rotation failed"),
  });

  async function handleProbe(ep: Endpoint) {
    setProbingId(ep.id);
    try {
      const res = await api.post<{ status: HealthStatus; latencyMs: number | null; error: string | null }>(
        `/admin/live-ingest/endpoints/${ep.id}/probe`
      );
      void qc.invalidateQueries({ queryKey: ["live-ingest-endpoints"] });
      if (res.status === "healthy") {
        toast.success(`${ep.name}: healthy${res.latencyMs != null ? ` (${res.latencyMs} ms)` : ""}`);
      } else {
        toast.error(`${ep.name}: ${res.status}${res.error ? ` — ${res.error}` : ""}`);
      }
    } catch (e) {
      toast.error(e instanceof HttpError ? e.message : "Probe failed");
    } finally {
      setProbingId(null);
    }
  }

  function openEdit(ep: Endpoint) {
    setEditEndpoint(ep);
    setForm({
      name:               ep.name,
      protocol:           ep.protocol,
      ingestUrl:          ep.ingestUrl,
      streamKey:          ep.streamKey,
      hlsPlaybackUrl:     ep.hlsPlaybackUrl,
      fallbackYoutubeUrl: ep.fallbackYoutubeUrl ?? "",
      isPrimary:          ep.isPrimary,
      isActive:           ep.isActive,
      priority:           ep.priority,
      notes:              ep.notes ?? "",
    });
  }

  const endpoints = data?.endpoints ?? [];
  const summary   = data?.summary;

  return (
    <TooltipProvider>
      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Live Ingest"
          description="RTMP/RTMPS/SRT/HLS encoder configurations and health monitoring."
          actions={
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
                <RefreshCw size={13} /> Refresh
              </Button>
              <Button size="sm" onClick={() => { setForm(BLANK_FORM); setAddOpen(true); }} className="gap-1.5">
                <Plus size={14} /> Add Endpoint
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

        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total",     value: summary.total,     cls: "" },
              { label: "Active",    value: summary.active,    cls: "text-blue-600" },
              { label: "Healthy",   value: summary.healthy,   cls: "text-green-600" },
              { label: "Unhealthy", value: summary.unhealthy, cls: "text-red-600" },
            ].map(({ label, value, cls }) => (
              <Card key={label}>
                <CardContent className="py-3 px-4">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-2xl font-bold ${cls}`}>{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">{[1,2].map(i => <Skeleton key={i} className="h-36 rounded-xl" />)}</div>
        ) : endpoints.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <Wifi size={40} className="text-muted-foreground/20" />
            <p className="font-semibold text-lg">No ingest endpoints configured</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Add your encoder's RTMP/SRT endpoint to start receiving a live signal.
            </p>
            <Button size="sm" onClick={() => { setForm(BLANK_FORM); setAddOpen(true); }} className="gap-1.5 mt-1">
              <Plus size={13} /> Add endpoint
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {endpoints.map((ep) => (
              <Card key={ep.id} className={ep.isPrimary ? "border-primary/40" : ""}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {ep.isPrimary && <Star size={13} className="text-amber-500 shrink-0" fill="currentColor" />}
                      <CardTitle className="text-base truncate">{ep.name}</CardTitle>
                      <Badge variant="outline" className="text-[10px] uppercase shrink-0">{ep.protocol}</Badge>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {healthBadge(ep.healthStatus)}
                      {!ep.isActive && (
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium rounded border bg-muted text-muted-foreground">
                          Inactive
                        </span>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-3 pt-0">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Ingest URL</p>
                      <div className="flex items-center gap-1">
                        <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">{ep.ingestUrl}</code>
                        <CopyButton value={ep.ingestUrl} label="ingest URL" />
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Stream Key</p>
                      <div className="flex items-center gap-1">
                        <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate font-mono">
                          {revealKey === ep.id ? ep.streamKey : "••••••••••••••••"}
                        </code>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button aria-label={revealKey === ep.id ? "Hide stream key" : "Reveal stream key"} variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRevealKey(r => r === ep.id ? null : ep.id)}>
                              {revealKey === ep.id ? <EyeOff size={12} /> : <Eye size={12} />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{revealKey === ep.id ? "Hide key" : "Reveal key"}</TooltipContent>
                        </Tooltip>
                        <CopyButton value={ep.streamKey} label="stream key" />
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">HLS Playback</p>
                      <div className="flex items-center gap-1">
                        <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">{ep.hlsPlaybackUrl}</code>
                        <CopyButton value={ep.hlsPlaybackUrl} label="HLS URL" />
                      </div>
                    </div>
                    {ep.lastHealthAt && (
                      <div>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Last Probed</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(ep.lastHealthAt).toLocaleString()}
                          {ep.lastSegmentLatencyMs != null && ` · ${ep.lastSegmentLatencyMs} ms`}
                          {ep.consecutiveFailures > 0 && (
                            <span className="text-red-500 ml-1">· {ep.consecutiveFailures} failure{ep.consecutiveFailures !== 1 ? "s" : ""}</span>
                          )}
                        </p>
                      </div>
                    )}
                  </div>

                  {ep.lastError && (
                    <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                      <AlertCircle size={12} className="shrink-0 mt-0.5" />
                      <span className="break-all">{ep.lastError}</span>
                    </div>
                  )}

                  <Separator />

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 h-8 text-xs"
                      disabled={probingId === ep.id}
                      onClick={() => void handleProbe(ep)}
                    >
                      {probingId === ep.id
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Activity size={11} />}
                      Probe Health
                    </Button>

                    {!ep.isPrimary && ep.isActive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 h-8 text-xs"
                        disabled={promoteMutation.isPending}
                        onClick={() => promoteMutation.mutate(ep.id)}
                      >
                        <Star size={11} /> Set Primary
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 h-8 text-xs"
                      disabled={rotateKeyMutation.isPending}
                      onClick={() => rotateKeyMutation.mutate(ep.id)}
                    >
                      <RotateCcw size={11} /> Rotate Key
                    </Button>

                    <div className="flex-1" />

                    <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" onClick={() => openEdit(ep)}>
                      <Pencil size={11} /> Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 h-8 text-xs text-red-500 hover:text-red-600 hover:border-red-200"
                      onClick={() => setDeleteId(ep.id)}
                    >
                      <Trash2 size={11} /> Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <EndpointDialog
          open={addOpen}
          title="Add Ingest Endpoint"
          form={form}
          setForm={setForm}
          isPending={createMutation.isPending}
          onSubmit={() => createMutation.mutate(form)}
          onClose={() => { setAddOpen(false); setForm(BLANK_FORM); }}
        />

        <EndpointDialog
          open={editEndpoint !== null}
          title="Edit Ingest Endpoint"
          form={form}
          setForm={setForm}
          isPending={updateMutation.isPending}
          isEdit
          onSubmit={() => { if (editEndpoint) updateMutation.mutate({ id: editEndpoint.id, patch: form }); }}
          onClose={() => setEditEndpoint(null)}
        />

        <AlertDialog open={deleteId !== null} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete ingest endpoint?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently remove the endpoint configuration. The encoder will no longer be recognised.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => { if (deleteId) deleteMutation.mutate(deleteId); }}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

function EndpointDialog({
  open, title, form, setForm, isPending, isEdit = false, onSubmit, onClose,
}: {
  open: boolean;
  title: string;
  form: typeof BLANK_FORM;
  setForm: React.Dispatch<React.SetStateAction<typeof BLANK_FORM>>;
  isPending: boolean;
  isEdit?: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const canSubmit = form.name.trim().length > 0
    && form.ingestUrl.trim().length > 0
    && form.hlsPlaybackUrl.trim().length > 0
    && !isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Configure encoder endpoint details</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label>Endpoint Name *</Label>
              <Input
                placeholder="Primary OBS Stream"
                value={form.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Protocol *</Label>
              <Select value={form.protocol} onValueChange={(v) => setForm(f => ({ ...f, protocol: v as Protocol }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROTOCOLS.map(p => <SelectItem key={p} value={p}>{p.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Input
                type="number"
                min={0}
                max={10000}
                value={form.priority}
                onChange={(e) => setForm(f => ({ ...f, priority: Number(e.target.value) }))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Ingest URL *</Label>
            <Input
              placeholder="rtmp://live.example.com/app"
              value={form.ingestUrl}
              onChange={(e) => setForm(f => ({ ...f, ingestUrl: e.target.value }))}
            />
          </div>

          {!isEdit && (
            <div className="space-y-1.5">
              <Label>Stream Key <span className="text-muted-foreground text-xs">(leave blank to auto-generate)</span></Label>
              <Input
                placeholder="Auto-generated if empty"
                value={form.streamKey}
                onChange={(e) => setForm(f => ({ ...f, streamKey: e.target.value }))}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>HLS Playback URL *</Label>
            <Input
              placeholder="https://cdn.example.com/live/master.m3u8"
              value={form.hlsPlaybackUrl}
              onChange={(e) => setForm(f => ({ ...f, hlsPlaybackUrl: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">The URL players use to watch this stream. Health probes check this URL.</p>
          </div>

          <div className="space-y-1.5">
            <Label>YouTube Fallback URL <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              placeholder="https://youtube.com/watch?v=..."
              value={form.fallbackYoutubeUrl}
              onChange={(e) => setForm(f => ({ ...f, fallbackYoutubeUrl: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea
              placeholder="OBS settings, encoder model, notes…"
              value={form.notes}
              onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">Enable this endpoint</p>
              </div>
              <Switch checked={form.isActive} onCheckedChange={(v) => setForm(f => ({ ...f, isActive: v }))} />
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Primary</p>
                <p className="text-xs text-muted-foreground">Default ingest source</p>
              </div>
              <Switch checked={form.isPrimary} onCheckedChange={(v) => setForm(f => ({ ...f, isPrimary: v }))} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
