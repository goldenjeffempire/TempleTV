/**
 * Mobile Broadcast Service — rebuilt from scratch.
 *
 * Low-level API helpers for the mobile broadcast surfaces.
 * Real-time state (BroadcastSyncState) comes from useBroadcastSync /
 * the BroadcastEngine — not from this module.
 *
 * This module provides:
 *  • fetchBroadcastCurrent()      — one-shot HTTP snapshot (cold-start primer)
 *  • fetchLiveStatus()            — one-shot YouTube live status check
 *  • subscribeBroadcastEvents()   — SSE sidecar for named broadcast events
 *  • sendReaction()               — POST reaction to broadcast chat
 *  • submitPrayerRequest()        — POST prayer request
 *  • postPlaybackTelemetryDelta() — POST per-second playback telemetry
 *  • recordMobileView()           — POST view metric for analytics
 *
 * Types re-exported for consumers that import from this module.
 */

import { Platform } from "react-native";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";
import type {
  BroadcastItem,
  BroadcastRealtimeEvent,
  ReactionType,
} from "@workspace/broadcast-types";

export type { BroadcastItem, BroadcastRealtimeEvent, ReactionType };

// ── Shared types ──────────────────────────────────────────────────────────────

export interface BroadcastCurrentResult {
  item:                BroadcastItem | null;
  nextItem:            BroadcastItem | null;
  upcomingItems?:      BroadcastItem[];
  index:               number;
  positionSecs:        number;
  totalSecs:           number;
  queueLength:         number;
  progressPercent?:    number;
  syncedAt?:           string;
  serverTimeMs?:       number;
  currentItemEndsAtMs?: number;
  itemStartEpochSecs?: number;
  failoverReason?:     string | null;
  failoverHlsUrl?:     string | null;
  activeSchedule?: {
    id:          string;
    title:       string;
    contentType: "live" | "playlist" | "video";
    contentId:   string | null;
    startTime:   string;
    endTime:     string | null;
  } | null;
  liveOverride?: {
    id:              string;
    title:           string;
    hlsStreamUrl:    string | null;
    youtubeVideoId:  string | null;
  } | null;
}

export interface LiveStatusResult {
  isLive:    boolean;
  videoId:   string | null;
  title:     string | null;
  checkedAt: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8_000;

function apiUrl(path: string): string {
  const base = getApiBase();
  return base ? `${base.replace(/\/$/, "")}${path}` : path;
}

async function apiFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetchWithRetry(
      apiUrl(path),
      {
        headers: { "X-Platform": Platform.OS },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * One-shot broadcast state snapshot.
 * Used as a cold-start primer before the WS handshake completes.
 */
export async function fetchBroadcastCurrent(): Promise<BroadcastCurrentResult | null> {
  return apiFetch<BroadcastCurrentResult>("/api/broadcast/current");
}

/**
 * One-shot YouTube live status check.
 * The BroadcastEngine's LiveStreamController handles ongoing polling.
 * Call this only for immediate one-off checks (e.g. deep-link resolution).
 */
export async function fetchLiveStatus(): Promise<LiveStatusResult | null> {
  return apiFetch<LiveStatusResult>("/api/youtube/live/status");
}

// ── SSE subscription ──────────────────────────────────────────────────────────

/**
 * Subscribe to named server-sent broadcast events.
 *
 * Opens an EventSource to /api/broadcast/events and registers one listener
 * per event type in `handlers`. Returns a handle with `.close()` for cleanup.
 *
 * Usage:
 *   const sub = subscribeBroadcastEvents({
 *     "broadcast-control-updated": handleControlUpdate,
 *     "videos-library-updated":    handleLibraryUpdate,
 *   });
 *   return () => sub.close();
 *
 * On React Native web: EventSource is available (polyfilled by Expo).
 * On native (iOS/Android): EventSource may not be available; the function
 * returns a no-op handle so callers do not need to guard.
 */
export function subscribeBroadcastEvents(
  handlers: Partial<Record<BroadcastRealtimeEvent | string, () => void>>,
): { close(): void } {
  const base = getApiBase();
  const sseUrl = base
    ? `${base.replace(/\/$/, "")}/api/broadcast/events?platform=mobile`
    : "/api/broadcast/events?platform=mobile";

  // Guard: EventSource may not be available on native runtime.
  if (typeof EventSource === "undefined") {
    return { close() {} };
  }

  let es: EventSource | null = null;
  try {
    es = new EventSource(sseUrl);

    for (const [eventType, cb] of Object.entries(handlers)) {
      if (typeof cb === "function") {
        es.addEventListener(eventType, cb as EventListener);
      }
    }
  } catch {
    return { close() {} };
  }

  const captured = es;
  return {
    close() {
      captured.close();
    },
  };
}

// ── Reactions ─────────────────────────────────────────────────────────────────

/**
 * Send a broadcast reaction emoji. Fire-and-forget — callers should not await.
 */
export async function sendReaction(type: ReactionType): Promise<void> {
  try {
    await fetchWithRetry(apiUrl("/api/broadcast/reaction"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Platform": Platform.OS },
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort — reactions are non-critical.
  }
}

// ── Prayer request ────────────────────────────────────────────────────────────

/**
 * Submit a mobile prayer request.
 * @param name     Display name (null → "Anonymous")
 * @param message  Prayer request text
 * @returns true on success
 */
export async function submitPrayerRequest(
  name: string | null,
  message: string,
): Promise<boolean> {
  try {
    const res = await fetchWithRetry(apiUrl("/api/broadcast/prayer"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Platform": Platform.OS },
      body: JSON.stringify({ name: name ?? "Anonymous", message, platform: "mobile" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Playback telemetry ────────────────────────────────────────────────────────

/**
 * Post a per-second playback telemetry delta to the server.
 * Called from LocalVideoPlayer on every playback progress tick.
 * Fire-and-forget — failures are silently swallowed.
 *
 * @param platform   "mobile" | "tv" | "web"
 * @param decoded    Frames decoded in this delta window
 * @param dropped    Frames dropped in this delta window
 */
export async function postPlaybackTelemetryDelta(
  platform: string,
  decoded: number,
  dropped: number,
): Promise<void> {
  try {
    await fetchWithRetry(apiUrl("/api/broadcast/playback-telemetry"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Platform": Platform.OS },
      body: JSON.stringify({ platform, decoded, dropped, ts: Date.now() }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // Non-critical — telemetry must never break playback.
  }
}

// ── View recording ────────────────────────────────────────────────────────────

/**
 * Record a video view for analytics.
 */
export async function recordMobileView(videoId: string): Promise<void> {
  try {
    await fetchWithRetry(apiUrl(`/api/videos/${videoId}/view`), {
      method: "POST",
      headers: { "X-Platform": Platform.OS },
    });
  } catch {
    // Best-effort.
  }
}
