import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCcw, Trash2, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { useSSEEvent } from "@/contexts/sse-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";

interface CorruptItem {
  videoId: string | null;
  title: string | null;
  originalFilename: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  transcodingStatus: string | null;
  detectedAt: string | null;
  auditId: string;
  reason: string | null;
  triggeredBy: string;
  queueItemsRemoved: number;
  playlistEntriesRemoved: number;
}

interface InventoryResponse {
  items: CorruptItem[];
  total: number;
  page: number;
  limit: number;
}

interface StatsResponse {
  last24h: number;
  quarantinedTotal: number;
  lastDetectedAt: string | null;
}

interface RetryResponse {
  queued: boolean;
  message: string;
}

const ERROR_CODE_VARIANTS: Record<string, "destructive" | "secondary" | "outline"> = {
  CORRUPT_SOURCE: "destructive",
  SOURCE_MISSING: "destructive",
  ASSEMBLY_FAILED: "secondary",
  STUCK_TRANSCODE: "outline",
};

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function CorruptMediaPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [errorCodeFilter, setErrorCodeFilter] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CorruptItem | null>(null);
  const LIMIT = 20;

  // Real-time updates — invalidate list + stats when a new corrupt video is
  // detected by quarantineVideo() (upload pipeline or queue integrity validator).
  // Without this, the page stays stale until the 60 s polling interval fires.
  useSSEEvent("corrupt-media-detected", () => {
    void qc.invalidateQueries({ queryKey: ["corrupt-media"] });
  });

  // Also refresh when a retry succeeds or fails (videos-library-updated) so
  // the "Retry" badge and status reflect the latest state.
  useSSEEvent("videos-library-updated", () => {
    void qc.invalidateQueries({ queryKey: ["corrupt-media"] });
  });

  const { data: stats } = useQuery<StatsResponse>({
    queryKey: ["corrupt-media", "stats"],
    queryFn: () => api.get<StatsResponse>("/admin/corrupt-media/stats"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data, isLoading, isError, isFetching } = useQuery<InventoryResponse>({
    queryKey: ["corrupt-media", "list", page, errorCodeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (errorCodeFilter) params.set("errorCode", errorCodeFilter);
      return api.get<InventoryResponse>(`/admin/corrupt-media?${params}`);
    },
    staleTime: 15_000,
  });

  const retryMutation = useMutation<RetryResponse, Error, string>({
    mutationFn: (videoId: string) =>
      api.post<RetryResponse>(`/admin/corrupt-media/${videoId}/retry`),
    onSuccess: (res) => {
      if (res.queued) {
        toast.success("Retry queued", { description: res.message });
      } else {
        toast.warning("Cannot retry", { description: res.message });
      }
      void qc.invalidateQueries({ queryKey: ["corrupt-media"] });
    },
    onError: (err) => {
      toast.error("Retry failed", { description: String(err) });
    },
  });

  const deleteMutation = useMutation<{ deleted: boolean }, Error, string>({
    mutationFn: (videoId: string) =>
      api.delete<{ deleted: boolean }>(`/admin/corrupt-media/${videoId}`),
    onSuccess: () => {
      toast.success("Video deleted");
      setDeleteTarget(null);
      void qc.invalidateQueries({ queryKey: ["corrupt-media"] });
    },
    onError: (err) => {
      toast.error("Delete failed", { description: String(err) });
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <PageHeader
        title="Corrupt Media"
        description="Videos quarantined due to structural upload failures. Re-upload or delete to resolve."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void qc.invalidateQueries({ queryKey: ["corrupt-media"] })}
            disabled={isFetching}
            className="gap-2"
          >
            <RefreshCcw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Last 24 Hours</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-destructive">{stats?.last24h ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Quarantined</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats?.quarantinedTotal ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Last Detected</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{formatRelativeTime(stats?.lastDetectedAt ?? null)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by error code…"
            className="pl-8"
            value={errorCodeFilter}
            onChange={(e) => { setErrorCodeFilter(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading…</div>
      ) : isError ? (
        <ErrorAlert
          title="Failed to load corrupt media"
          message="Could not fetch quarantined video data from the server."
          onRetry={() => void qc.invalidateQueries({ queryKey: ["corrupt-media"] })}
        />
      ) : !data || data.items.length === 0 ? (
        <div className="text-center py-12">
          <AlertTriangle className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-muted-foreground">
            {errorCodeFilter ? "No corrupt videos matching this filter." : "No corrupt media detected. Uploads are healthy."}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left p-3 font-medium">Video</th>
                  <th className="text-left p-3 font-medium">Error</th>
                  <th className="text-left p-3 font-medium">Triggered By</th>
                  <th className="text-left p-3 font-medium">Detected</th>
                  <th className="text-left p-3 font-medium">Impact</th>
                  <th className="text-right p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.auditId} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="p-3 max-w-[220px]">
                      <p className="font-medium truncate" title={item.title ?? undefined}>
                        {item.title ?? <span className="text-muted-foreground italic">Untitled</span>}
                      </p>
                      {item.originalFilename && (
                        <p className="text-xs text-muted-foreground truncate" title={item.originalFilename}>
                          {item.originalFilename}
                        </p>
                      )}
                    </td>
                    <td className="p-3">
                      <Badge variant={ERROR_CODE_VARIANTS[item.errorCode ?? ""] ?? "outline"}>
                        {item.errorCode ?? "UNKNOWN"}
                      </Badge>
                      {item.errorMessage && (
                        <p className="text-xs text-muted-foreground mt-1 max-w-[200px] line-clamp-2" title={item.errorMessage}>
                          {item.errorMessage}
                        </p>
                      )}
                    </td>
                    <td className="p-3 text-muted-foreground text-xs">{item.triggeredBy}</td>
                    <td className="p-3 text-muted-foreground text-xs whitespace-nowrap">
                      {formatRelativeTime(item.detectedAt)}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {item.queueItemsRemoved > 0 && (
                        <span className="block">{item.queueItemsRemoved} queue item{item.queueItemsRemoved !== 1 ? "s" : ""} removed</span>
                      )}
                      {item.playlistEntriesRemoved > 0 && (
                        <span className="block">{item.playlistEntriesRemoved} playlist entr{item.playlistEntriesRemoved !== 1 ? "ies" : "y"} removed</span>
                      )}
                      {item.queueItemsRemoved === 0 && item.playlistEntriesRemoved === 0 && (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {item.videoId && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => retryMutation.mutate(item.videoId!)}
                              disabled={retryMutation.isPending}
                              title="Re-enqueue for transcoding"
                            >
                              <RefreshCcw className="h-3.5 w-3.5 mr-1" />
                              Retry
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => setDeleteTarget(item)}
                              title="Permanently delete this video"
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1" />
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, data.total)} of {data.total}
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">{page} / {totalPages}</span>
                <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete corrupt video?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{" "}
              <strong>{deleteTarget?.title ?? "this video"}</strong> from the database,
              including all queue entries and playlist references. This cannot be undone —
              the source file will need to be re-uploaded to restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget?.videoId && deleteMutation.mutate(deleteTarget.videoId)}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
