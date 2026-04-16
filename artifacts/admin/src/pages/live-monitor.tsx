import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Radio,
  RefreshCw,
  Signal,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-access";

interface LiveEventRecord {
  ts: number;
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  method: string | null;
}

interface LiveHealthData {
  current: {
    isLive: boolean;
    videoId: string | null;
    title: string | null;
    checkedAt: number;
    staleSec: number;
    detectionMethod?: string;
    uptimeSecs: number;
    liveSessionStartedAt: number | null;
  };
  polling: {
    intervalMs: number;
    mode: "normal" | "burst";
    lastStateChangeAt: number;
  };
  history: LiveEventRecord[];
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function formatTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function UptimeClock({ startSecs }: { startSecs: number }) {
  const [elapsed, setElapsed] = useState(startSecs);
  useEffect(() => {
    setElapsed(startSecs);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [startSecs]);
  return <span>{formatDuration(elapsed)}</span>;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function apiUrl(path: string) {
  return `${BASE.replace(/\/admin\/?$/, "")}/api${path}`;
}

export default function LiveMonitor() {
  const { toast } = useToast();
  const [data, setData] = useState<LiveHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const [sseError, setSseError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [alertVisible, setAlertVisible] = useState(false);
  const prevIsLive = useRef<boolean | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchHealth = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const token = getAdminToken();
      const headers: HeadersInit = token ? { "X-Admin-Token": token } : {};
      const res = await fetch(apiUrl("/admin/live/health"), { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LiveHealthData;
      setData(json);
    } catch {
      if (!silent) {
        toast({ title: "Failed to load live health data", variant: "destructive" });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(() => fetchHealth(true), 10000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  useEffect(() => {
    const token = getAdminToken();
    const url = token
      ? `${apiUrl("/youtube/live/events")}?token=${encodeURIComponent(token)}`
      : apiUrl("/youtube/live/events");

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setSseConnected(true);
      setSseError(false);
    };

    es.addEventListener("connected", () => {
      setSseConnected(true);
      setSseError(false);
    });

    es.addEventListener("yt-status", (e) => {
      const payload = JSON.parse((e as MessageEvent).data) as {
        isLive: boolean;
        videoId: string | null;
        title: string | null;
      };

      if (prevIsLive.current !== null && prevIsLive.current !== payload.isLive) {
        if (!payload.isLive) {
          setAlertVisible(true);
          toast({
            title: "⚠️ Stream went offline",
            description: "Temple TV is no longer live.",
            variant: "destructive",
          });
          setTimeout(() => setAlertVisible(false), 8000);
        } else {
          toast({
            title: "🔴 Stream is LIVE!",
            description: payload.title ?? "Temple TV has started a live stream.",
          });
        }
      }
      prevIsLive.current = payload.isLive;
      fetchHealth(true);
    });

    es.addEventListener("heartbeat", () => {
      setSseConnected(true);
    });

    es.onerror = () => {
      setSseConnected(false);
      setSseError(true);
    };

    return () => {
      es.close();
    };
  }, [fetchHealth, toast]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Stream Monitor</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Real-time health monitoring for the Temple TV YouTube live stream
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border ${
            sseConnected
              ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
              : sseError
              ? "bg-red-500/10 text-red-500 border-red-500/20"
              : "bg-amber-500/10 text-amber-600 border-amber-500/20"
          }`}>
            {sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {sseConnected ? "Real-time" : sseError ? "SSE Error" : "Connecting…"}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fetchHealth()}
            disabled={refreshing}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {alertVisible && (
        <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/25 rounded-lg px-4 py-3 text-red-600">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <p className="font-semibold text-sm">Stream Offline Alert</p>
            <p className="text-xs text-red-500/80">The live stream has gone offline. Check YouTube Studio for details.</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <div className="h-4 bg-muted rounded animate-pulse mb-3 w-1/2" />
                <div className="h-7 bg-muted rounded animate-pulse w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className={data.current.isLive ? "border-red-500/40 bg-red-500/5" : ""}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Stream Status</span>
                  <Radio className={`w-4 h-4 ${data.current.isLive ? "text-red-500" : "text-muted-foreground"}`} />
                </div>
                <div className={`text-2xl font-bold ${data.current.isLive ? "text-red-500" : "text-foreground"}`}>
                  {data.current.isLive ? "LIVE" : "OFF AIR"}
                </div>
                {data.current.isLive && (
                  <p className="text-xs text-muted-foreground mt-1 truncate">{data.current.title}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Stream Uptime</span>
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-bold font-mono">
                  {data.current.isLive && data.current.uptimeSecs > 0 ? (
                    <UptimeClock startSecs={data.current.uptimeSecs} />
                  ) : (
                    <span className="text-muted-foreground text-lg">—</span>
                  )}
                </div>
                {data.current.liveSessionStartedAt && data.current.isLive && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Since {formatTime(data.current.liveSessionStartedAt)}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Check</span>
                  <Activity className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-bold">
                  {data.current.staleSec}s ago
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  via {data.current.detectionMethod ?? "—"}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Poll Interval</span>
                  <Zap className={`w-4 h-4 ${data.polling.mode === "burst" ? "text-amber-500" : "text-muted-foreground"}`} />
                </div>
                <div className="text-2xl font-bold">
                  {data.polling.intervalMs / 1000}s
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  <Badge
                    variant="secondary"
                    className={`text-xs ${data.polling.mode === "burst" ? "bg-amber-500/10 text-amber-600 border-amber-500/20" : ""}`}
                  >
                    {data.polling.mode === "burst" ? "⚡ Burst mode" : "Normal mode"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </div>

          {data.current.isLive && data.current.videoId && (
            <Card className="border-red-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  Currently Live
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-4">
                  <img
                    src={`https://img.youtube.com/vi/${data.current.videoId}/mqdefault.jpg`}
                    alt="Live thumbnail"
                    className="w-40 h-24 object-cover rounded-md border shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-base leading-tight mb-2">
                      {data.current.title ?? "Untitled stream"}
                    </p>
                    <p className="text-xs text-muted-foreground mb-3">
                      Video ID: <code className="font-mono bg-muted px-1 py-0.5 rounded">{data.current.videoId}</code>
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      <a
                        href={`https://www.youtube.com/watch?v=${data.current.videoId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button size="sm" variant="outline">
                          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                          Watch on YouTube
                        </Button>
                      </a>
                      <a
                        href={`https://studio.youtube.com/video/${data.current.videoId}/livestreaming`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button size="sm" variant="outline">
                          <Signal className="w-3.5 h-3.5 mr-1.5" />
                          YouTube Studio
                        </Button>
                      </a>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Event History</CardTitle>
            </CardHeader>
            <CardContent>
              {data.history.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground text-sm">
                  <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  No state changes recorded yet. Events appear here when the stream goes live or offline.
                </div>
              ) : (
                <div className="space-y-2">
                  {data.history.map((event, i) => (
                    <div
                      key={event.ts}
                      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border text-sm ${
                        i === 0 ? "bg-muted/60" : ""
                      }`}
                    >
                      <div className="mt-0.5 shrink-0">
                        {event.isLive ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <WifiOff className="w-4 h-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant="secondary"
                            className={
                              event.isLive
                                ? "bg-red-500/10 text-red-600 border-red-500/20 text-xs"
                                : "text-xs"
                            }
                          >
                            {event.isLive ? "Went Live" : "Went Offline"}
                          </Badge>
                          {i === 0 && (
                            <Badge variant="outline" className="text-xs">Latest</Badge>
                          )}
                          {event.method && (
                            <span className="text-xs text-muted-foreground">
                              via <code className="font-mono">{event.method}</code>
                            </span>
                          )}
                        </div>
                        {event.title && (
                          <p className="text-xs text-muted-foreground mt-1 truncate">{event.title}</p>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0 text-right">
                        {formatDateTime(event.ts)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Polling Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Current Mode</p>
                  <p className="font-medium capitalize">{data.polling.mode}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Check Interval</p>
                  <p className="font-medium">{formatDuration(data.polling.intervalMs / 1000)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Last State Change</p>
                  <p className="font-medium">
                    {data.polling.lastStateChangeAt
                      ? formatDateTime(data.polling.lastStateChangeAt)
                      : "None yet"}
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
                Normal mode polls every 60 seconds. Burst mode (15s interval) activates for 10 minutes after any state
                change to quickly detect transitions between live and offline.
              </p>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="flex items-center gap-3 py-6 text-muted-foreground">
            <AlertTriangle className="w-5 h-5" />
            <span>Failed to load monitoring data. Check that the API server is running.</span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
