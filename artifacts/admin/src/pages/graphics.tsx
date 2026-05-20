import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Layers, Plus, Trash2, RefreshCw, Monitor, Type, Bug, Tv2, X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const CHANNEL_ID = "temple-tv-live";

type GraphicType = "ticker" | "lower_third" | "bug_text";

interface ActiveGraphic {
  id: string;
  channelId: string;
  type: string;
  content: string;
  subContent: string | null;
  durationSecs: number | null;
  activatedAt: string | null;
}

const TYPE_CONFIG: Record<GraphicType, { label: string; icon: React.ReactNode; desc: string; hasSubContent: boolean }> = {
  ticker:      { label: "Ticker",      icon: <Type size={14} />,    desc: "Scrolling text strip along the bottom of the screen.",    hasSubContent: false },
  lower_third: { label: "Lower Third", icon: <Monitor size={14} />, desc: "Name/title overlay in the lower third of the frame.",      hasSubContent: true  },
  bug_text:    { label: "Bug / Text",  icon: <Bug size={14} />,     desc: "Persistent corner bug text (e.g., channel tag, hashtag).", hasSubContent: false },
};

function TypeBadge({ type }: { type: string }) {
  const cfg = TYPE_CONFIG[type as GraphicType];
  return (
    <Badge variant="outline" className="gap-1 text-[11px] capitalize font-medium">
      {cfg?.icon}
      {cfg?.label ?? type}
    </Badge>
  );
}

interface GraphicFormState {
  type: GraphicType;
  content: string;
  subContent: string;
  durationSecs: string;
}

const DEFAULT_FORM: GraphicFormState = {
  type: "lower_third",
  content: "",
  subContent: "",
  durationSecs: "",
};

