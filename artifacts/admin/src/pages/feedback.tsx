import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSSEEvent } from "@/contexts/sse-context";
import { api, HttpError, isTransientError } from "@/lib/api";
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
import { Bug, Lightbulb, MessageSquare, CheckCircle2, Trash2, RefreshCw, Clock, Smartphone, Globe, Tv } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface FeedbackItem {
  id: string;
  type: "bug" | "suggestion" | "general";
  subject: string;
  message: string;
  platform: string;
  appVersion: string | null;
  userId: string | null;
  userEmail: string | null;
  isRead: boolean;
  createdAt: string;
}

interface ListResponse {
  items: FeedbackItem[];
  total: number;
  page: number;
  limit: number;
  unread: number;
}

const TYPE_CONFIG: Record<FeedbackItem["type"], { label: string; icon: React.ReactNode; cls: string }> = {
  bug:        { label: "Bug Report",   icon: <Bug size={13} />,          cls: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20" },
  suggestion: { label: "Suggestion",   icon: <Lightbulb size={13} />,    cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20" },
  general:    { label: "Feedback",     icon: <MessageSquare size={13} />, cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20" },
};

const PLATFORM_ICON: Record<string, React.ReactNode> = {
  ios:     <Smartphone size={12} />,
  android: <Smartphone size={12} />,
  mobile:  <Smartphone size={12} />,
  web:     <Globe size={12} />,
  tv:      <Tv size={12} />,
};

export default function FeedbackPage() {
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<FeedbackItem | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-feedback"],
    queryFn: () => api.get<ListResponse>("/admin/feedback?limit=100"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  useSSEEvent("feedback-received", () => {
    void qc.invalidateQueries({ queryKey: ["admin-feedback"] });
  });

  const readMutation = useMutation({
    mutationFn: ({ id, isRead }: { id: string; isRead: boolean }) =>
      api.patch(`/admin/feedback/${id}/read`, { isRead }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-feedback"] }),
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/feedback/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-feedback"] });
      setDeleting(null);
      toast.success("Feedback deleted");
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to delete"),
  });

  const items = data?.items ?? [];
  const unread = items.filter((i) => !i.isRead);
  const read = items.filter((i) => i.isRead);
  const unreadCount = data?.unread ?? 0;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="User Feedback"
        description={unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
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

      <Tabs defaultValue="unread">
        <TabsList className="mb-4">
          <TabsTrigger value="unread">
            Unread
            {unread.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-[10px]">{unread.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="read">Read ({read.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="unread">
          <FeedbackList
            items={unread}
            loading={isLoading}
            onMarkRead={(id) => readMutation.mutate({ id, isRead: true })}
            onDelete={setDeleting}
            isActing={readMutation.isPending}
          />
        </TabsContent>
        <TabsContent value="read">
          <FeedbackList
            items={read}
            loading={isLoading}
            done
            onMarkRead={(id) => readMutation.mutate({ id, isRead: false })}
            onDelete={setDeleting}
            isActing={readMutation.isPending}
          />
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete feedback?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the feedback entry. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FeedbackList({
  items,
  loading,
  done,
  onMarkRead,
  onDelete,
  isActing,
}: {
  items: FeedbackItem[];
  loading: boolean;
  done?: boolean;
  onMarkRead: (id: string) => void;
  onDelete: (item: FeedbackItem) => void;
  isActing: boolean;
}) {
  const typeKeys = ["bug", "suggestion", "general"] as const;
  const byType: Record<string, FeedbackItem[]> = {};
  for (const k of typeKeys) byType[k] = items.filter((i) => i.type === k);

  return (
    <div className="space-y-5">
      {loading ? (
        <Card>
          <CardContent className="p-0 divide-y">
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-4"><Skeleton className="h-16 w-full" /></div>
            ))}
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <MessageSquare size={28} className="text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">
              {done ? "No resolved feedback" : "No unread feedback — you're all caught up!"}
            </p>
          </CardContent>
        </Card>
      ) : (
        typeKeys
          .filter((k) => (byType[k]?.length ?? 0) > 0)
          .map((k) => {
            const cfg = TYPE_CONFIG[k];
            return (
              <div key={k}>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  {cfg.icon} {cfg.label}s
                </p>
                <Card>
                  <CardContent className="p-0 divide-y">
                    {(byType[k] ?? []).map((item) => (
                      <FeedbackRow
                        key={item.id}
                        item={item}
                        done={done}
                        onMarkRead={onMarkRead}
                        onDelete={onDelete}
                        isActing={isActing}
                      />
                    ))}
                  </CardContent>
                </Card>
              </div>
            );
          })
      )}
    </div>
  );
}

function FeedbackRow({
  item,
  done,
  onMarkRead,
  onDelete,
  isActing,
}: {
  item: FeedbackItem;
  done?: boolean;
  onMarkRead: (id: string) => void;
  onDelete: (item: FeedbackItem) => void;
  isActing: boolean;
}) {
  const cfg = TYPE_CONFIG[item.type];
  const platIcon = PLATFORM_ICON[item.platform] ?? <Smartphone size={12} />;

  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={`text-[10px] gap-1 ${cfg.cls}`}>
            {cfg.icon} {cfg.label}
          </Badge>
          <span className="font-medium text-sm">{item.subject}</span>
        </div>
        <p className={`text-sm leading-relaxed ${done ? "text-muted-foreground" : ""}`}>
          {item.message}
        </p>
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            {platIcon} {item.platform}
            {item.appVersion ? ` v${item.appVersion}` : ""}
          </span>
          {item.userEmail && <span>{item.userEmail}</span>}
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0 pt-0.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={() => onMarkRead(item.id)}
          disabled={isActing}
        >
          <CheckCircle2 size={12} />
          {done ? "Unread" : "Done"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-red-500 hover:text-red-600"
          onClick={() => onDelete(item)}
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}
