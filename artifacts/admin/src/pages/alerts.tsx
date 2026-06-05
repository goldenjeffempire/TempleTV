import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Shield, CheckCircle2, AlertTriangle, Info, XCircle, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface Alert {
  id: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "error" | "critical" | "emergency";
  source: string;
  resolvedAt?: string;
  createdAt: string;
}

const SEVERITY_CONFIG = {
  info: { icon: <Info size={15} />, color: "text-blue-500", bg: "", badge: "outline" as const },
  warning: { icon: <AlertTriangle size={15} />, color: "text-amber-500", bg: "bg-amber-500/5", badge: "secondary" as const },
  error: { icon: <XCircle size={15} />, color: "text-red-500", bg: "bg-red-500/5", badge: "destructive" as const },
  critical: { icon: <XCircle size={15} />, color: "text-red-600", bg: "bg-red-600/10", badge: "destructive" as const },
  // "emergency" is the highest-severity level — render with the same visual
  // weight as "critical" so operators can't miss it.
  emergency: { icon: <XCircle size={15} />, color: "text-red-700", bg: "bg-red-700/15", badge: "destructive" as const },
};

export default function AlertsPage() {
  const qc = useQueryClient();
  const [resolveTargetId, setResolveTargetId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api.get<{ alerts: Alert[] }>("/admin/alerts"),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/alerts/${id}/resolve`),
    onSuccess: () => { toast.success("Alert resolved"); void qc.invalidateQueries({ queryKey: ["alerts"] }); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed"),
  });

  const alerts = data?.alerts ?? [];
  const active = alerts.filter(a => !a.resolvedAt);
  const resolved = alerts.filter(a => !!a.resolvedAt);

  const handleDialogOpenChange = (open: boolean) => { if (!open) setResolveTargetId(null); };
  const handleResolveConfirm = () => { const id = resolveTargetId; setResolveTargetId(null); if (id) resolveMutation.mutate(id); };

  return (
    <>
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Alerts"
        description={`${active.length} active alert${active.length !== 1 ? "s" : ""}`}
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

      {isLoading ? (
        <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : active.length === 0 && resolved.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Shield size={36} className="text-green-500/30" />
          <p className="font-medium">All clear</p>
          <p className="text-sm text-muted-foreground">No active alerts.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Active</h3>
              <div className="space-y-2">
                {active.map(alert => {
                  const cfg = SEVERITY_CONFIG[alert.severity] ?? SEVERITY_CONFIG.info;
                  return (
                    <Card key={alert.id} className={cfg.bg}>
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <span className={cfg.color}>{cfg.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-sm">{alert.title}</p>
                              <Badge variant={cfg.badge} className="text-[10px] capitalize">{alert.severity}</Badge>
                              <Badge variant="outline" className="text-[10px]">{alert.source}</Badge>
                            </div>
                            <p className="text-sm text-muted-foreground mt-0.5">{alert.message}</p>
                            <p className="text-xs text-muted-foreground mt-1">{formatDistanceToNow(new Date(alert.createdAt), { addSuffix: true })}</p>
                          </div>
                          <Button size="sm" variant="outline" className="flex-shrink-0 h-7 text-xs gap-1" onClick={() => setResolveTargetId(alert.id)} disabled={resolveMutation.isPending}>
                            <CheckCircle2 size={12} /> Resolve
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {resolved.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Resolved</h3>
              <Card>
                <CardContent className="p-0 divide-y">
                  {resolved.slice(0, 10).map(alert => (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-muted-foreground truncate">{alert.title}</p>
                        <p className="text-xs text-muted-foreground">Resolved {formatDistanceToNow(new Date(alert.resolvedAt!), { addSuffix: true })}</p>
                      </div>
                      <Badge variant="outline" className="text-[10px] capitalize flex-shrink-0">{alert.severity}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>

    <AlertDialog open={resolveTargetId !== null} onOpenChange={handleDialogOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Resolve alert?</AlertDialogTitle>
          <AlertDialogDescription>
            This marks the alert as resolved and removes it from the Active list. Make sure the
            underlying issue has actually been addressed before dismissing critical or emergency alerts.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleResolveConfirm}>
            Resolve
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
