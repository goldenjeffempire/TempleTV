/**
 * useLiveSync — TV broadcast sync, rebuilt on the new playback WebSocket.
 *
 * The old implementation talked to two now-deleted endpoints:
 *   - GET  /api/broadcast/current   (snapshot)
 *   - SSE  /api/broadcast/events    (push channel)
 *
 * Both have been replaced by a single TV-grade engine:
 *   - GET  /api/playback/state      (snapshot, signed URLs, no 302)
 *   - WS   /api/playback/ws         (push channel, dual-buffer preload hints)
 *
 * The exported `BroadcastSyncState` shape is preserved so every existing
 * consumer (LiveHero, Player, BroadcastChannelBug, useUnifiedLive, etc.)
 * keeps working without changes — this hook acts purely as an adapter
 * between the new wire protocol and the legacy projected shape.
 *
 * The new state additionally exposes a `nextNextItem` slot so a future
 * triple-buffer player can warm three slots simultaneously; existing
 * dual-buffer consumers ignore it harmlessly.
 *
 * Library / schedule revision counters (`libraryRevision`,
 * `scheduleRevision`) and viewer-count are no longer carried on this
 * channel — the new WS is intentionally playback-only. The fields are
 * kept on the type for compatibility but stay at their initial values;
 * consumers that need fresh counts fall back to their own polling
 * cadence (already in place in `useSermons`, `useGuide`, etc.).
 */

import { useEffect, useRef, useState } from "react";

export interface BroadcastNextItem {
  id?: string;
  youtubeId?: string;
  title?: string;
  localVideoUrl?: string | null;
  videoSource?: string;
  thumbnailUrl?: string | null;
  durationSecs?: number;
}

export interface BroadcastSyncState {
  isLive: boolean;
  title: string | null;
  videoId: string | null;
  hlsStreamUrl: string | null;
  liveOverride: {
    id: string;
    title: string;
    hlsStreamUrl?: string | null;
    youtubeVideoId?: string | null;
  } | null;
  ytLive: boolean;
  ytVideoId: string | null;
  ytTitle: string | null;
  syncedAt: string | null;
  serverTimeMs: number | null;
  connected: boolean;
  positionSecs: number | null;
  currentItemEndsAtMs: number | null;
  itemStartEpochSecs: number | null;
  index: number | null;
  totalSecs: number | null;
  queueLength: number | null;
  progressPercent: number | null;
  nextItem: BroadcastNextItem | null;
  /** Triple-buffer slot — the item after `nextItem`. New on the playback WS. */
  nextNextItem: BroadcastNextItem | null;
  viewerCount: number | null;
  payload: Record<string, unknown> | null;
  libraryRevision: number;
  scheduleRevision: number;
}

const INITIAL: BroadcastSyncState = {
  isLive: false,
  title: null,
  videoId: null,
  hlsStreamUrl: null,
  liveOverride: null,
  ytLive: false,
  ytVideoId: null,
  ytTitle: null,
  syncedAt: null,
  serverTimeMs: null,
  connected: false,
  positionSecs: null,
  currentItemEndsAtMs: null,
  itemStartEpochSecs: null,
  index: null,
  totalSecs: null,
  queueLength: null,
  progressPercent: null,
  nextItem: null,
  nextNextItem: null,
  viewerCount: null,
  payload: null,
  libraryRevision: 0,
  scheduleRevision: 0,
};

// ── Wire types: must match `artifacts/api-server/src/playback/types.ts` ──
// Duplicated here (rather than imported) because the TV bundle is shipped
// to Smart-TV runtimes that can't resolve workspace packages at runtime;
// the shapes are stable and minimal so drift is unlikely.
type PlaybackSourceKind = "hls" | "mp4" | "youtube";
interface WirePlaybackSource {
  kind: PlaybackSourceKind;
  url: string;
  expiresAtMs: number | null;
}
interface WirePlaybackItem {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: WirePlaybackSource;
  startsAtMs: number;
  endsAtMs: number;
}
interface WirePlaybackState {
  serverTimeMs: number;
  current: WirePlaybackItem | null;
  next: WirePlaybackItem | null;
  nextNext: WirePlaybackItem | null;
  liveOverride: {
    title: string;
    startedAtMs: number;
    endsAtMs: number | null;
  } | null;
  source: "override" | "schedule" | "queue" | "empty";
}
type WirePlaybackEvent =
  | { type: "state"; reason: string; state: WirePlaybackState }
  | { type: "preload"; leadMs: number; state: WirePlaybackState }
  | { type: "ping"; serverTimeMs: number };

