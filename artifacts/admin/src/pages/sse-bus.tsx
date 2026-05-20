import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSSE } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Zap, Trash2, Wifi, WifiOff } from "lucide-react";

interface SSEEventLog {
  id: string;
  type: string;
  data: unknown;
  ts: number;
}

export default function SseBusPage() {
  const { state, lastStatusPayload } = useSSE();
  const [events, setEvents] = useState<SSEEventLog[]>([]);
  const [paused, setPaused] = useState(false);
  const maxEvents = 100;
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<SSEEventLog[]>([]);

  const { data: busStats } = useQuery({
    queryKey: ["sse-bus-stats"],
    queryFn: () => api.get<{ connectedClients: number; eventsPerMinute: number; channels: string[] }>("/admin/sse-bus").catch(() => null),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    // Listen to native SSE events for live display
    const handler = (e: MessageEvent) => {
      if (paused) return;
      const entry: SSEEventLog = { id: `${Date.now()}-${Math.random()}`, type: e.type || "message", data: e.data, ts: Date.now() };
      eventsRef.current = [entry, ...eventsRef.current].slice(0, maxEvents);
      setEvents([...eventsRef.current]);
    };
    window.addEventListener("sse-event", handler as EventListener);
    return () => window.removeEventListener("sse-event", handler as EventListener);
  }, [paused, maxEvents]);

  // Track SSE status payload changes as a synthetic event
  useEffect(() => {
    if (!lastStatusPayload || paused) return;
    const entry: SSEEventLog = { id: `status-${Date.now()}`, type: "status", data: lastStatusPayload, ts: Date.now() };
    eventsRef.current = [entry, ...eventsRef.current].slice(0, maxEvents);
    setEvents([...eventsRef.current]);
  }, [lastStatusPayload, paused, maxEvents]);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader title="SSE Event Bus" description="Live view of server-sent events flowing through the system." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 flex items-center gap-3">
            {state === "connected" ? <Wifi size={18} className="text-green-500" /> : <WifiOff size={18} className="text-red-500" />}
            <div>
              <p className="font-semibold text-sm capitalize">{state}</p>
              <p className="text-xs text-muted-foreground">SSE connection</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold">{busStats?.connectedClients ?? "—"}</p>
            <p className="text-xs text-muted-foreground">Connected clients</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold">{events.length}</p>
            <p className="text-xs text-muted-foreground">Events captured</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2"><Zap size={15} /> Event Stream</CardTitle>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch id="pause" checked={paused} onCheckedChange={setPaused} />
                <Label htmlFor="pause" className="text-xs">{paused ? "Paused" : "Live"}</Label>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => { eventsRef.current = []; setEvents([]); }}>
                <Trash2 size={13} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Zap size={24} className="text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">Waiting for SSE events…</p>
              <p className="text-xs text-muted-foreground">Events will appear here as they arrive from the server.</p>
            </div>
          ) : (
            <ScrollArea className="h-[480px]" ref={scrollRef as React.RefObject<HTMLDivElement>}>
              <div className="divide-y font-mono text-xs">
                {events.map(e => (
                  <div key={e.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30">
                    <span className="text-muted-foreground/50 flex-shrink-0 w-20 text-[10px] pt-0.5">
                      {new Date(e.ts).toLocaleTimeString()}
                    </span>
                    <Badge variant="outline" className="text-[10px] flex-shrink-0 capitalize">{e.type}</Badge>
                    <span className="text-muted-foreground break-all flex-1 text-[11px]">
                      {typeof e.data === "string" ? e.data : JSON.stringify(e.data)}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
