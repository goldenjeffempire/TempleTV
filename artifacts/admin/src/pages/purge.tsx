import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, HttpError } from "@/lib/api";
import { useAuth } from "@/contexts/use-auth";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Trash2, AlertTriangle, ShieldAlert, CheckSquare } from "lucide-react";

type PurgeTarget =
  | "local_videos"
  | "youtube_videos"
  | "broadcast_queue"
  | "playlists"
  | "transcoding_jobs"
  | "schedule_entries";

interface PurgeResult {
  deleted: Record<string, number>;
  errors?: Record<string, string>;
  cacheCleared: boolean;
}

const PURGE_TARGETS: { id: PurgeTarget; label: string; description: string; severity: "warning" | "danger" }[] = [
  {
    id: "local_videos",
    label: "Local Videos",
    description: "Deletes all locally uploaded video files and their metadata from the database.",
    severity: "danger",
  },
  {
    id: "youtube_videos",
    label: "YouTube Videos",
    description: "Removes all YouTube-linked video records. Does not affect the actual YouTube content.",
    severity: "warning",
  },
  {
    id: "broadcast_queue",
    label: "Broadcast Queue",
    description: "Clears the entire broadcast queue. The engine reloads immediately — live stream stops.",
    severity: "danger",
  },
  {
    id: "playlists",
    label: "Playlists",
    description: "Permanently deletes all playlists and their video associations.",
    severity: "warning",
  },
  {
    id: "transcoding_jobs",
    label: "Transcoding Jobs",
    description: "Removes all pending and completed transcoding job records.",
    severity: "warning",
  },
  {
    id: "schedule_entries",
    label: "Schedule Entries",
    description: "Clears all broadcast schedule entries. Queued items are not affected.",
    severity: "warning",
  },
];

const CONFIRMATION_PHRASE = "PURGE CONFIRMED";

export default function PurgePage() {
  const { isAdmin } = useAuth();
  const [selected, setSelected] = useState<Set<PurgeTarget>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [lastResult, setLastResult] = useState<PurgeResult | null>(null);

  const purgeMutation = useMutation({
    mutationFn: (targets: PurgeTarget[]) =>
      api.post<PurgeResult>("/admin/purge", {
        targets,
        confirmationPhrase: CONFIRMATION_PHRASE,
      }),
    onSuccess: (result) => {
      setLastResult(result);
      setSelected(new Set());
      setDialogOpen(false);
      setConfirmInput("");
      const total = Object.values(result.deleted).reduce((a, b) => a + b, 0);
      const errorCount = Object.keys(result.errors ?? {}).length;
      if (errorCount > 0) {
        toast.warning(`Purge completed with ${errorCount} error(s). ${total} records deleted.`);
      } else {
        toast.success(`Purge completed. ${total} records deleted.`);
      }
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Purge failed"),
  });

  const toggleTarget = (id: PurgeTarget) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(PURGE_TARGETS.map((t) => t.id)));
  const clearAll = () => setSelected(new Set());

  if (!isAdmin) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <ShieldAlert size={36} className="text-muted-foreground/20" />
        <p className="font-medium">Admin access required</p>
        <p className="text-sm text-muted-foreground">Only system administrators can perform data purge operations.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader
        title="Data Purge"
        description="Permanently delete bulk data. These operations cannot be undone."
        actions={
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            disabled={selected.size === 0 || purgeMutation.isPending}
            onClick={() => { setConfirmInput(""); setDialogOpen(true); }}
          >
            <Trash2 size={13} /> Purge Selected ({selected.size})
          </Button>
        }
      />

      <div className="flex items-start gap-3 p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
        <AlertTriangle size={18} className="text-amber-500 mt-0.5 flex-shrink-0" />
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Purge operations are permanent and irreversible. Always create a database backup before proceeding.
          You must type <strong>{CONFIRMATION_PHRASE}</strong> exactly to confirm.
        </p>
      </div>

      {/* Select all / clear */}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs" onClick={selectAll}>
          <CheckSquare size={12} /> Select all
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5 h-7 text-xs" onClick={clearAll} disabled={selected.size === 0}>
          Clear
        </Button>
        {selected.size > 0 && (
          <span className="text-xs text-muted-foreground">{selected.size} target{selected.size !== 1 ? "s" : ""} selected</span>
        )}
      </div>

      <div className="space-y-3">
        {PURGE_TARGETS.map((target) => (
          <Card
            key={target.id}
            className={`cursor-pointer transition-colors ${selected.has(target.id) ? "border-destructive/40 bg-destructive/5" : ""} ${target.severity === "danger" ? "border-red-500/20" : ""}`}
            onClick={() => toggleTarget(target.id)}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selected.has(target.id)}
                  onCheckedChange={() => toggleTarget(target.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm">{target.label}</CardTitle>
                    {target.severity === "danger" && (
                      <Badge variant="destructive" className="text-[10px] h-4 px-1.5">danger</Badge>
                    )}
                  </div>
                  <CardDescription className="mt-0.5">{target.description}</CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>

      {/* Last result */}
      {lastResult && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Last purge result</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(lastResult.deleted).map(([key, count]) => (
              <Badge key={key} variant="outline" className="text-[11px] font-mono gap-1">
                {key}: <span className="font-bold">{count}</span> deleted
              </Badge>
            ))}
          </div>
          {lastResult.errors && Object.keys(lastResult.errors).length > 0 && (
            <div className="space-y-1 mt-2">
              {Object.entries(lastResult.errors).map(([key, msg]) => (
                <p key={key} className="text-xs text-destructive font-mono">{key}: {msg}</p>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Cache cleared: {lastResult.cacheCleared ? "yes" : "no"}
          </p>
        </div>
      )}

      <AlertDialog open={dialogOpen} onOpenChange={(o) => { if (!o) { setDialogOpen(false); setConfirmInput(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-500" />
              Confirm Purge: {selected.size} target{selected.size !== 1 ? "s" : ""}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will permanently delete data for:{" "}
                  <strong>{[...selected].map((id) => PURGE_TARGETS.find((t) => t.id === id)?.label ?? id).join(", ")}</strong>.
                  This action cannot be undone.
                </p>
                <p>
                  Type <strong>{CONFIRMATION_PHRASE}</strong> exactly to confirm.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1 py-2">
            <Label className="text-xs text-muted-foreground mb-2 block">Confirmation phrase</Label>
            <Input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={CONFIRMATION_PHRASE}
              className="font-mono"
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDialogOpen(false); setConfirmInput(""); }}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => purgeMutation.mutate([...selected])}
              disabled={confirmInput !== CONFIRMATION_PHRASE || purgeMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {purgeMutation.isPending ? "Purging…" : "Confirm Purge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