function projectItem(item: WirePlaybackItem | null): BroadcastNextItem | null {
  if (!item) return null;
  const isYoutube = item.source.kind === "youtube";
  return {
    id: item.id,
    youtubeId: isYoutube ? item.source.url : undefined,
    title: item.title,
    thumbnailUrl: item.thumbnailUrl,
    durationSecs: item.durationSecs,
    videoSource: isYoutube ? "youtube" : "local",
    // For mp4/hls the URL is the direct, signed source. The TV's
    // `LiveBroadcastVideo` and `HlsVideoPlayer` consume it as-is — they
    // already detect HLS by the `.m3u8` suffix and route accordingly.
    localVideoUrl: isYoutube ? null : item.source.url,
  };
}

function projectState(
  wire: WirePlaybackState,
  prev: BroadcastSyncState,
): BroadcastSyncState {
  const current = wire.current;
  const liveOverride = wire.liveOverride;

  // `liveOverride` from the new state is a thin metadata window; the
  // original SSE payload carried richer fields (id, hlsStreamUrl,
  // youtubeVideoId). We synthesize equivalents from `current` so the
  // legacy resolver in `useUnifiedLive` keeps working: when the source
  // is "override" and `current.source.kind === "youtube"` the URL is the
  // 11-char videoId; for HLS overrides we surface the direct stream URL.
  const isOverride = wire.source === "override" && !!liveOverride;
  const overrideYoutubeId =
    isOverride && current?.source.kind === "youtube" ? current.source.url : null;
  const overrideHlsUrl =
    isOverride && current?.source.kind === "hls" ? current.source.url : null;

  // Position into the current item: derived from `startsAtMs` against the
  // server's wall clock. The cinematic hero's drift loop will keep things
  // tight from there.
  const positionSecs = current
    ? Math.max(0, (wire.serverTimeMs - current.startsAtMs) / 1000)
    : null;
  const itemStartEpochSecs = current
    ? Math.floor(current.startsAtMs / 1000)
    : null;
  const currentItemEndsAtMs = current ? current.endsAtMs : null;
  const totalSecs = current ? current.durationSecs : null;
  const progressPercent =
    current && current.durationSecs > 0
      ? Math.min(100, (positionSecs! / current.durationSecs) * 100)
      : null;

  const projectedCurrent = projectItem(current);
  const projectedNext = projectItem(wire.next);
  const projectedNextNext = projectItem(wire.nextNext);

  // Project to the legacy `payload` shape so `useLiveSync` consumers that
  // read `payload.item` / `payload.nextItem` directly (Home.tsx) keep
  // rendering correctly.
  const payload: Record<string, unknown> = {
    item: projectedCurrent,
    nextItem: projectedNext,
    upcomingItems: projectedNextNext ? [projectedNext, projectedNextNext] : projectedNext ? [projectedNext] : [],
    positionSecs,
    serverTimeMs: wire.serverTimeMs,
    currentItemEndsAtMs,
    itemStartEpochSecs,
    queueLength: 0,
    totalSecs,
    progressPercent,
    liveOverride: liveOverride
      ? {
          id: "override",
          title: liveOverride.title,
          startedAt: new Date(liveOverride.startedAtMs).toISOString(),
          endsAt: liveOverride.endsAtMs ? new Date(liveOverride.endsAtMs).toISOString() : null,
          hlsStreamUrl: overrideHlsUrl,
          youtubeVideoId: overrideYoutubeId,
        }
      : null,
  };

  return {
    viewerCount: prev.viewerCount,
    libraryRevision: prev.libraryRevision,
    scheduleRevision: prev.scheduleRevision,
    isLive: !!current || isOverride,
    title: liveOverride?.title ?? current?.title ?? null,
    videoId: overrideYoutubeId ?? (current?.source.kind === "youtube" ? current.source.url : null),
    hlsStreamUrl: overrideHlsUrl ?? (current?.source.kind === "hls" ? current.source.url : null),
    liveOverride: liveOverride
      ? {
          id: "override",
          title: liveOverride.title,
          hlsStreamUrl: overrideHlsUrl,
          youtubeVideoId: overrideYoutubeId,
        }
      : null,
    // Channel auto-detect is folded into `liveOverride` on the new server.
    // Without a separate signal we surface `false` here; `useUnifiedLive`
    // already falls back to the 30s `/api/youtube/live/status` poll, so
    // organic-channel-live still resolves — just on the slower path.
    ytLive: false,
    ytVideoId: null,
    ytTitle: null,
    syncedAt: new Date(wire.serverTimeMs).toISOString(),
    serverTimeMs: wire.serverTimeMs,
    connected: true,
    positionSecs,
    currentItemEndsAtMs,
    itemStartEpochSecs,
    index: null,
    totalSecs,
    queueLength: null,
    progressPercent,
    nextItem: projectedNext,
    nextNextItem: projectedNextNext,
    payload,
  };
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/playback/ws`;
}

function stateUrl(): string {
  return `${window.location.origin}/api/playback/state`;
}

const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
const FALLBACK_POLL_MS = 30_000;

export function useLiveSync(): BroadcastSyncState {
  const [state, setState] = useState<BroadcastSyncState>(INITIAL);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(MIN_RETRY_MS);

  useEffect(() => {
    let destroyed = false;

    const apply = (wire: WirePlaybackState) => {
      if (destroyed) return;
      setState((prev) => projectState(wire, prev));
    };

    const fallbackPoll = async () => {
      if (destroyed) return;
      try {
        const res = await fetch(stateUrl(), {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const wire = (await res.json()) as WirePlaybackState;
          apply(wire);
        }
      } catch {
        // Swallow — next interval will retry.
      }
      if (!destroyed) {
        pollTimerRef.current = setTimeout(fallbackPoll, FALLBACK_POLL_MS);
      }
    };

    const connect = () => {
      if (destroyed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        // Browser refused to construct (e.g. mixed-content). Fall back
        // to polling — UI still works, just without live transitions.
        fallbackPoll();
        return;
      }
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        reconnectDelayRef.current = MIN_RETRY_MS;
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      });

      ws.addEventListener("message", (e: MessageEvent) => {
        if (destroyed) return;
        try {
          const event = JSON.parse(e.data as string) as WirePlaybackEvent;
          if (event.type === "state" || event.type === "preload") {
            apply(event.state);
          }
          // ping: ignore — the browser already replies via the pong frame.
        } catch {
          // Malformed frame — drop and keep the connection.
        }
      });

      ws.addEventListener("close", () => {
        wsRef.current = null;
        if (destroyed) return;
        setState((prev) => ({ ...prev, connected: false }));
        const base = reconnectDelayRef.current;
        const jitter = Math.random() * 0.3 * base;
        reconnectTimerRef.current = setTimeout(connect, base + jitter);
        reconnectDelayRef.current = Math.min(base * 2, MAX_RETRY_MS);
        // While the WS is down, keep the UI fresh on a slow poll loop.
        if (!pollTimerRef.current) fallbackPoll();
      });

      ws.addEventListener("error", () => {
        // The `close` handler will run right after — let it own retry.
        try { ws.close(); } catch { /* noop */ }
      });
    };

    if (typeof WebSocket !== "undefined") {
      connect();
    } else {
      fallbackPoll();
    }

    return () => {
      destroyed = true;
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  return state;
}
