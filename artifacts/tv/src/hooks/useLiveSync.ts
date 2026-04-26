import { useEffect, useRef, useState } from "react";

export interface BroadcastNextItem {
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
    /** YouTube live video ID set by the admin via "paste a URL" Live Control. */
    youtubeVideoId?: string | null;
  } | null;
  /**
   * YouTube channel auto-detect signal, surfaced through the SAME broadcast
   * SSE channel that carries `liveOverride`. This is the missing piece that
   * keeps the TV Player and the TV Hero in lock-step: when the channel goes
   * live organically (no admin override), every surface that reads
   * `useLiveSync` now sees the same `ytVideoId` and resolves to the SAME
   * stream, eliminating the prior bug where the Hero advertised the
   * organic-live video but the Player pivoted to the queue item.
   */
  ytLive: boolean;
  ytVideoId: string | null;
  ytTitle: string | null;
  syncedAt: string | null;
  serverTimeMs: number | null;
  connected: boolean;
  /** How far into the current item playback is (seconds). Already corrected for cache age. */
  positionSecs: number | null;
  /** Epoch ms when the current item is expected to end. Use for client-side transition timer. */
  currentItemEndsAtMs: number | null;
  /** Epoch seconds when the current item started — lets the player self-correct position. */
  itemStartEpochSecs: number | null;
  /** 0-based index of the current item in the queue. */
  index: number | null;
  /** Total queue duration in seconds. */
  totalSecs: number | null;
  /** Total number of items in the queue. */
  queueLength: number | null;
  /** Progress through the current item (0–100). */
  progressPercent: number | null;
  /** Next item metadata (title, ID). */
  nextItem: BroadcastNextItem | null;
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
};

function apiUrl(path: string): string {
  return `${window.location.origin}/api${path}`;
}

// Reconnection backoff aligned with mobile (`artifacts/mobile/services/broadcast.ts`)
// so both clients exhibit identical reliability characteristics under sustained
// API outages. Pattern: exponential 2x with 0–30% jitter, 2s floor, 60s ceiling,
// reset on the EventSource `open` event AND on any successful message.
const SSE_MIN_RETRY_MS = 2_000;
const SSE_MAX_RETRY_MS = 60_000;

export function useLiveSync(): BroadcastSyncState {
  const [state, setState] = useState<BroadcastSyncState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(SSE_MIN_RETRY_MS);

  useEffect(() => {
    let destroyed = false;

    const applyPayload = (current: Record<string, unknown>) => {
      const liveOverride = current.liveOverride as null | {
        id: string;
        title: string;
        hlsStreamUrl?: string | null;
        youtubeVideoId?: string | null;
      };
      const item = current.item as null | {
        youtubeId?: string;
        title?: string;
        localVideoUrl?: string | null;
        videoSource?: string;
      };
      const nextItem = current.nextItem as BroadcastNextItem | null ?? null;
      const ytLive = current.ytLive === true;
      const ytVideoId = (current.ytVideoId as string | null | undefined) ?? null;
      const ytTitle = (current.ytTitle as string | null | undefined) ?? null;

      setState({
        // `isLive` reflects "something live-class is airing right now."
        // Promoting `ytLive` here means a Hero/Player consumer that just
        // checks `sync.isLive` will treat an organic YouTube live the same
        // as an admin override or a queue item — the unified resolver above
        // (override → ytVideoId → queue) decides which video to actually
        // load.
        isLive: !!liveOverride || !!item || ytLive,
        title: liveOverride?.title ?? ytTitle ?? item?.title ?? null,
        // Resolution priority (matches `useUnifiedLive`, `LiveYouTubePlayer`,
        // and the mobile player):
        //   1. Admin override's YouTube videoId  (Live Control selection)
        //   2. Channel auto-detect ytVideoId     (organic live)
        //   3. Broadcast queue item              (fallback content)
        // Without step 2, the Player would silently skip an organic live
        // stream that the Hero was advertising.
        videoId: liveOverride?.youtubeVideoId ?? ytVideoId ?? item?.youtubeId ?? null,
        hlsStreamUrl:
          liveOverride?.hlsStreamUrl ??
          (item?.videoSource === "local" ? (item.localVideoUrl ?? null) : null),
        liveOverride: liveOverride ?? null,
        ytLive,
        ytVideoId,
        ytTitle,
        syncedAt: (current.syncedAt as string) ?? null,
        serverTimeMs: (current.serverTimeMs as number) ?? null,
        connected: true,
        positionSecs: typeof current.positionSecs === "number" ? current.positionSecs : null,
        currentItemEndsAtMs: typeof current.currentItemEndsAtMs === "number"
          ? current.currentItemEndsAtMs
          : null,
        itemStartEpochSecs: typeof current.itemStartEpochSecs === "number"
          ? current.itemStartEpochSecs
          : null,
        index: typeof current.index === "number" ? current.index : null,
        totalSecs: typeof current.totalSecs === "number" ? current.totalSecs : null,
        queueLength: typeof current.queueLength === "number" ? current.queueLength : null,
        progressPercent: typeof current.progressPercent === "number" ? current.progressPercent : null,
        nextItem,
      });
    };

    const fallbackPoll = async () => {
      if (destroyed) return;
      try {
        const res = await fetch(apiUrl("/broadcast/current"), { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error("poll failed");
        const data = await res.json() as Record<string, unknown>;
        if (!destroyed) applyPayload(data);
      } catch {}
      if (!destroyed) pollRef.current = setTimeout(fallbackPoll, 10_000);
    };

    const connect = () => {
      if (destroyed) return;
      try {
        const es = new EventSource(apiUrl("/broadcast/events?platform=tv"));
        esRef.current = es;

        es.addEventListener("open", () => {
          reconnectDelayRef.current = SSE_MIN_RETRY_MS;
        });

        es.addEventListener("broadcast-current-updated", (e: MessageEvent) => {
          if (destroyed) return;
          try {
            const { current } = JSON.parse(e.data) as { current: Record<string, unknown> };
            reconnectDelayRef.current = SSE_MIN_RETRY_MS;
            applyPayload(current);
          } catch {}
        });

        es.addEventListener("error", () => {
          es.close();
          esRef.current = null;
          if (destroyed) return;
          const base = reconnectDelayRef.current;
          const jitter = Math.random() * 0.3 * base;
          reconnectTimerRef.current = setTimeout(connect, base + jitter);
          reconnectDelayRef.current = Math.min(base * 2, SSE_MAX_RETRY_MS);
        });
      } catch {
        fallbackPoll();
      }
    };

    if (typeof EventSource !== "undefined") {
      connect();
    } else {
      fallbackPoll();
    }

    return () => {
      destroyed = true;
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  return state;
}
