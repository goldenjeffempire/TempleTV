import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "wouter";
import { useListNotificationHistory, useSendPushNotification, getListNotificationHistoryQueryKey, useListAdminVideos } from "@workspace/api-client-react";
import { adminGet, adminPost, adminDelete } from "@/services/adminApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Send, Loader2, BellRing, Info, Clock, Trash2, CalendarClock, CheckCircle2, XCircle, AlertCircle, Film, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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


type NotifType = "live_service" | "new_sermon" | "announcement" | "custom";

type ScheduledNotif = {
  id: string;
  title: string;
  body: string;
  type: string;
  videoId: string | null;
  scheduledAt: string;
  status: string;
  sentCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  sentAt: string | null;
};

function statusBadge(status: string) {
  if (status === "pending") return <span className="inline-flex items-center gap-1 text-[10px] bg-yellow-500/15 text-yellow-600 border border-yellow-500/30 px-2 py-0.5 rounded-full"><Clock className="w-3 h-3" />Pending</span>;
  if (status === "sent") return <span className="inline-flex items-center gap-1 text-[10px] bg-green-500/15 text-green-600 border border-green-500/30 px-2 py-0.5 rounded-full"><CheckCircle2 className="w-3 h-3" />Sent</span>;
  if (status === "failed") return <span className="inline-flex items-center gap-1 text-[10px] bg-red-500/15 text-red-600 border border-red-500/30 px-2 py-0.5 rounded-full"><XCircle className="w-3 h-3" />Failed</span>;
  return <span className="inline-flex items-center gap-1 text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full"><AlertCircle className="w-3 h-3" />{status}</span>;
}

