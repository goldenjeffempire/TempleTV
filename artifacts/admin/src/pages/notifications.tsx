import { useState } from "react";
import { useListNotificationHistory, useSendPushNotification, getListNotificationHistoryQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Send, Loader2, BellRing, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

export default function Notifications() {
  const { data: history, isLoading } = useListNotificationHistory();
  const sendNotification = useSendPushNotification();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    title: "",
    body: "",
    type: "announcement" as any,
    videoId: ""
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirm("Send this push notification to all subscribers?")) return;

    sendNotification.mutate({ data: formData }, {
      onSuccess: (res) => {
        toast({ title: "Notification Sent", description: `Successfully sent to ${res.sent} devices. Failed: ${res.failed}` });
        setFormData({ title: "", body: "", type: "announcement", videoId: "" });
        queryClient.invalidateQueries({ queryKey: getListNotificationHistoryQueryKey() });
      },
      onError: () => toast({ title: "Failed to send notification", variant: "destructive" })
    });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Push Notifications</h1>
        <p className="text-muted-foreground mt-1">Send alerts directly to the congregation app.</p>
      </div>

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
                <Select value={formData.type} onValueChange={v => setFormData({...formData, type: v})}>
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
                <Input value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} placeholder="e.g. Sunday Service is Live!" required />
              </div>

              <div className="space-y-2">
                <Label>Message Body</Label>
                <Textarea value={formData.body} onChange={e => setFormData({...formData, body: e.target.value})} placeholder="Tap here to join us in worship..." className="min-h-[100px]" required />
              </div>

              {(formData.type === 'live_service' || formData.type === 'new_sermon') && (
                <div className="space-y-2">
                  <Label>Video ID (Optional)</Label>
                  <Input value={formData.videoId} onChange={e => setFormData({...formData, videoId: e.target.value})} placeholder="YouTube Video ID to open on tap" />
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
                history?.map((notif) => (
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
    </div>
  );
}