export default function GraphicsPage() {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<GraphicFormState>(DEFAULT_FORM);
  const [clearConfirm, setClearConfirm] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["graphics-active", CHANNEL_ID],
    queryFn: () => api.get<ActiveGraphic[]>(`/graphics?channelId=${CHANNEL_ID}`),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const activateMutation = useMutation({
    mutationFn: (body: {
      channelId: string;
      type: GraphicType;
      content: string;
      subContent?: string | null;
      durationSecs?: number | null;
    }) => api.post("/admin/graphics", body),
    onSuccess: () => {
      toast.success("Graphic activated on air");
      void qc.invalidateQueries({ queryKey: ["graphics-active"] });
      setDialogOpen(false);
      setForm(DEFAULT_FORM);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to activate graphic"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/graphics/${id}`),
    onSuccess: () => {
      toast.success("Graphic removed");
      void qc.invalidateQueries({ queryKey: ["graphics-active"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to remove graphic"),
  });

  const clearAllMutation = useMutation({
    mutationFn: () => api.delete(`/admin/graphics/channel/${CHANNEL_ID}`),
    onSuccess: () => {
      toast.success("All graphics cleared");
      void qc.invalidateQueries({ queryKey: ["graphics-active"] });
      setClearConfirm(false);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to clear graphics"),
  });

  const activeGraphics = data ?? [];
  const typeCfg = TYPE_CONFIG[form.type];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.content.trim()) {
      toast.error("Content is required");
      return;
    }
    const durationSecs = form.durationSecs.trim() ? Number(form.durationSecs) : null;
    activateMutation.mutate({
      channelId: CHANNEL_ID,
      type: form.type,
      content: form.content.trim(),
      subContent: typeCfg.hasSubContent && form.subContent.trim() ? form.subContent.trim() : null,
      durationSecs,
    });
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Graphics"
        description="Manage lower-thirds, tickers, and on-screen bug text for live broadcasts."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
              <RefreshCw size={13} /> Refresh
            </Button>
            {activeGraphics.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50 dark:hover:bg-red-950/20"
                onClick={() => setClearConfirm(true)}
                disabled={clearAllMutation.isPending}
              >
                <X size={13} /> Clear All
              </Button>
            )}
            <Button size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
              <Plus size={13} /> Activate Graphic
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

      {/* Graphic-type reference cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(Object.entries(TYPE_CONFIG) as [GraphicType, typeof TYPE_CONFIG[GraphicType]][]).map(([type, cfg]) => {
          const isActive = activeGraphics.some((g) => g.type === type);
          return (
            <Card
              key={type}
              className={isActive ? "border-primary/50 bg-primary/5" : ""}
            >
              <CardContent className="pt-4 pb-3 flex items-start gap-3">
                <div className={`mt-0.5 ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                  {cfg.icon}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm">{cfg.label}</p>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-500/10 border border-red-200 rounded-full px-1.5 py-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                        ON AIR
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{cfg.desc}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Active graphics */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers size={15} />
            Active On-Air Graphics
            {activeGraphics.length > 0 && (
              <Badge variant="secondary" className="text-[10px]">{activeGraphics.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : activeGraphics.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Tv2 size={32} className="text-muted-foreground/20" />
              <p className="font-medium text-sm">No active graphics</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Activate a graphic to display it on the live broadcast output in real time.
              </p>
              <Button size="sm" variant="outline" className="gap-1.5 mt-1" onClick={() => setDialogOpen(true)}>
                <Plus size={13} /> Activate Graphic
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {activeGraphics.map((g) => (
                <div
                  key={g.id}
                  className="flex items-start gap-3 p-3 rounded-lg border bg-muted/20"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <TypeBadge type={g.type} />
                      {g.durationSecs && (
                        <Badge variant="secondary" className="text-[10px]">
                          {g.durationSecs}s auto-dismiss
                        </Badge>
                      )}
                    </div>
                    <p className="font-semibold text-sm mt-1.5 truncate">{g.content}</p>
                    {g.subContent && (
                      <p className="text-xs text-muted-foreground truncate">{g.subContent}</p>
                    )}
                    {g.activatedAt && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Activated {formatDistanceToNow(new Date(g.activatedAt), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-shrink-0 h-7 w-7 p-0 text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20"
                    onClick={() => deactivateMutation.mutate(g.id)}
                    disabled={deactivateMutation.isPending}
                    title="Remove graphic"
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activate dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setForm(DEFAULT_FORM);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Activate On-Air Graphic</DialogTitle>
            <DialogDescription>
              Choose a type and enter the content. The graphic goes live immediately.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 mt-1">
            {/* Type */}
            <div className="space-y-1.5">
              <Label>Graphic Type</Label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as GraphicType, subContent: "" }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(TYPE_CONFIG) as [GraphicType, typeof TYPE_CONFIG[GraphicType]][]).map(([t, c]) => (
                    <SelectItem key={t} value={t}>
                      <span className="flex items-center gap-2">{c.icon} {c.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{typeCfg.desc}</p>
            </div>

            {/* Main content */}
            <div className="space-y-1.5">
              <Label htmlFor="content">
                {form.type === "lower_third"
                  ? "Name / Title"
                  : form.type === "ticker"
                  ? "Ticker Text"
                  : "Bug Text"}
              </Label>
              {form.type === "ticker" ? (
                <Textarea
                  id="content"
                  rows={2}
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder="Breaking: Sunday service starts at 10:00 AM…"
                  required
                />
              ) : (
                <Input
                  id="content"
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder={form.type === "lower_third" ? "Pastor John Doe" : "#TempleTV"}
                  required
                />
              )}
            </div>

            {/* Sub-content — lower_third only */}
            {typeCfg.hasSubContent && (
              <div className="space-y-1.5">
                <Label htmlFor="subContent">
                  Subtitle / Role{" "}
                  <span className="text-muted-foreground text-xs font-normal">(optional)</span>
                </Label>
                <Input
                  id="subContent"
                  value={form.subContent}
                  onChange={(e) => setForm((f) => ({ ...f, subContent: e.target.value }))}
                  placeholder="Senior Pastor, Temple TV"
                />
              </div>
            )}

            {/* Auto-dismiss */}
            <div className="space-y-1.5">
              <Label htmlFor="duration">
                Auto-dismiss after{" "}
                <span className="text-muted-foreground text-xs font-normal">
                  (seconds — leave blank for permanent)
                </span>
              </Label>
              <Input
                id="duration"
                type="number"
                min={1}
                max={3600}
                value={form.durationSecs}
                onChange={(e) => setForm((f) => ({ ...f, durationSecs: e.target.value }))}
                placeholder="e.g., 15"
              />
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialogOpen(false);
                  setForm(DEFAULT_FORM);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={activateMutation.isPending} className="gap-1.5">
                <Tv2 size={13} />
                {activateMutation.isPending ? "Activating…" : "Go Live"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Clear-all confirmation */}
      <Dialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear All Graphics?</DialogTitle>
            <DialogDescription>
              This will immediately remove all active on-air graphics from the live broadcast output.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setClearConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearAllMutation.mutate()}
              disabled={clearAllMutation.isPending}
            >
              {clearAllMutation.isPending ? "Clearing…" : "Clear All Graphics"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
