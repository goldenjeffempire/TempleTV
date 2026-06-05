import { useState, useEffect, useRef } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Bell, Send, Clock, CheckCircle2, XCircle, RefreshCw, Users, Smartphone, Globe } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";

interface NotificationHistoryItem {
  id: string;
  title: string;
  body: string;
  type: string;
  sentAt: string;
  sentCount: number;
  status: string;
  errorMessage: string | null;
}

interface ScheduledNotification {
  id: string;
  title: string;
  body: string;
  scheduledAt: string;
  status: string;
  type: string;
}

interface PushStats {
  expoTokens: number;
  webSubscriptions: number;
  total: number;
}

interface SendForm {
  title: string;
  body: string;
  type: string;
  scheduledAt: string;
}

const DEFAULT_FORM: SendForm = { title: "", body: "", type: "announcement", scheduledAt: "" };

/** Computes the ISO datetime-local `min` string (now - 60 s) for the schedule input. */
function nowMinusOneMin(): string {
  return new Date(Date.now() - 60_000).toISOString().slice(0, 16);
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<SendForm>(DEFAULT_FORM);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Keep the datetime-local `min` fresh so operators who leave the page open
  // for hours can't accidentally select a past time — updated every minute.
  const [minDateTime, setMinDateTime] = useState<string>(nowMinusOneMin);
  const minTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    minTimerRef.current = setInterval(() => setMinDateTime(nowMinusOneMin()), 60_000);
    return () => { if (minTimerRef.current !== null) clearInterval(minTimerRef.current); };
  }, []);

  const { data: history, isLoading: histLoading, error: histError, refetch: refetchHist } = useQuery({
    queryKey: ["notifications-history"],
    queryFn: () => api.get<{ items: NotificationHistoryItem[] }>("/notifications/history"),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const { data: scheduled, isLoading: schedLoading, error: schedError, refetch: refetchSched } = useQuery({
    queryKey: ["scheduled-notifications"],
    queryFn: () => api.get<{ items: ScheduledNotification[] }>("/admin/notifications/scheduled"),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const { data: stats } = useQuery({
    queryKey: ["notifications-stats"],
    queryFn: () => api.get<PushStats>("/notifications/stats"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const isScheduled = Boolean(form.scheduledAt);

  const sendMutation = useMutation({
    mutationFn: (body: SendForm) => {
      const payload = { title: body.title, body: body.body, type: body.type };
      return api.post("/notifications/send", payload);
    },
    onSuccess: () => {
      toast.success("Notification sent successfully");
      setForm(DEFAULT_FORM);
      void qc.invalidateQueries({ queryKey: ["notifications-history"] });
      // Refresh Dashboard "Sent Last 24h" notification count.
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to send notification"),
  });

  const scheduleMutation = useMutation({
    mutationFn: (body: SendForm) => {
      if (!body.scheduledAt) throw new Error("No schedule time set");
      const scheduledAt = new Date(body.scheduledAt);
      // Re-validate at submission time, not just at render time, in case the
      // page has been open for a long time and the min attribute has gone stale.
      if (scheduledAt.getTime() <= Date.now()) {
        throw new Error("Scheduled time must be in the future");
      }
      const scheduledAtIso = scheduledAt.toISOString();
      return api.post("/admin/notifications/schedule", {
        title: body.title,
        body: body.body,
        type: body.type,
        scheduledAt: scheduledAtIso,
      });
    },
    onSuccess: () => {
      toast.success("Notification scheduled");
      setForm(DEFAULT_FORM);
      void qc.invalidateQueries({ queryKey: ["scheduled-notifications"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to schedule notification"),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/notifications/scheduled/${id}`),
    onSuccess: () => {
      toast.success("Scheduled notification cancelled");
      void qc.invalidateQueries({ queryKey: ["scheduled-notifications"] });
      void qc.invalidateQueries({ queryKey: ["notifications-history"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to cancel"),
  });

  const canSend = form.title.trim() && form.body.trim();
  const isSending = sendMutation.isPending || scheduleMutation.isPending;

  const handleSubmit = () => {
    if (isScheduled) {
      scheduleMutation.mutate(form);
    } else {
      // Show confirmation before blasting to all subscribers.
      setConfirmOpen(true);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader title="Notifications" description="Send and schedule push notifications to viewers." />

      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="bg-muted/30">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Smartphone size={16} className="text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Mobile Subscribers</p>
                <p className="text-xl font-bold">{stats.expoTokens.toLocaleString()}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-muted/30">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Globe size={16} className="text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Web Subscribers</p>
                <p className="text-xl font-bold">{stats.webSubscriptions.toLocaleString()}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-muted/30">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Users size={16} className="text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Reach</p>
                <p className="text-xl font-bold">{stats.total.toLocaleString()}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Send Form */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Send size={15} /> Send Notification
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                placeholder="Notification title"
                value={form.title}
                onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label>Message *</Label>
              <Textarea
                placeholder="Notification body text…"
                rows={3}
                value={form.body}
                onChange={(e) => setForm(f => ({ ...f, body: e.target.value }))}
                maxLength={500}
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm(f => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="announcement">Announcement</SelectItem>
                  <SelectItem value="live">Live Broadcast</SelectItem>
                  <SelectItem value="new_video">New Video</SelectItem>
                  <SelectItem value="test">Test</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Schedule (optional)</Label>
              <Input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(e) => setForm(f => ({ ...f, scheduledAt: e.target.value }))}
                min={minDateTime}
              />
              <p className="text-xs text-muted-foreground">
                {isScheduled
                  ? `Will send at ${format(new Date(form.scheduledAt), "MMM d, h:mm a")}`
                  : "Leave blank to send immediately."}
              </p>
            </div>
            {stats && stats.total > 0 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Users size={11} />
                Will reach {stats.total.toLocaleString()} subscriber{stats.total !== 1 ? "s" : ""}
              </p>
            )}
            {stats && stats.total === 0 && (
              <p className="text-xs text-amber-500">
                No registered subscribers yet — notification will be recorded but no devices will receive it.
              </p>
            )}
            <Button
              className="w-full gap-2"
              disabled={!canSend || isSending}
              onClick={handleSubmit}
            >
              {isSending ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : isScheduled ? (
                <Clock size={14} />
              ) : (
                <Send size={14} />
              )}
              {isSending ? (isScheduled ? "Scheduling…" : "Sending…") : isScheduled ? "Schedule" : "Send Now"}
            </Button>
          </CardContent>
        </Card>

        {/* History & Scheduled */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="scheduled">
            <TabsList className="mb-4">
              <TabsTrigger value="scheduled">
                Scheduled
                {(scheduled?.items?.filter(s => s.status === "pending")?.length ?? 0) > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px]">
                    {scheduled!.items.filter(s => s.status === "pending").length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>

            <TabsContent value="scheduled">
              {schedError && (
              <ErrorAlert
                message={(schedError as Error).message}
                onRetry={() => void refetchSched()}
                transient={isTransientError(schedError)}
                className="mb-3"
              />
            )}
              <Card>
                <CardContent className="p-0">
                  {schedLoading ? (
                    <div className="divide-y">{[1,2,3].map(i => <div key={i} className="p-3"><Skeleton className="h-14 w-full" /></div>)}</div>
                  ) : (scheduled?.items?.length ?? 0) === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-10 text-center">
                      <Clock size={24} className="text-muted-foreground/20" />
                      <p className="text-sm text-muted-foreground">No scheduled notifications</p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {scheduled!.items.map(s => (
                        <div key={s.id} className="flex items-start gap-3 px-4 py-3">
                          {s.status === "pending" ? (
                            <Clock size={15} className="text-amber-500 mt-0.5 flex-shrink-0" />
                          ) : s.status === "sent" ? (
                            <CheckCircle2 size={15} className="text-green-500 mt-0.5 flex-shrink-0" />
                          ) : s.status === "failed" ? (
                            <XCircle size={15} className="text-red-500 mt-0.5 flex-shrink-0" />
                          ) : (
                            <Bell size={15} className="text-muted-foreground mt-0.5 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{s.title}</p>
                            <p className="text-xs text-muted-foreground truncate">{s.body}</p>
                            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                              <Clock size={10} />
                              {format(new Date(s.scheduledAt), "MMM d, h:mm a")}
                              <span className="ml-1 capitalize">· {s.status}</span>
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <Badge variant="outline" className="capitalize text-[11px]">{s.type}</Badge>
                            {s.status === "pending" && (
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-red-500 hover:text-red-600"
                                onClick={() => cancelMutation.mutate(s.id)}
                                disabled={cancelMutation.isPending}
                              >
                                <XCircle size={14} />
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="history">
              {histError && (
              <ErrorAlert
                message={(histError as Error).message}
                onRetry={() => void refetchHist()}
                transient={isTransientError(histError)}
                className="mb-3"
              />
            )}
              <Card>
                <CardContent className="p-0">
                  {histLoading ? (
                    <div className="divide-y">{[1,2,3,4].map(i => <div key={i} className="p-3"><Skeleton className="h-14 w-full" /></div>)}</div>
                  ) : (history?.items?.length ?? 0) === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-10 text-center">
                      <Bell size={24} className="text-muted-foreground/20" />
                      <p className="text-sm text-muted-foreground">No notifications sent yet</p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {history!.items.map(n => (
                        <div key={n.id} className="flex items-start gap-3 px-4 py-3">
                          {n.status === "sent" || n.status === "delivered" ? (
                            <CheckCircle2 size={15} className="text-green-500 mt-0.5 flex-shrink-0" />
                          ) : n.status === "failed" ? (
                            <XCircle size={15} className="text-red-500 mt-0.5 flex-shrink-0" />
                          ) : n.status === "pending" || n.status === "sending" ? (
                            <RefreshCw size={15} className="text-amber-500 mt-0.5 flex-shrink-0 animate-spin" />
                          ) : (
                            <Bell size={15} className="text-muted-foreground mt-0.5 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{n.title}</p>
                            <p className="text-xs text-muted-foreground truncate">{n.body}</p>
                            <div className="flex gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                              <span>{formatDistanceToNow(new Date(n.sentAt), { addSuffix: true })}</span>
                              {n.sentCount > 0 && (
                                <span className="text-green-600">{n.sentCount.toLocaleString()} delivered</span>
                              )}
                              {n.sentCount === 0 && (n.status === "sent" || n.status === "delivered") && (
                                <span className="text-muted-foreground">0 subscribers at time of send</span>
                              )}
                              {n.status === "failed" && n.errorMessage && (
                                <span className="text-red-500 truncate max-w-[200px]" title={n.errorMessage}>
                                  {n.errorMessage.slice(0, 60)}{n.errorMessage.length > 60 ? "…" : ""}
                                </span>
                              )}
                            </div>
                          </div>
                          <Badge variant="outline" className="capitalize text-[11px] flex-shrink-0">{n.type}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send notification now?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately push &ldquo;{form.title}&rdquo; to{" "}
              {stats && stats.total > 0
                ? <strong>{stats.total.toLocaleString()} subscriber{stats.total !== 1 ? "s" : ""}</strong>
                : "all subscribers"}.{" "}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => sendMutation.mutate(form)}
              disabled={sendMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {sendMutation.isPending
                ? <><span className="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent inline-block" />Sending…</>
                : <><Send size={14} className="mr-1.5" />Send Now</>}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
