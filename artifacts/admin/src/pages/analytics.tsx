import { useEffect, useState } from "react";
import { useGetAnalytics, getGetAnalyticsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "@/lib/recharts-shim";
import { Eye, Users, Clock, Video, AlertCircle, RefreshCw, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function csvEscape(v: unknown) {
  if (v == null) return "";
  let s = String(v);
  // CSV/spreadsheet formula-injection guard: a cell whose first non-whitespace
  // character is =, +, -, @, TAB, or CR can be interpreted as a formula by
  // Excel / Google Sheets / Numbers when the file is opened. Prefix with a
  // single quote so the value is always rendered as text. See OWASP "CSV
  // Injection" / CWE-1236.
  if (/^\s*[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

function fmtUpdatedAgo(ms: number) {
  if (!ms) return "never";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function Analytics() {
  const [period, setPeriod] = useState<"7d" | "30d" | "90d">("30d");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useGetAnalytics(
    { period },
    {
      query: {
        queryKey: getGetAnalyticsQueryKey({ period }),
        // 60s when auto-refresh is on; manual otherwise. Background tab pauses
        // automatically (React Query default behaviour).
        refetchInterval: autoRefresh ? 60_000 : false,
      },
    },
  );
  const { toast } = useToast();

  // Re-render once a minute so "Last updated Xm ago" stays current even when
  // the data itself isn't refetching.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const exportTopVideos = () => {
    const top = Array.isArray(data?.topVideos) ? data!.topVideos : [];
    if (top.length === 0) {
      toast({ title: "Nothing to export", description: "No top-video data available yet." });
      return;
    }
    const header = ["rank", "title", "youtube_id", "views"].join(",");
    const rows = top.map((v: { title: string; youtubeId: string; views: number }, i: number) =>
      [String(i + 1), v.title, v.youtubeId, String(v.views)].map(csvEscape).join(","),
    );
    const csv = [header, ...rows].join("\r\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBlob(`temple-tv-top-videos-${period}-${stamp}.csv`, csv);
    toast({ title: `Exported ${top.length} videos` });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground mt-1">Platform metrics and viewer engagement.</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Updated {fmtUpdatedAgo(dataUpdatedAt)}</span>
          </div>
          <div className="flex items-center gap-2 px-3 h-9 rounded-md border bg-card">
            <Switch
              id="auto-refresh"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            <Label htmlFor="auto-refresh" className="text-xs cursor-pointer">
              Auto-refresh
            </Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportTopVideos}
            disabled={!data || isLoading}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Export top videos
          </Button>
          <Select value={period} onValueChange={(v: "7d" | "30d" | "90d") => setPeriod(v)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Select Period" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="30d">Last 30 Days</SelectItem>
              <SelectItem value="90d">Last 90 Days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isError && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="flex-1">
            <p className="font-medium text-destructive">Analytics unavailable</p>
            <p className="text-muted-foreground mt-0.5">Could not load analytics data from the server.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
          </Button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Total Views", value: data?.totalViews, icon: Eye, format: (v: number) => v.toLocaleString() },
          { label: "Unique Viewers", value: data?.uniqueViewers, icon: Users, format: (v: number) => v.toLocaleString() },
          { label: "Avg Watch Time", value: data?.avgWatchTimeMinutes, icon: Clock, format: (v: number) => `${v}m` },
          { label: "Live Events", value: data?.liveStreamEvents, icon: Video, format: (v: number) => String(v) },
        ].map(({ label, value, icon: Icon, format }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-8 w-24" /> : (
                <div className="text-2xl font-bold">{value != null ? format(value) : "—"}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="col-span-2">
          <CardHeader>
            <CardTitle>Daily Views</CardTitle>
            <CardDescription>App views tracked per day in the selected period</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-[300px] w-full" /> : (
              <div className="h-[300px] w-full mt-4">
                {(!Array.isArray(data?.dailyViews) || data.dailyViews.every((d: { date: string; views: number }) => d.views === 0)) ? (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-2">
                    <Eye className="w-10 h-10 opacity-20" />
                    <p className="text-sm">No views recorded in this period yet</p>
                    <p className="text-xs opacity-70">Views are tracked as members watch content in the app</p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.dailyViews}>
                      <defs>
                        <linearGradient id="colorViews" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" stroke="#888888" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val: string | number) => {
                        const d = new Date(val);
                        return Number.isNaN(d.getTime()) ? String(val ?? "") : d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
                      }} />
                      <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                      <RechartsTooltip 
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '0.5rem' }}
                        itemStyle={{ color: 'hsl(var(--foreground))' }}
                        labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '0.25rem' }}
                        labelFormatter={(val: string | number) => {
                          const d = new Date(val);
                          return Number.isNaN(d.getTime()) ? String(val ?? "") : d.toLocaleDateString();
                        }}
                        formatter={(val: number) => [val.toLocaleString(), "Views"]}
                      />
                      <Area type="monotone" dataKey="views" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorViews)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Category Breakdown</CardTitle>
            <CardDescription>Content distribution by type</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : (
              <div className="space-y-4 mt-4">
                {(Array.isArray(data?.categoryBreakdown) ? data.categoryBreakdown : []).map((cat: { category: string; count: number; percentage: number }) => (
                  <div key={cat.category} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium capitalize">{cat.category}</span>
                      <span className="text-muted-foreground">{cat.count} ({cat.percentage}%)</span>
                    </div>
                    <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary transition-all" style={{ width: `${cat.percentage}%` }} />
                    </div>
                  </div>
                ))}
                {(!Array.isArray(data?.categoryBreakdown) || data.categoryBreakdown.length === 0) && (
                  <div className="text-center py-8 text-muted-foreground text-sm">No videos imported yet</div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top Performing Videos</CardTitle>
          <CardDescription>Most viewed content in your library (all-time)</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : (
            <div className="divide-y">
              {(Array.isArray(data?.topVideos) ? data.topVideos : []).map((video: { youtubeId: string; thumbnailUrl: string; title: string; views: number }, index: number) => (
                <div key={video.youtubeId} className="py-3 flex items-center gap-4 group">
                  <div className="w-8 text-center font-bold text-muted-foreground group-hover:text-primary">{index + 1}</div>
                  <div className="w-24 h-14 rounded overflow-hidden bg-muted shrink-0">
                    <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{video.title}</div>
                  </div>
                  <div className="flex items-center gap-1 font-medium bg-muted/50 px-3 py-1 rounded-md text-sm">
                    <Eye className="w-4 h-4 text-muted-foreground" />
                    {video.views.toLocaleString()}
                  </div>
                </div>
              ))}
              {(!Array.isArray(data?.topVideos) || data.topVideos.length === 0) && (
                <div className="text-center py-8 text-muted-foreground text-sm">No view data available yet</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
