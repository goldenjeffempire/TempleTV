import { getApiBase } from "@/lib/apiBase";

export interface BroadcastItem {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  videoSource: string;
}

export interface BroadcastCurrentResult {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
  /**
   * The next few items in the broadcast rotation after `item`, in air order.
   * Server caps this at 3 distinct items and wraps around the queue. Optional
   * for backwards-compat with API responses that pre-date the field — clients
   * should treat `undefined` and `[]` identically.
   */
  upcomingItems?: BroadcastItem[];
  index: number;
  positionSecs: number;
  totalSecs: number;
  queueLength: number;
  progressPercent?: number;
  syncedAt?: string;
  serverTimeMs?: number;
  /** Epoch ms when the current item ends and the next one begins. */
  currentItemEndsAtMs?: number;
  /** Epoch seconds when the current item's playback started. */
  itemStartEpochSecs?: number;
  failoverReason?: string | null;
  activeSchedule?: {
    id: string;
    title: string;
    contentType: "live" | "playlist" | "video";
    contentId: string | null;
    startTime: string;
    endTime: string | null;
  } | null;
  liveOverride?: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
    /** Direct HLS source — set when admin pasted an HLS URL into Live Control. */
    hlsStreamUrl?: string | null;
    /**
     * 11-character YouTube video ID — set when admin pasted a YouTube live URL
     * into Live Control. The mobile supervisor relies on `/api/youtube/live`
     * (which the API enriches with this field) to actually navigate, but
     * surfacing it here keeps the type honest for any consumer that reads the
     * broadcast/current payload directly.
     */
    youtubeVideoId?: string | null;
  } | null;
  /**
   * YouTube channel auto-detect signal, surfaced through the broadcast
   * SSE/REST payload so every viewer surface (Hero, Player) resolves the
   * active live videoId from a SINGLE source. Resolution priority is:
   *   1. liveOverride.youtubeVideoId (admin-pinned)  ← always wins
   *   2. ytVideoId (channel went live organically)
   *   3. queue item                                   ← player-only fallback
   * Optional for backwards-compat with API responses that pre-date the
   * field — clients should treat `undefined` as "not live via channel".
   */
  ytLive?: boolean;
  ytVideoId?: string | null;
  ytTitle?: string | null;
}

function toAbsoluteUrl(url: string | null, base: string): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${base}${url.startsWith("/") ? url : `/${url}`}`;
}

function normalizeItem(item: BroadcastItem | null, base: string): BroadcastItem | null {
  if (!item) return null;
  return {
    ...item,
    localVideoUrl: toAbsoluteUrl(item.localVideoUrl, base),
    thumbnailUrl: toAbsoluteUrl(item.thumbnailUrl, base) ?? item.thumbnailUrl,
  };
}

export interface BroadcastGuideItem {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  videoSource: string;
  startMs: number;
  endMs: number;
  isCurrent: boolean;
  positionSecs: number;
  progressPercent: number;
}

export interface BroadcastGuideResult {
  items: BroadcastGuideItem[];
  liveOverride?: { title: string } | null;
}

export async function fetchBroadcastGuide(): Promise<BroadcastGuideResult | null> {
  const apiBase = getApiBase();
  if (!apiBase) return null;
  try {
    const res = await fetch(`${apiBase}/api/broadcast/guide`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BroadcastGuideResult;
    return {
      ...data,
      items: data.items.map((item) => ({
        ...item,
        localVideoUrl: toAbsoluteUrl(item.localVideoUrl, apiBase),
        thumbnailUrl: toAbsoluteUrl(item.thumbnailUrl, apiBase) ?? item.thumbnailUrl,
      })),
    };
  } catch {
    return null;
  }
}

export async function checkBroadcastCurrent(): Promise<BroadcastCurrentResult | null> {
  const apiBase = getApiBase();
  if (!apiBase) return null;
  try {
    const res = await fetch(`${apiBase}/api/broadcast/current`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BroadcastCurrentResult;
    return {
      ...data,
      item: normalizeItem(data.item, apiBase),
      nextItem: normalizeItem(data.nextItem, apiBase),
      upcomingItems: (data.upcomingItems ?? [])
        .map((it) => normalizeItem(it, apiBase))
        .filter((it): it is BroadcastItem => it !== null),
    };
  } catch {
    return null;
  }
}

export type BroadcastRealtimeEvent =
  | "broadcast-current-updated"
  | "broadcast-queue-updated"
  | "broadcast-schedule-updated"
  | "broadcast-control-updated"
  | "status"
  | "override-expired"
  | "yt-status"
  | "live-reaction";

export type ReactionType = "amen" | "fire" | "hallelujah";

/**
 * Fire-and-forget POST of a playback-quality delta. Feeds the
 * `droppedFrameRate` field on the admin live-monitor's `stream-health` SSE
 * channel — the only frame-quality signal the server cannot measure on its
 * own. The server expects deltas (not cumulative totals) at roughly 5 s
 * cadence per active player; callers are responsible for tracking the last
 * cumulative reading and computing the difference. Silently no-ops on:
 *   - missing apiBase (offline / unconfigured)
 *   - both deltas <= 0 (server would discard anyway, save the round-trip)
 *   - any network or fetch failure (telemetry must never disturb playback)
 */
export async function postPlaybackTelemetryDelta(
  platform: "mobile" | "tv" | "admin",
  decodedDelta: number,
  droppedDelta: number,
): Promise<void> {
  if (decodedDelta <= 0 && droppedDelta <= 0) return;
  const apiBase = getApiBase();
  if (!apiBase) return;
  try {
    await fetch(`${apiBase}/api/broadcast/playback-telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform,
        decoded: Math.max(0, Math.round(decodedDelta)),
        dropped: Math.max(0, Math.round(droppedDelta)),
      }),
    });
  } catch {}
}

