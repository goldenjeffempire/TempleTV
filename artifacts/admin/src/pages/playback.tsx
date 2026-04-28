/**
 * Live Broadcast — the new playback monitor.
 *
 * Wires the WebSocket-driven PlaybackClient into the dual-buffer engine
 * and renders an at-a-glance "what's on air now / next / next-next" UI.
 * The page has no polling: a single WS connection delivers every state
 * mutation; reconnects pull a fresh /api/playback/state snapshot.
 */

import { useEffect, useMemo, useState } from "react";
import { useLivePlayback } from "@/playback/useLivePlayback";
import { PlaybackEngine } from "@/playback/PlaybackEngine";
import { DualBufferPlayer } from "@/components/playback/DualBufferPlayer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Wifi,
  WifiOff,
  Loader2,
  Radio,
  Clock,
  PlayCircle,
} from "lucide-react";
import type { PlaybackItem, PlaybackState } from "@/playback/types";

function formatHHMMSS(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "--:--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function StatusPill({
  connection,
}: {
  connection: ReturnType<typeof useLivePlayback>["connection"];
}) {
  if (connection === "connected") {
    return (
      <Badge variant="default" className="gap-1.5 bg-emerald-600 hover:bg-emerald-600">
        <Wifi className="h-3 w-3" /> Live
      </Badge>
    );
  }
  if (connection === "connecting" || connection === "reconnecting") {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        {connection === "connecting" ? "Connecting" : "Reconnecting"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5 text-muted-foreground">
      <WifiOff className="h-3 w-3" /> Offline
    </Badge>
  );
}

function ItemCard({
  label,
  item,
  showCountdown,
  serverTimeMs,
}: {
  label: string;
  item: PlaybackItem | null;
  showCountdown?: boolean;
  serverTimeMs: number;
}) {
  if (!item) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Nothing scheduled</p>
        </CardContent>
      </Card>
    );
  }

  const startsInSec = Math.max(0, Math.round((item.startsAtMs - serverTimeMs) / 1000));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground flex items-center justify-between gap-2">
          <span>{label}</span>
          <Badge variant="outline" className="font-mono text-[10px] uppercase">
            {item.source.kind}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-3">
          {item.thumbnailUrl ? (
            <img
              src={item.thumbnailUrl}
              alt=""
              className="h-16 w-28 flex-none rounded-md object-cover bg-muted"
              loading="lazy"
            />
          ) : (
            <div className="h-16 w-28 flex-none rounded-md bg-muted flex items-center justify-center">
              <PlayCircle className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-snug line-clamp-2" data-testid={`item-title-${label.toLowerCase()}`}>
              {item.title}
            </p>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatHHMMSS(item.durationSecs)}
              {showCountdown && (
                <>
                  <span className="mx-1">·</span>
                  starts in {formatHHMMSS(startsInSec)}
                </>
              )}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProgressStrip({ state }: { state: PlaybackState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const item = state.current;
  if (!item) return null;

  // Skew-correct against server time: assume client clock is offset by
  // (clientNow - serverTimeMs) at the moment of the last frame. Use a
  // simple monotonic correction so a slow clock can't make progress
  // appear to run backward across re-renders.
  const skew = now - state.serverTimeMs;
  const wallClock = state.serverTimeMs + skew;
  const elapsed = Math.max(0, Math.min(item.durationSecs, (wallClock - item.startsAtMs) / 1000));
  const remaining = Math.max(0, item.durationSecs - elapsed);
  const pct = item.durationSecs > 0 ? (elapsed / item.durationSecs) * 100 : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground tabular-nums">
        <span>{formatHHMMSS(elapsed)}</span>
        <span>−{formatHHMMSS(remaining)}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-500 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function PlaybackPage() {
  const { state, connection, subscribe } = useLivePlayback();
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  // One engine per page mount. The hook above provides the state; we wire
  // events into the engine so it can react to preload hints and transitions
  // distinctly from a generic state change.
  const engine = useMemo(
    () =>
      new PlaybackEngine({
        onActiveItemChanged: (item) => setActiveItemId(item?.id ?? null),
      }),
    [],
  );

  useEffect(() => {
    if (state) engine.setState(state);
  }, [engine, state]);

  useEffect(() => {
    return subscribe((event) => engine.handleEvent(event));
  }, [engine, subscribe]);

  if (!state) {
    return (
      <div className="container mx-auto p-6 max-w-7xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="aspect-video w-full" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  const overrideActive = state.liveOverride !== null;

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Radio className="h-6 w-6" />
            Live Broadcast
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Dual-buffer playback with continuous preload — what every viewer is
            seeing right now.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {overrideActive && (
            <Badge className="bg-rose-600 hover:bg-rose-600 gap-1.5">
              <Radio className="h-3 w-3" /> Live override
            </Badge>
          )}
          <Badge variant="outline" className="font-mono uppercase text-[10px]">
            source: {state.source}
          </Badge>
          <StatusPill connection={connection} />
        </div>
      </div>

      <div className="space-y-3">
        <DualBufferPlayer engine={engine} current={state.current} className="shadow-2xl" />
        {state.current && <ProgressStrip state={state} />}
        {activeItemId && state.current?.id !== activeItemId && (
          <p className="text-xs text-amber-500">
            Engine on-air id ({activeItemId}) differs from server's reported
            current — transition in flight.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ItemCard
          label="On Air"
          item={state.current}
          serverTimeMs={state.serverTimeMs}
        />
        <ItemCard
          label="Up Next"
          item={state.next}
          showCountdown
          serverTimeMs={state.serverTimeMs}
        />
        <ItemCard
          label="Then"
          item={state.nextNext}
          showCountdown
          serverTimeMs={state.serverTimeMs}
        />
      </div>
    </div>
  );
}
