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
  /**
   * Live viewer count from the same SSE channel (`stream-health` event).
   * `null` until the first health frame arrives. The TV broadcast companion
   * chip in `Player.tsx` consumes this — no other surface uses it yet.
   * Adding it here (vs. a second EventSource) avoids opening a duplicate
   * connection per page load.
   */
  viewerCount: number | null;
  /**
   * Raw `BroadcastCurrentPayload` straight from the latest SSE message — used by
   * `Home.tsx` so the cinematic hero can render full item metadata (thumbnail,
   * durationSecs, activeSchedule, liveOverride) without a separate HTTP fetch.
   * `null` until the first SSE message arrives or until a fallback poll succeeds.
   * Consumers that only need the projected fields above should keep using them.
   */
  payload: Record<string, unknown> | null;
  /**
   * Monotonically increasing counter incremented every time the API
   * broadcasts a `videos-library-updated` SSE event (admin upload finalize,
   * edit, delete, transcoding completion, YouTube sync). Library list
   * consumers (`useSermons`, `useSearch`) watch this and refetch
   * `/api/videos` whenever it changes — making admin uploads visible on TV
   * within a few hundred ms instead of waiting on the 5-minute poll.
   * Piggybacks on the same EventSource so we don't open a second SSE
   * connection per page load.
   */
  libraryRevision: number;
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
  viewerCount: null,
  payload: null,
  libraryRevision: 0,
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

      // Use the functional setter so we preserve `viewerCount` across
      // broadcast-current-updated frames — otherwise an item-rotation event
      // would clobber the most recent viewer count (which arrives on the
      // separate `stream-health` channel) until the next health frame.
      // Also preserve `libraryRevision` for the same reason: it's bumped by
      // the `videos-library-updated` event handler below and would otherwise
      // be reset on every broadcast frame.
      setState((prev) => ({
        viewerCount: prev.viewerCount,
        libraryRevision: prev.libraryRevision,
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
        payload: current,
      }));
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

        // Library-mutation signal. The API fires this whenever a video is
        // added, edited, deleted, or finishes transcoding. Consumers like
        // `useSermons` and `useSearch` watch the resulting `libraryRevision`
        // counter and refetch — making admin uploads visible on TV within
        // a few hundred ms.
        es.addEventListener("videos-library-updated", () => {
          if (destroyed) return;
          setState((prev) => ({ ...prev, libraryRevision: prev.libraryRevision + 1 }));
        });

        // Stream-health frames carry the live viewer count; we just lift
        // that single field into state. The full payload (bitrate, dropped
        // frames, encoder uptime) is consumed by the admin Live Monitor on
        // a separate code path and not relevant on TV.
        es.addEventListener("stream-health", (e: MessageEvent) => {
          if (destroyed) return;
          try {
            const data = JSON.parse(e.data) as { viewerCount?: number };
            if (typeof data.viewerCount === "number" && Number.isFinite(data.viewerCount)) {
              setState((prev) => (prev.viewerCount === data.viewerCount ? prev : { ...prev, viewerCount: data.viewerCount! }));
            }
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
