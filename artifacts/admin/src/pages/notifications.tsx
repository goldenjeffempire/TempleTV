import { useState, useEffect, useCallback } from "react";
import { useListNotificationHistory, useSendPushNotification, getListNotificationHistoryQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Send, Loader2, BellRing, Info, Clock, Trash2, CalendarClock, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/\/admin\/?$/, "") + "/api";

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
  const { data: history, isLoading } = useListNotificationHistory();
  const sendNotification = useSendPushNotification();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    title: "",
    body: "",
    type: "announcement" as string,
    videoId: "",
  });

  const [schedForm, setSchedForm] = useState({
    title: "",
    body: "",
    type: "announcement" as string,
    videoId: "",
    scheduledAt: "",
  });

  const [scheduled, setScheduled] = useState<ScheduledNotif[]>([]);
  const [schedLoading, setSchedLoading] = useState(false);
  const [schedSending, setSchedSending] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const fetchScheduled = useCallback(async () => {
    setSchedLoading(true);
    try {
      const res = await fetch(`${BASE}/admin/notifications/scheduled`);
      if (res.ok) setScheduled(await res.json());
    } finally {
      setSchedLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScheduled();
    const id = setInterval(fetchScheduled, 30_000);
    return () => clearInterval(id);
  }, [fetchScheduled]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirm("Send this push notification to all subscribers?")) return;

    sendNotification.mutate({ data: formData }, {
      onSuccess: (res) => {
        toast({ title: "Notification Sent", description: `Successfully sent to ${res.sent} devices. Failed: ${res.failed}` });
        setFormData({ title: "", body: "", type: "announcement", videoId: "" });
        queryClient.invalidateQueries({ queryKey: getListNotificationHistoryQueryKey() });
      },
      onError: () => toast({ title: "Failed to send notification", variant: "destructive" }),
    });
  };

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSchedSending(true);
    try {
      const res = await fetch(`${BASE}/admin/notifications/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: schedForm.title,
          body: schedForm.body,
          type: schedForm.type,
          videoId: schedForm.videoId || undefined,
          scheduledAt: new Date(schedForm.scheduledAt).toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      toast({ title: "Notification Scheduled", description: `Will send on ${new Date(schedForm.scheduledAt).toLocaleString()}` });
      setSchedForm({ title: "", body: "", type: "announcement", videoId: "", scheduledAt: "" });
      fetchScheduled();
    } catch (err) {
      toast({ title: "Failed to schedule", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setSchedSending(false);
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm("Cancel this scheduled notification?")) return;
    setCancellingId(id);
    try {
      const res = await fetch(`${BASE}/admin/notifications/scheduled/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
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
                    <Select value={formData.type} onValueChange={(v) => setFormData({ ...formData, type: v })}>
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
                    <Label>Title</Label>
                    <Input value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} placeholder="e.g. Sunday Service is Live!" required />
                  </div>
                  <div className="space-y-2">
                    <Label>Message Body</Label>
                    <Textarea value={formData.body} onChange={(e) => setFormData({ ...formData, body: e.target.value })} placeholder="Tap here to join us in worship..." className="min-h-[100px]" required />
                  </div>
                  {(formData.type === "live_service" || formData.type === "new_sermon") && (
                    <div className="space-y-2">
                      <Label>Video ID (Optional)</Label>
                      <Input value={formData.videoId} onChange={(e) => setFormData({ ...formData, videoId: e.target.value })} placeholder="YouTube Video ID to open on tap" />
                    </div>
                  )}
                  <div className="p-3 bg-blue-500/10 text-blue-600 rounded-md text-sm flex gap-2 items-start mt-4 border border-blue-500/20">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>Notifications are delivered instantly. Please review your message carefully before sending.</p>
                  </div>
                  <Button type="submit" className="w-full" disabled={sendNotification.isPending}>
                    {sendNotification.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                    Send Push Notification
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
                    <Select value={schedForm.type} onValueChange={(v) => setSchedForm({ ...schedForm, type: v })}>
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
                    <Label>Title</Label>
                    <Input value={schedForm.title} onChange={(e) => setSchedForm({ ...schedForm, title: e.target.value })} placeholder="e.g. Join us for Sunday Service!" required />
                  </div>
                  <div className="space-y-2">
                    <Label>Message Body</Label>
                    <Textarea value={schedForm.body} onChange={(e) => setSchedForm({ ...schedForm, body: e.target.value })} placeholder="Worship starts at 10AM — tap to watch live." className="min-h-[100px]" required />
                  </div>
                  {(schedForm.type === "live_service" || schedForm.type === "new_sermon") && (
                    <div className="space-y-2">
                      <Label>Video ID (Optional)</Label>
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
                  ) : pending.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">No upcoming notifications scheduled.</div>
                  ) : (
                    <div className="space-y-3">
                      {pending.map((n) => (
                        <div key={n.id} className="p-3 border rounded-lg bg-muted/20 flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              {statusBadge(n.status)}
                              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{n.type}</span>
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
                            onClick={() => handleCancel(n.id)}
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
                        <div key={n.id} className="p-3 border rounded-lg bg-muted/20">
                          <div className="flex items-center gap-2 mb-0.5">
                            {statusBadge(n.status)}
                          </div>
                          <h4 className="font-semibold text-sm">{n.title}</h4>
                          <p className="text-xs text-muted-foreground line-clamp-1 mb-1">{n.body}</p>
                          {n.status === "sent" && (
                            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <BellRing className="w-3 h-3" /> Delivered to {n.sentCount} devices · {n.sentAt ? new Date(n.sentAt).toLocaleString() : ""}
                            </p>
                          )}
                          {n.status === "failed" && n.errorMessage && (
                            <p className="text-[10px] text-destructive">{n.errorMessage}</p>
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
