import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAdminToken } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Trash2, MailOpen, Mail, ChevronLeft, ChevronRight } from "lucide-react";

interface PrayerRequest {
  id: string;
  name: string | null;
  message: string;
  isRead: boolean;
  createdAt: string;
}

interface PrayerResponse {
  items: PrayerRequest[];
  total: number;
  page: number;
  limit: number;
  unread: number;
}

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function fetchPrayers(page: number, unreadOnly: boolean): Promise<PrayerResponse> {
  const token = getAdminToken();
  const qs = new URLSearchParams({
    page: String(page),
    limit: "25",
    ...(unreadOnly ? { unread: "true" } : {}),
  });
  const res = await fetch(`/api/admin/prayers?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to load prayer requests");
  return res.json();
}

async function markRead(id: string, isRead: boolean): Promise<void> {
  const token = getAdminToken();
  const res = await fetch(`/api/admin/prayers/${id}/read`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ isRead }),
  });
  if (!res.ok) throw new Error("Failed to update prayer request");
}

async function deletePrayer(id: string): Promise<void> {
  const token = getAdminToken();
  const res = await fetch(`/api/admin/prayers/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to delete prayer request");
}

export default function PrayersPage() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const { toast } = useToast();
  const qc = useQueryClient();

  const unreadOnly = filter === "unread";

  const { data, isLoading, error } = useQuery({
    queryKey: ["prayers", page, unreadOnly],
    queryFn: () => fetchPrayers(page, unreadOnly),
    refetchInterval: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["prayers"] });

  const readMut = useMutation({
    mutationFn: ({ id, isRead }: { id: string; isRead: boolean }) => markRead(id, isRead),
    onSuccess: invalidate,
    onError: () => toast({ title: "Failed to update prayer request", variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: deletePrayer,
    onSuccess: invalidate,
    onError: () => toast({ title: "Failed to delete prayer request", variant: "destructive" }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / 25)) : 1;

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Prayer Requests</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Prayer requests submitted during live services.
          </p>
        </div>
        {data && data.unread > 0 && (
          <Badge variant="destructive" className="text-sm px-3 py-1">
            {data.unread} unread
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Select value={filter} onValueChange={(v) => { setFilter(v as "all" | "unread"); setPage(1); }}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All requests</SelectItem>
            <SelectItem value="unread">Unread only</SelectItem>
          </SelectContent>
        </Select>
        {data && (
          <span className="text-sm text-muted-foreground">
            {data.total} total
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-16 text-muted-foreground">
          Failed to load prayer requests.
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <div className="text-4xl mb-3">🙏</div>
          <p>{filter === "unread" ? "No unread prayer requests." : "No prayer requests yet."}</p>
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="w-28">Time</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((pr) => (
                <TableRow key={pr.id} className={pr.isRead ? "opacity-60" : ""}>
                  <TableCell>
                    {pr.isRead ? (
                      <MailOpen className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Mail className="w-4 h-4 text-primary" />
                    )}
                  </TableCell>
                  <TableCell className="font-medium whitespace-nowrap">
                    {pr.name ?? <span className="text-muted-foreground italic">Anonymous</span>}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <p className="text-sm leading-relaxed line-clamp-3">{pr.message}</p>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {relativeTime(pr.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        title={pr.isRead ? "Mark unread" : "Mark read"}
                        onClick={() => readMut.mutate({ id: pr.id, isRead: !pr.isRead })}
                        disabled={readMut.isPending}
                      >
                        {pr.isRead ? (
                          <Mail className="w-4 h-4" />
                        ) : (
                          <MailOpen className="w-4 h-4" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => {
                          if (window.confirm("Delete this prayer request?")) {
                            deleteMut.mutate(pr.id);
                          }
                        }}
                        disabled={deleteMut.isPending}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