export default function Notifications() {
  const { data: rawHistory, isLoading } = useListNotificationHistory();
  // Defensive: only treat the response as a list when it really is one. Guards
  // against stale clients/proxies returning a non-array body.
  const history = Array.isArray(rawHistory) ? rawHistory : undefined;
  const { data: videosData } = useListAdminVideos({ limit: 200 });
  const sendNotification = useSendPushNotification();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const videoTitleById = useMemo(() => {
    const map = new Map<string, string>();
    const safeVideos = Array.isArray(videosData?.videos) ? videosData.videos : [];
    for (const v of safeVideos) map.set(v.id, v.title);
    return map;
  }, [videosData]);

  const renderVideoLink = (videoId: string | null | undefined) => {
    if (!videoId) return null;
    const title = videoTitleById.get(videoId) ?? `Video ${videoId.slice(0, 8)}`;
    return (
      <Link
        href="/videos"
        className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full max-w-[180px] hover:bg-primary/15 transition-colors"
        title={title}
      >
        <Film className="w-2.5 h-2.5 shrink-0" />
        <span className="truncate">{title}</span>
      </Link>
    );
  };

  const [formData, setFormData] = useState({
    title: "",
    body: "",
    type: "announcement" as NotifType,
    videoId: "",
  });

  const [schedForm, setSchedForm] = useState({
    title: "",
    body: "",
    type: "announcement" as NotifType,
    videoId: "",
    scheduledAt: "",
  });

  const [scheduled, setScheduled] = useState<ScheduledNotif[]>([]);
  const [schedLoading, setSchedLoading] = useState(false);
  const [schedSending, setSchedSending] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);

  const [schedError, setSchedError] = useState<string | null>(null);
  const fetchScheduled = useCallback(async () => {
    setSchedLoading(true);
    try {
      const data = await adminGet<ScheduledNotif[]>("/admin/notifications/scheduled");
      // Defensive: only adopt the response when it really is a list.
      setScheduled(Array.isArray(data) ? data : []);
      setSchedError(null);
    } catch (err) {
      // Surface the failure: silently swallowing it left the operator with a
      // stale "no scheduled notifications" view even when the API was down.
      setSchedError(err instanceof Error ? err.message : "Failed to load scheduled notifications");
    } finally {
      setSchedLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScheduled();
    const id = setInterval(fetchScheduled, 30_000);
    return () => clearInterval(id);
  }, [fetchScheduled]);

  const doSend = () => {
    sendNotification.mutate({ data: formData }, {
      onSuccess: (res: { sent: number; failed: number }) => {
        toast({ title: "Notification Sent", description: `Successfully sent to ${res.sent} devices. Failed: ${res.failed}` });
        setFormData({ title: "", body: "", type: "announcement", videoId: "" });
        queryClient.invalidateQueries({ queryKey: getListNotificationHistoryQueryKey() });
        setSendConfirmOpen(false);
      },
      onError: () => {
        toast({ title: "Failed to send notification", variant: "destructive" });
        setSendConfirmOpen(false);
      },
    });
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    setSendConfirmOpen(true);
  };

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const scheduledDate = new Date(schedForm.scheduledAt);
    if (!schedForm.scheduledAt || Number.isNaN(scheduledDate.getTime())) {
      toast({ title: "Invalid schedule time", description: "Pick a valid date and time before scheduling.", variant: "destructive" });
      return;
    }
    if (scheduledDate.getTime() <= Date.now()) {
      toast({ title: "Schedule time is in the past", description: "Pick a future date and time.", variant: "destructive" });
      return;
    }
    setSchedSending(true);
    try {
      await adminPost("/admin/notifications/schedule", {
        title: schedForm.title,
        body: schedForm.body,
        type: schedForm.type,
        videoId: schedForm.videoId || undefined,
        scheduledAt: scheduledDate.toISOString(),
      });
      toast({ title: "Notification Scheduled", description: `Will send on ${scheduledDate.toLocaleString()}` });
      setSchedForm({ title: "", body: "", type: "announcement", videoId: "", scheduledAt: "" });
      fetchScheduled();
    } catch (err) {
      toast({ title: "Failed to schedule", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setSchedSending(false);
    }
  };

  const doCancel = async (id: string) => {
    setCancellingId(id);
    setCancelConfirmId(null);
    try {
      await adminDelete(`/admin/notifications/scheduled/${id}`);
      toast({ title: "Notification Cancelled" });
      fetchScheduled();
    } catch (err) {
      toast({ title: "Failed to cancel", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setCancellingId(null);
    }
  };

  const minDateTime = () => {
    const d = new Date(Date.now() + 2 * 60 * 1000);
    return d.toISOString().slice(0, 16);
  };

  const pending = scheduled.filter((n) => n.status === "pending");
  const past = scheduled.filter((n) => n.status !== "pending");

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Push Notifications</h1>
        <p className="text-muted-foreground mt-1">Send alerts directly to the congregation app.</p>
      </div>

      <AlertDialog open={sendConfirmOpen} onOpenChange={setSendConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send Push Notification?</AlertDialogTitle>
            <AlertDialogDescription>
              This will be delivered <strong>immediately</strong> to all registered devices.
              <br /><br />
              <span className="font-medium text-foreground">"{formData.title}"</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Review Again</AlertDialogCancel>
            <AlertDialogAction onClick={doSend} disabled={sendNotification.isPending}>
              {sendNotification.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
              Send Now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelConfirmId !== null} onOpenChange={(open) => { if (!open) setCancelConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Scheduled Notification?</AlertDialogTitle>
            <AlertDialogDescription>
              This scheduled notification will be permanently cancelled and will not be sent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep It</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => cancelConfirmId && doCancel(cancelConfirmId)}
              disabled={cancellingId !== null}
            >
              {cancellingId ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Cancel Notification
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Tabs defaultValue="instant">
        <TabsList>
          <TabsTrigger value="instant">Send Now</TabsTrigger>
          <TabsTrigger value="schedule" className="flex items-center gap-1.5">
            <CalendarClock className="w-3.5 h-3.5" />
            Schedule
            {pending.length > 0 && (
              <span className="ml-1 bg-primary text-primary-foreground text-[10px] rounded-full px-1.5 py-px">{pending.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="instant" className="mt-4">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Compose Message</CardTitle>
                <CardDescription>This will be sent immediately to all devices.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSend} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Notification Type</Label>
                    <Select value={formData.type} onValueChange={(v) => setFormData({ ...formData, type: v as NotifType })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="announcement">Announcement</SelectItem>
                        <SelectItem value="live_service">Live Service Alert</SelectItem>
                        <SelectItem value="new_sermon">New Sermon</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Title</Label>
                      <span className={`text-[10px] ${formData.title.length > 65 ? "text-destructive font-medium" : "text-muted-foreground"}`}>{formData.title.length}/65</span>
                    </div>
                    <Input value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} placeholder="e.g. Sunday Service is Live!" maxLength={65} required />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Message Body</Label>
                      <span className={`text-[10px] ${formData.body.length > 240 ? "text-destructive font-medium" : "text-muted-foreground"}`}>{formData.body.length}/240</span>
                    </div>
                    <Textarea value={formData.body} onChange={(e) => setFormData({ ...formData, body: e.target.value })} placeholder="Tap here to join us in worship..." className="min-h-[100px]" maxLength={240} required />
                  </div>
                  {(formData.type === "live_service" || formData.type === "new_sermon") && (
                    <div className="space-y-2">
                      <Label>Video ID <span className="text-muted-foreground font-normal">(Optional)</span></Label>
                      <Input value={formData.videoId} onChange={(e) => setFormData({ ...formData, videoId: e.target.value })} placeholder="YouTube Video ID to open on tap" />
                    </div>
                  )}
                  <div className="p-3 bg-blue-500/10 text-blue-600 rounded-md text-sm flex gap-2 items-start mt-4 border border-blue-500/20">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>Notifications are delivered instantly. You will be asked to confirm before sending.</p>
                  </div>
                  <Button type="submit" className="w-full" disabled={!formData.title || !formData.body}>
                    <Send className="w-4 h-4 mr-2" />
                    Review & Send
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent History</CardTitle>
                <CardDescription>Log of previously sent notifications.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {isLoading ? (
                    Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
                  ) : history?.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">No notifications sent yet.</div>
                  ) : (
                    history?.slice(0, 6).map((notif) => (
                      <div key={notif.id} className="p-3 border rounded-lg bg-muted/20">
                        <div className="flex justify-between items-start mb-1">
                          <h4 className="font-semibold text-sm">{notif.title}</h4>
                          <span className="text-[10px] text-muted-foreground">{new Date(notif.sentAt).toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{notif.body}</p>
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full uppercase tracking-wider">{notif.type}</span>
                          <span className="flex items-center gap-1 text-muted-foreground"><BellRing className="w-3 h-3" /> Delivered to {notif.sentCount}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="schedule" className="mt-4">
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Schedule a Notification</CardTitle>
                <CardDescription>Set a future date and time to send automatically.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSchedule} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Notification Type</Label>
                    <Select value={schedForm.type} onValueChange={(v) => setSchedForm({ ...schedForm, type: v as NotifType })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="announcement">Announcement</SelectItem>
                        <SelectItem value="live_service">Live Service Alert</SelectItem>
                        <SelectItem value="new_sermon">New Sermon</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Title</Label>
                      <span className={`text-[10px] ${schedForm.title.length > 65 ? "text-destructive font-medium" : "text-muted-foreground"}`}>{schedForm.title.length}/65</span>
                    </div>
                    <Input value={schedForm.title} onChange={(e) => setSchedForm({ ...schedForm, title: e.target.value })} placeholder="e.g. Join us for Sunday Service!" maxLength={65} required />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Message Body</Label>
                      <span className={`text-[10px] ${schedForm.body.length > 240 ? "text-destructive font-medium" : "text-muted-foreground"}`}>{schedForm.body.length}/240</span>
                    </div>
                    <Textarea value={schedForm.body} onChange={(e) => setSchedForm({ ...schedForm, body: e.target.value })} placeholder="Worship starts at 10AM — tap to watch live." className="min-h-[100px]" maxLength={240} required />
                  </div>
                  {(schedForm.type === "live_service" || schedForm.type === "new_sermon") && (
                    <div className="space-y-2">
                      <Label>Video ID <span className="text-muted-foreground font-normal">(Optional)</span></Label>
                      <Input value={schedForm.videoId} onChange={(e) => setSchedForm({ ...schedForm, videoId: e.target.value })} placeholder="YouTube Video ID" />
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label>Send Date & Time</Label>
                    <Input
                      type="datetime-local"
                      min={minDateTime()}
                      value={schedForm.scheduledAt}
                      onChange={(e) => setSchedForm({ ...schedForm, scheduledAt: e.target.value })}
                      required
                    />
                  </div>
                  <div className="p-3 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded-md text-sm flex gap-2 items-start border border-amber-500/20">
                    <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>The server checks every 30 seconds for due notifications. Delivery may be up to 30 seconds after the scheduled time.</p>
                  </div>
                  <Button type="submit" className="w-full" disabled={schedSending}>
                    {schedSending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CalendarClock className="w-4 h-4 mr-2" />}
                    Schedule Notification
                  </Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Upcoming ({pending.length})</CardTitle>
                  <CardDescription>Pending scheduled notifications.</CardDescription>
                </CardHeader>
                <CardContent>
                  {schedLoading ? (
                    Array(2).fill(0).map((_, i) => <Skeleton key={i} className="h-20 w-full mb-3" />)
                  ) : schedError ? (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
                      <p className="font-medium text-destructive mb-1">Could not load scheduled notifications</p>
                      <p className="text-xs text-muted-foreground break-all mb-3">{schedError}</p>
                      <Button size="sm" variant="outline" onClick={fetchScheduled}>
                        <RefreshCw className="w-3 h-3 mr-2" />
                        Retry
                      </Button>
                    </div>
                  ) : pending.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">No upcoming notifications scheduled.</div>
                  ) : (
                    <div className="space-y-3">
                      {pending.map((n) => (
                        <div key={n.id} className="p-3 border rounded-lg bg-muted/20 flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                              {statusBadge(n.status)}
                              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{n.type}</span>
                              {renderVideoLink(n.videoId)}
                            </div>
                            <h4 className="font-semibold text-sm truncate">{n.title}</h4>
                            <p className="text-xs text-muted-foreground line-clamp-1">{n.body}</p>
                            <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                              <Clock className="w-3 h-3" />
                              {new Date(n.scheduledAt).toLocaleString()}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive shrink-0"
                            onClick={() => setCancelConfirmId(n.id)}
                            disabled={cancellingId === n.id}
                          >
                            {cancellingId === n.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {past.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Sent / Failed</CardTitle>
                    <CardDescription>Recently dispatched scheduled notifications.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {past.slice(0, 5).map((n) => (
                        <div
                          key={n.id}
                          className={`p-3 border rounded-lg ${
                            n.status === "failed"
                              ? "bg-red-500/5 border-red-500/30"
                              : "bg-muted/20"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            {statusBadge(n.status)}
                            {renderVideoLink(n.videoId)}
                          </div>
                          <h4 className="font-semibold text-sm">{n.title}</h4>
                          <p className="text-xs text-muted-foreground line-clamp-1 mb-1">{n.body}</p>
                          {n.status === "sent" && (
                            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <BellRing className="w-3 h-3" /> Delivered to {n.sentCount} devices · {n.sentAt ? new Date(n.sentAt).toLocaleString() : ""}
                            </p>
                          )}
                          {n.status === "failed" && n.errorMessage && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <p className="text-[10px] text-destructive font-medium flex items-start gap-1 mt-1 cursor-help">
                                    <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                                    <span className="line-clamp-2">{n.errorMessage}</span>
                                  </p>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-xs">
                                  <p className="text-xs whitespace-pre-wrap break-words">{n.errorMessage}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {n.status === "failed" && !n.errorMessage && (
                            <p className="text-[10px] text-destructive font-medium flex items-center gap-1 mt-1">
                              <AlertCircle className="w-3 h-3" />
                              Delivery failed (no error reported)
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Full Notification History</CardTitle>
              <CardDescription>All push notifications sent from the admin panel.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {isLoading ? (
                  Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
                ) : history?.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">No notifications have been sent yet.</div>
                ) : (
                  history?.map((notif) => (
                    <div key={notif.id} className="p-4 border rounded-lg bg-muted/20 flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="bg-secondary text-secondary-foreground text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider">{notif.type}</span>
                        </div>
                        <h4 className="font-semibold text-sm">{notif.title}</h4>
                        <p className="text-xs text-muted-foreground line-clamp-2">{notif.body}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[10px] text-muted-foreground">{new Date(notif.sentAt).toLocaleString()}</p>
                        <p className="text-xs mt-1 flex items-center gap-1 justify-end"><BellRing className="w-3 h-3" />{notif.sentCount} devices</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
