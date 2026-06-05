import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { MessageSquare, Trash2, ShieldOff, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ChatMessage {
  id: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  message: string;
  createdAt: string;
  isFlagged?: boolean;
}

interface ChatStats {
  totalMessages: number;
  activeUsers: number;
  flaggedCount: number;
}

export default function ChatPage() {
  const qc = useQueryClient();
  const [banTarget, setBanTarget] = useState<{ userId: string; userName: string } | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["chat-messages"],
    queryFn: () => api.get<{ messages: ChatMessage[]; stats?: ChatStats }>("/admin/chat"),
    refetchInterval: 90_000,
    staleTime: 60_000,
  });

  useSSEEvent("chat-message", () => { void qc.invalidateQueries({ queryKey: ["chat-messages"] }); });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/chat/${id}`),
    onSuccess: () => { toast.success("Message deleted"); void qc.invalidateQueries({ queryKey: ["chat-messages"] }); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to delete"),
  });

  const banMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/admin/users/${userId}/ban`),
    onSuccess: () => {
      toast.success("User banned from chat");
      setBanTarget(null);
      void qc.invalidateQueries({ queryKey: ["chat-messages"] });
    },
    onError: (e) => { setBanTarget(null); toast.error(e instanceof HttpError ? e.message : "Failed to ban"); },
  });

  const messages = data?.messages ?? [];
  const stats = data?.stats;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Live Chat"
        description="Moderate live chat messages during broadcasts."
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

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <Card><CardContent className="pt-4 pb-3"><div className="text-2xl font-bold">{stats.totalMessages}</div><div className="text-xs text-muted-foreground">Total messages</div></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><div className="text-2xl font-bold">{stats.activeUsers}</div><div className="text-xs text-muted-foreground">Active users</div></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><div className="text-2xl font-bold text-red-500">{stats.flaggedCount}</div><div className="text-xs text-muted-foreground">Flagged</div></CardContent></Card>
        </div>
      )}

      {/* Messages */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare size={15} /> Recent Messages ({messages.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y">{[1,2,3,4,5].map(i => <div key={i} className="p-3"><Skeleton className="h-12 w-full" /></div>)}</div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <MessageSquare size={28} className="text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">No chat messages yet</p>
              <p className="text-xs text-muted-foreground">Messages will appear here during live broadcasts.</p>
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              <div className="divide-y">
                {messages.map(msg => (
                  <div key={msg.id} className={`flex items-start gap-3 px-4 py-3 group ${msg.isFlagged ? "bg-red-500/5" : ""}`}>
                    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                      {(msg.userName ?? msg.userEmail ?? "?").slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-xs">{msg.userName ?? msg.userEmail ?? "Anonymous"}</span>
                        {msg.isFlagged && <Badge variant="destructive" className="text-[10px]">Flagged</Badge>}
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm mt-0.5">{msg.message}</p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      {msg.userId && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-amber-500"
                          title="Ban user"
                          aria-label="Ban user"
                          disabled={banMutation.isPending}
                          onClick={() => setBanTarget({ userId: msg.userId!, userName: msg.userName ?? msg.userEmail ?? msg.userId! })}
                        >
                          <ShieldOff size={12} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-red-500"
                        title="Delete"
                        aria-label="Delete message"
                        disabled={deleteMutation.isPending && deleteMutation.variables === msg.id}
                        onClick={() => deleteMutation.mutate(msg.id)}
                      >
                        <Trash2 size={12} className={deleteMutation.isPending && deleteMutation.variables === msg.id ? "animate-pulse" : ""} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Ban confirmation */}
      <AlertDialog open={!!banTarget} onOpenChange={(o) => { if (!o) setBanTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ban user from chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently ban <strong>{banTarget?.userName}</strong> from the live chat. This action cannot be undone from the chat panel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={banMutation.isPending}
              onClick={() => banTarget && banMutation.mutate(banTarget.userId)}
            >
              {banMutation.isPending ? "Banning…" : "Ban user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