export async function sendReaction(type: ReactionType): Promise<void> {
  const apiBase = getApiBase();
  if (!apiBase) return;
  try {
    await fetch(`${apiBase}/api/broadcast/reaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
  } catch {}
}

export async function submitPrayerRequest(name: string | null, message: string): Promise<boolean> {
  const apiBase = getApiBase();
  if (!apiBase) return false;
  try {
    const res = await fetch(`${apiBase}/api/broadcast/prayer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || undefined, message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const SSE_MIN_RETRY_MS = 2_000;
const SSE_MAX_RETRY_MS = 60_000;

export function subscribeBroadcastEvents(
  handlers: Partial<Record<BroadcastRealtimeEvent, (payload: any) => void>>,
): { close: () => void } | null {
  const apiBase = getApiBase();
  const EventSourceCtor = (globalThis as any).EventSource;
  if (!apiBase || typeof EventSourceCtor !== "function") return null;

  let source: any = null;
  let closed = false;
  let retryMs = SSE_MIN_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    source = new EventSourceCtor(`${apiBase}/api/broadcast/events?platform=mobile`);

    const listenerEntries = (Object.entries(handlers) as Array<[BroadcastRealtimeEvent, (payload: any) => void]>)
      .map(([event, handler]) => {
        const listener = (message: any) => {
          retryMs = SSE_MIN_RETRY_MS; // reset backoff on any successful message
          try {
            handler(message?.data ? JSON.parse(message.data) : null);
          } catch {
            handler(null);
          }
        };
        source.addEventListener(event, listener);
        return [event, listener] as const;
      });

    source.addEventListener("open", () => {
      retryMs = SSE_MIN_RETRY_MS;
    });

    source.addEventListener("error", () => {
      if (closed) return;
      for (const [event, listener] of listenerEntries) source.removeEventListener?.(event, listener);
      try { source.close(); } catch {}
      source = null;
      // Exponential backoff with jitter
      const jitter = Math.random() * 0.3 * retryMs;
      retryTimer = setTimeout(() => {
        if (!closed) connect();
      }, retryMs + jitter);
      retryMs = Math.min(retryMs * 2, SSE_MAX_RETRY_MS);
    });
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { source?.close(); } catch {}
      source = null;
    },
  };
}
