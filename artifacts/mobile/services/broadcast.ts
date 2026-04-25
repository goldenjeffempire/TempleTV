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
  } | null;
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
    source = new EventSourceCtor(`${apiBase}/api/broadcast/events`);

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
