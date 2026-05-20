import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Upload, Users, Calendar, Settings2, Zap,
  RefreshCw, Search, Clock, Download,
} from "lucide-react";
import { exportRowsAsCsv } from "@/lib/csv-export";
import { toast } from "sonner";

type EntryType = "video_uploaded" | "video_transcoded" | "user_created" | "schedule_added" | "config_changed";

interface AuditEntry {
  id: string;
  type: EntryType;
  timestamp: string;
  actor: string | null;
  title: string;
  description: string;
  meta?: Record<string, unknown>;
}

const TYPE_META: Record<EntryType, { label: string; icon: React.ReactNode; color: string }> = {
  video_uploaded: {
    label: "Video Uploaded",
    icon: <Upload size={14} />,
    color: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  video_transcoded: {
    label: "Transcoding Done",
    icon: <Zap size={14} />,
    color: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  },
  user_created: {
    label: "User Registered",
    icon: <Users size={14} />,
    color: "bg-green-500/10 text-green-400 border-green-500/20",
  },
  schedule_added: {
    label: "Scheduled",
    icon: <Calendar size={14} />,
    color: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  config_changed: {
    label: "Config Changed",
    icon: <Settings2 size={14} />,
    color: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  },
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const meta = TYPE_META[entry.type];
  const ts = new Date(entry.timestamp);

  return (
    <div className="flex items-start gap-4 p-4 rounded-lg border border-border/50 bg-card/50 hover:bg-card transition-colors">
      {/* Icon */}
      <div className={`mt-0.5 p-2 rounded-lg border flex-shrink-0 ${meta.color}`}>
        {meta.icon}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-foreground">{entry.title}</span>
          <Badge variant="outline" className={`text-[10px] h-4 px-1.5 border ${meta.color}`}>
            {meta.label}
          </Badge>
          {entry.actor && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {entry.actor}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-0.5 truncate">{entry.description}</p>
        {entry.meta && (
          <div className="flex gap-3 mt-1 flex-wrap">
            {Object.entries(entry.meta)
              .filter(([, v]) => v != null && v !== "")
              .slice(0, 4)
              .map(([k, v]) => (
                <span key={k} className="text-[11px] text-muted-foreground/60">
                  {k}: <span className="text-muted-foreground">{String(v)}</span>
                </span>
              ))}
          </div>
        )}
      </div>

      {/* Timestamp */}
      <div className="flex-shrink-0 text-right">
        <p className="text-xs font-medium text-muted-foreground">{timeAgo(entry.timestamp)}</p>
        <p className="text-[10px] text-muted-foreground/50 mt-0.5">
          {ts.toLocaleDateString()} {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}

export default function AuditLogPage() {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-audit-log", typeFilter, limit],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), type: typeFilter });
      return api.get<{ entries: AuditEntry[]; total: number }>(`/admin/audit-log?${params}`);
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const entries = (data?.entries ?? []).filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.title.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      (e.actor ?? "").toLowerCase().includes(q)
    );
  });

  const typeCounts = (data?.entries ?? []).reduce<Record<string, number>>(
    (acc, e) => { acc[e.type] = (acc[e.type] ?? 0) + 1; return acc; },
    {},
  );

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Recent platform activity across videos, users, schedule, and config.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={entries.length === 0}
            className="gap-2"
            onClick={() => {
              // Export the *filtered* set the operator is currently looking at,
              // not the raw fetch — matches what they see on screen.
              exportRowsAsCsv(
                `temple-tv-audit-log-${new Date().toISOString().slice(0, 10)}`,
                entries,
                [
                  { header: "Timestamp", value: (e) => e.timestamp },
                  { header: "Type", value: (e) => e.type },
                  { header: "Actor", value: (e) => e.actor ?? "" },
                  { header: "Title", value: (e) => e.title },
                  { header: "Description", value: (e) => e.description },
                ],
              );
              toast.success(`Exported ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`);
            }}
            aria-label="Export audit log entries as CSV"
            title="Export CSV"
          >
            <Download size={14} />
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-2"
            aria-label="Refresh audit log"
          >
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats row */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {(Object.entries(TYPE_META) as [EntryType, typeof TYPE_META[EntryType]][]).map(([type, m]) => (
            <Card
              key={type}
              className={`cursor-pointer transition-all border ${typeFilter === type ? "ring-2 ring-primary" : ""}`}
              onClick={() => setTypeFilter(typeFilter === type ? "all" : type)}
            >
              <CardContent className="p-3 flex items-center gap-2.5">
                <div className={`p-1.5 rounded-md border ${m.color}`}>{m.icon}</div>
                <div>
                  <p className="text-lg font-bold leading-none">{typeCounts[type] ?? 0}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-none">{m.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search entries…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-44 h-9">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {(Object.entries(TYPE_META) as [EntryType, typeof TYPE_META[EntryType]][]).map(([type, m]) => (
              <SelectItem key={type} value={type}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
          <SelectTrigger className="w-32 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="50">Last 50</SelectItem>
            <SelectItem value="100">Last 100</SelectItem>
            <SelectItem value="200">Last 200</SelectItem>
          </SelectContent>
        </Select>
        {data && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
            <Clock size={12} />
            <span>{entries.length} of {data.total} entries</span>
          </div>
        )}
      </div>

      {/* Log entries */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-base">Activity Timeline</CardTitle>
          <CardDescription>Newest first · Auto-refreshes every minute</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="flex gap-4">
                  <Skeleton className="w-8 h-8 rounded-lg flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                  <Skeleton className="h-4 w-16 flex-shrink-0" />
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <Clock size={36} className="text-muted-foreground/30" />
              <p className="text-muted-foreground font-medium">No activity found</p>
              <p className="text-sm text-muted-foreground/60">
                {search || typeFilter !== "all"
                  ? "Try adjusting your filters"
                  : "Platform activity will appear here"}
              </p>
            </div>
          ) : (
            <div className="p-4 space-y-2">
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
              {data && entries.length < data.total && (
                <div className="text-center pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setLimit((l) => Math.min(200, l + 100))}
                    className="text-xs text-muted-foreground"
                  >
                    Load more ({data.total - entries.length} remaining)
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
