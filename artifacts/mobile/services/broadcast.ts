import { Platform } from "react-native";
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

/**
 * Minimal EventSource-compatible SSE client backed by XMLHttpRequest.
 * Used on React Native Android/iOS where `EventSource` is not a global.
 * XHR's `onprogress` fires incrementally on RN's networking layer, so
 * each SSE message is delivered as it arrives without buffering the full
 * response in memory.
 */
class NativeSSEClient {
  private xhr: XMLHttpRequest | null = null;
  private eventHandlers: Record<string, Array<(e: any) => void>> = {};
  private parseBuffer = "";
  private lastLength = 0;

  constructor(private readonly url: string) {
    this.connect();
  }

  private connect() {
    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    this.parseBuffer = "";
    this.lastLength = 0;

    xhr.open("GET", this.url, true);
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.setRequestHeader("Cache-Control", "no-cache");

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 2) {
        this.dispatch("open", {});
      }
    };

    xhr.onprogress = () => {
      const raw = xhr.responseText ?? "";
      if (raw.length <= this.lastLength) return;
      const chunk = raw.slice(this.lastLength);
      this.lastLength = raw.length;
      this.parseBuffer += chunk;
      this.flush();
    };

    xhr.onerror = () => this.dispatch("error", {});
    xhr.onload = () => this.dispatch("error", {});

    try {
      xhr.send();
    } catch {
      this.dispatch("error", {});
    }
  }

  private flush() {
    const blocks = this.parseBuffer.split("\n\n");
    this.parseBuffer = blocks.pop() ?? "";
    for (const block of blocks) {
      let eventType = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += (data ? "\n" : "") + line.slice(5).trim();
        }
      }
      if (data || eventType !== "message") {
        this.dispatch(eventType, { data });
      }
    }
  }

  private dispatch(type: string, event: Record<string, unknown>) {
    const handlers = this.eventHandlers[type];
    if (!handlers) return;
    const evt = { type, ...event };
    for (const h of handlers) {
      try { h(evt); } catch {}
    }
  }

  addEventListener(type: string, listener: (e: any) => void) {
    if (!this.eventHandlers[type]) this.eventHandlers[type] = [];
    this.eventHandlers[type].push(listener);
  }

  removeEventListener(type: string, listener: (e: any) => void) {
    if (!this.eventHandlers[type]) return;
    this.eventHandlers[type] = this.eventHandlers[type].filter((h) => h !== listener);
  }

  close() {
    try { this.xhr?.abort(); } catch {}
    this.xhr = null;
  }
}

/**
 * Pick the best available EventSource implementation:
 *   - Web: native browser EventSource
 *   - Native (Android/iOS): NativeSSEClient backed by XMLHttpRequest
 */
function getEventSourceCtor(): (new (url: string) => {
  addEventListener: (type: string, listener: (e: any) => void) => void;
  removeEventListener: (type: string, listener: (e: any) => void) => void;
  close: () => void;
}) | null {
  const globalES = (globalThis as any).EventSource;
  if (typeof globalES === "function") return globalES;
  if (Platform.OS !== "web") return NativeSSEClient;
  return null;
}

export function subscribeBroadcastEvents(
  handlers: Partial<Record<BroadcastRealtimeEvent, (payload: any) => void>>,
): { close: () => void } | null {
  const apiBase = getApiBase();
  const EventSourceCtor = getEventSourceCtor();
  if (!apiBase || !EventSourceCtor) return null;

  const Ctor = EventSourceCtor;
  let source: any = null;
  let closed = false;
  let retryMs = SSE_MIN_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    source = new Ctor(`${apiBase}/api/broadcast/events?platform=mobile`);

    const listenerEntries = (Object.entries(handlers) as Array<[BroadcastRealtimeEvent, (payload: any) => void]>)
      .map(([event, handler]) => {
        const listener = (message: any) => {
          retryMs = SSE_MIN_RETRY_MS;
          try {
            handler(message?.data ? JSON.parse(message.data) : null);
          } catch {
            handler(null);
          }
        };
        source!.addEventListener(event, listener);
        return [event, listener] as const;
      });

    source.addEventListener("open", () => {
      retryMs = SSE_MIN_RETRY_MS;
    });

    source.addEventListener("error", () => {
      if (closed) return;
      for (const [event, listener] of listenerEntries) source!.removeEventListener?.(event, listener);
      try { source!.close(); } catch {}
      source = null;
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
