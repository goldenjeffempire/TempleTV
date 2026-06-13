import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Heart, CheckCircle2, Trash2, RefreshCw, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface Prayer {
  id: string;
  name?: string;
  request: string;
  status: "pending" | "prayed";
  createdAt: string;
}

interface PrayerApiRow {
  id: string;
  name: string | null;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export default function PrayersPage() {
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<Prayer | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["prayers"],
    queryFn: () =>
      api.get<{ items: PrayerApiRow[]; total: number }>("/admin/prayers").then((d) => ({
        prayers: d.items.map((p): Prayer => ({
          id: p.id,
          name: p.name ?? undefined,
          request: p.message,
          status: p.isRead ? "prayed" : "pending",
          createdAt: p.createdAt,
        })),
      })),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id }: { id: string; status: string }) => api.patch(`/admin/prayers/${id}/read`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["prayers"] }); toast.success("Prayer updated"); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/prayers/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["prayers"] }); setDeleting(null); toast.success("Prayer removed"); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed"),
  });

  // SSE-driven invalidation — new prayers and status changes arrive in
  // real-time without waiting for the 30-second polling interval.
  useSSEEvent("prayer-received", () => { void qc.invalidateQueries({ queryKey: ["prayers"] }); });
  useSSEEvent("prayer-updated",  () => { void qc.invalidateQueries({ queryKey: ["prayers"] }); });
  useSSEEvent("prayer-deleted",  () => { void qc.invalidateQueries({ queryKey: ["prayers"] }); });

  const prayers = data?.prayers ?? [];
  const pending = prayers.filter(p => p.status === "pending");
  const prayed = prayers.filter(p => p.status === "prayed");

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Prayer Requests"
        description={`${pending.length} pending requests`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      <Tabs defaultValue="pending">
        <TabsList className="mb-4">
          <TabsTrigger value="pending">
            Pending
            {pending.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[10px]">{pending.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="prayed">Prayed ({prayed.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          <PrayerList prayers={pending} loading={isLoading} onPray={(id) => updateMutation.mutate({ id, status: "prayed" })} onDelete={setDeleting} isPraying={updateMutation.isPending} />
        </TabsContent>

        <TabsContent value="prayed">
          <PrayerList prayers={prayed} loading={isLoading} done onDelete={setDeleting} isPraying={false} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete prayer request?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the prayer request.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && deleteMutation.mutate(deleting.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PrayerList({ prayers, loading, done, onPray, onDelete, isPraying }: {
  prayers: Prayer[]; loading: boolean; done?: boolean;
  onPray?: (id: string) => void; onDelete: (p: Prayer) => void; isPraying: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        {loading ? (
          <div className="divide-y">{[1,2,3].map(i => <div key={i} className="p-4"><Skeleton className="h-16 w-full" /></div>)}</div>
        ) : prayers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Heart size={28} className={done ? "text-pink-400/30" : "text-muted-foreground/20"} />
            <p className="text-sm text-muted-foreground">{done ? "No completed requests" : "No pending prayer requests"}</p>
          </div>
        ) : (
          <div className="divide-y">
            {prayers.map(p => (
              <div key={p.id} className="px-4 py-3 flex items-start gap-3">
                <Heart size={15} className={`mt-0.5 flex-shrink-0 ${done ? "text-pink-400" : "text-muted-foreground"}`} />
                <div className="flex-1 min-w-0">
                  {p.name && <p className="font-medium text-sm">{p.name}</p>}
                  <p className={`text-sm ${done ? "text-muted-foreground" : ""}`}>{p.request}</p>
                  <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                    <Clock size={10} /> {formatDistanceToNow(new Date(p.createdAt), { addSuffix: true })}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {!done && onPray && (
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onPray(p.id)} disabled={isPraying}>
                      <CheckCircle2 size={12} /> Prayed
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600" onClick={() => onDelete(p)}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
