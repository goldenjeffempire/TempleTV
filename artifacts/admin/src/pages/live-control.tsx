import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Radio, Smartphone, Globe, Tv, Mic, Users } from "lucide-react";
import { toast } from "sonner";

interface LiveOverride {
  id: string;
  title: string;
  isActive: boolean;
  hlsStreamUrl: string | null;
  rtmpIngestKey: string | null;
  streamNotes: string | null;
  startedAt: string;
  endsAt: string | null;
}

function elapsed(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const h = Math.floor(secs / 3600),
    m = Math.floor((secs % 3600) / 60),
    s = secs % 60;
  if (h > 0) return `${h}h ${m}m on air`;
  if (m > 0) return `${m}m ${s}s on air`;
  return `${s}s on air`;
}

export default function LiveControl() {
  const [activeOverride, setActiveOverride] = useState<LiveOverride | null>(null);
  const [allOverrides, setAllOverrides] = useState<LiveOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [connectedClients, setConnectedClients] = useState<number | null>(null);
  const [elapsedStr, setElapsedStr] = useState("");

  const [form, setForm] = useState({
    title: "",
    hlsStreamUrl: "",
    rtmpIngestKey: "",
    streamNotes: "",
    durationMins: "",
  });

  const esRef = useRef<EventSource | null>(null);

  const fetchOverrides = async () => {
    try {
      const res = await fetch("/api/admin/live-overrides");
      if (res.ok) {
        const data = (await res.json()) as LiveOverride[];
        setAllOverrides(data);
        setActiveOverride(data.find((o) => o.isActive) ?? null);
      } else if (res.status === 401) {
        toast.error("Authentication failed. Please re-enter your admin token.");
      }
    } catch {
      toast.error("Failed to load broadcast state");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverrides();
  }, []);

  useEffect(() => {
    if (!activeOverride) {
      setElapsedStr("");
      return;
    }
    const tick = () => setElapsedStr(elapsed(activeOverride.startedAt));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [activeOverride]);

  useEffect(() => {
    const es = new EventSource("/api/broadcast/events");
    esRef.current = es;
    es.addEventListener("broadcast-current-updated", () => fetchOverrides());
    return () => es.close();
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const data = (await res.json()) as { sseClients?: number };
          if (typeof data.sseClients === "number") setConnectedClients(data.sseClients);
        }
      } catch {
        // health probe failures are non-critical
      }
    };
    poll();
    const i = setInterval(poll, 10_000);
    return () => clearInterval(i);
  }, []);

  const goLive = async () => {
    if (!form.title.trim()) return;
    setStarting(true);
    try {
      const endsAt = form.durationMins
        ? new Date(Date.now() + Number(form.durationMins) * 60 * 1000).toISOString()
        : null;
      const res = await fetch("/api/admin/live-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          hlsStreamUrl: form.hlsStreamUrl || null,
          rtmpIngestKey: form.rtmpIngestKey || null,
          streamNotes: form.streamNotes || null,
          endsAt,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("🔴 Broadcast pushed to all platforms");
      setForm({ title: "", hlsStreamUrl: "", rtmpIngestKey: "", streamNotes: "", durationMins: "" });
      await fetchOverrides();
    } catch {
      toast.error("Failed to start broadcast");
    } finally {
      setStarting(false);
    }
  };

  const endBroadcast = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/live-overrides/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });
      if (!res.ok) throw new Error();
      toast.success("Broadcast ended");
      await fetchOverrides();
    } catch {
      toast.error("Failed to end broadcast");
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6 max-w-5xl space-y-6">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const platforms = [
    { icon: Smartphone, label: "Mobile", desc: "iOS & Android via HLS player" },
    { icon: Globe, label: "Web", desc: "Browser HLS or YouTube embed" },
    { icon: Tv, label: "Smart TV", desc: "TV web app via YouTube iframe" },
    { icon: Mic, label: "Radio", desc: "Audio-only from same stream" },
  ];

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Live Control</h1>
        <p className="text-muted-foreground mt-1">
          Override the schedule and push a live broadcast to every Temple TV surface.
        </p>
      </div>

      {/* Live Status Banner */}
      <Card
        className={
          activeOverride
            ? "border-red-500/40 bg-red-500/5"
            : ""
        }
      >
        <CardContent className="p-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              {activeOverride ? (
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                </span>
              ) : (
                <Radio className="h-5 w-5 text-muted-foreground" />
              )}
              <div>
                <h2 className="text-xl font-bold">
                  {activeOverride ? "LIVE ON AIR" : "Off Air"}
                </h2>
                {activeOverride && (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {activeOverride.title} · {elapsedStr}
                  </p>
                )}
              </div>
            </div>
            {connectedClients !== null && (
              <div className="text-right flex items-center gap-2">
                <Users className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="text-2xl font-bold leading-tight">{connectedClients}</div>
                  <div className="text-xs text-muted-foreground">Connected viewers</div>
                </div>
              </div>
            )}
          </div>

          {activeOverride && (
            <>
              <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {activeOverride.hlsStreamUrl && (
                  <div className="rounded-lg border bg-card p-3">
                    <div className="text-xs text-muted-foreground mb-1">HLS Stream URL</div>
                    <div className="text-xs font-mono truncate">{activeOverride.hlsStreamUrl}</div>
                  </div>
                )}
                {activeOverride.rtmpIngestKey && (
                  <div className="rounded-lg border bg-card p-3">
                    <div className="text-xs text-muted-foreground mb-1">RTMP Key</div>
                    <div className="text-xs font-mono">
                      ••••••••{activeOverride.rtmpIngestKey.slice(-4)}
                    </div>
                  </div>
                )}
                {activeOverride.endsAt && (
                  <div className="rounded-lg border bg-card p-3">
                    <div className="text-xs text-muted-foreground mb-1">Scheduled End</div>
                    <div className="text-xs">
                      {new Date(activeOverride.endsAt).toLocaleTimeString()}
                    </div>
                  </div>
                )}
              </div>
              <Button
                variant="destructive"
                className="mt-4"
                onClick={() => endBroadcast(activeOverride.id)}
              >
                End Broadcast
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Start Broadcast Form */}
      {!activeOverride && (
        <Card>
          <CardHeader>
            <CardTitle>Start a Live Broadcast</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Going live instantly overrides the scheduled queue on all platforms — mobile, web,
              Smart TV, and radio mode.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bc-title">Broadcast Title *</Label>
              <Input
                id="bc-title"
                placeholder="e.g. Sunday Service — Live"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="bc-hls">HLS Stream URL</Label>
                <Input
                  id="bc-hls"
                  type="url"
                  placeholder="https://… .m3u8 (or leave empty for YouTube live)"
                  value={form.hlsStreamUrl}
                  onChange={(e) => setForm((f) => ({ ...f, hlsStreamUrl: e.target.value }))}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Mux, Cloudflare Stream, Wowza, or any HLS source.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bc-rtmp">RTMP Ingest Key</Label>
                <Input
                  id="bc-rtmp"
                  placeholder="Stream key from your RTMP provider"
                  value={form.rtmpIngestKey}
                  onChange={(e) => setForm((f) => ({ ...f, rtmpIngestKey: e.target.value }))}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Stored for reference; ingestion uses your encoder.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="bc-dur">Auto-end after (minutes)</Label>
                <Input
                  id="bc-dur"
                  type="number"
                  min="1"
                  placeholder="e.g. 120"
                  value={form.durationMins}
                  onChange={(e) => setForm((f) => ({ ...f, durationMins: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bc-notes">Internal Notes</Label>
                <Input
                  id="bc-notes"
                  placeholder="e.g. Pastor John preaching — Youth Sunday"
                  value={form.streamNotes}
                  onChange={(e) => setForm((f) => ({ ...f, streamNotes: e.target.value }))}
                />
              </div>
            </div>
            <Card className="bg-muted/30">
              <CardContent className="p-4">
                <h4 className="text-sm font-semibold mb-2">How sync works</h4>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>• Going live instantly pushes broadcast state to every connected client via Server-Sent Events.</li>
                  <li>• Mobile, Smart TV, web, and radio mode all switch to this stream within seconds.</li>
                  <li>• If an HLS URL is provided, all platforms play it directly — zero re-encoding delay.</li>
                  <li>• If no HLS URL, platforms fall back to YouTube Live detection via the YouTube Data API.</li>
                </ul>
              </CardContent>
            </Card>
            <Button
              size="lg"
              onClick={goLive}
              disabled={starting || !form.title.trim()}
              className="bg-red-600 hover:bg-red-500 text-white"
            >
              {starting ? "Starting…" : "🔴 Go Live — Push to All Platforms"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Architecture */}
      <Card>
        <CardHeader>
          <CardTitle>Broadcast Architecture</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {platforms.map((p) => (
              <div
                key={p.label}
                className="rounded-lg border bg-card p-4 text-center"
              >
                <p.icon className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                <div className="text-sm font-semibold">{p.label}</div>
                <div className="text-xs text-muted-foreground mt-1">{p.desc}</div>
                <Badge
                  variant={activeOverride ? "default" : "outline"}
                  className="mt-2 text-xs"
                >
                  {activeOverride ? "In Sync" : "Standby"}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* History */}
      {allOverrides.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Broadcast History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {allOverrides.slice(0, 10).map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between py-2 border-b last:border-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={o.isActive ? "destructive" : "secondary"}>
                      {o.isActive ? "LIVE" : "ended"}
                    </Badge>
                    <span className="text-sm truncate">{o.title}</span>
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap ml-3">
                    {new Date(o.startedAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
