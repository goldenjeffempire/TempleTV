/**
 * Stream Health — real-time broadcast telemetry pushed over SSE every second.
 *
 * Design principles:
 *  • Only emit when at least one SSE client is connected (zero overhead when
 *    no admin is watching). The emitter still runs every second internally so
 *    state stays warm, but skips the broadcast write.
 *  • All per-second emissions read pre-computed cached samples — no I/O on the
 *    hot path. A separate 5s sampler runs the network probes (HEAD on the
 *    current HLS segment, m3u8 bitrate parse).
 *  • Every metric is genuinely measured server-side. We do not fabricate
 *    client-only data points like "dropped frames" — instead we surface
 *    server-observable equivalents (SSE write-failure rate as a connection
 *    stability indicator).
 *  • Health classification is deterministic from numeric thresholds so the
 *    color-coded UI never disagrees with the underlying numbers.
 */

import {
  broadcastLiveEventLocal,
  getSSEClientCount,
  getSSEClientCountsByPlatform,
  registerSSEWriteObserver,
  type SSEPlatform,
} from "./liveEvents";
import { getLastTrackedBroadcastPayload } from "../routes/broadcast";

// ---------------------------------------------------------------------------
// Rolling counters for connection stability (last 60 s window)
// ---------------------------------------------------------------------------

const STABILITY_WINDOW_MS = 60_000;
type WriteSample = { ts: number; ok: number; failed: number };
const writeSamples: WriteSample[] = [];

function recordWrite(ok: number, failed: number): void {
  const now = Date.now();
  writeSamples.push({ ts: now, ok, failed });
  // Trim samples older than the window
  const cutoff = now - STABILITY_WINDOW_MS;
  while (writeSamples.length > 0 && writeSamples[0]!.ts < cutoff) {
    writeSamples.shift();
  }
}

function computeStability(): { stabilityPercent: number; failureRate: number } {
  let ok = 0;
  let failed = 0;
  for (const s of writeSamples) {
    ok += s.ok;
    failed += s.failed;
  }
  const total = ok + failed;
  if (total === 0) return { stabilityPercent: 100, failureRate: 0 };
  const failureRate = failed / total;
  const stabilityPercent = Math.max(0, Math.min(100, (ok / total) * 100));
  return { stabilityPercent, failureRate };
}

// ---------------------------------------------------------------------------
// Client playback telemetry — dropped frame rate (real, not synthesized)
// ---------------------------------------------------------------------------
//
// Each viewer's player periodically POSTs a delta from
// HTMLVideoElement.getVideoPlaybackQuality() to /api/broadcast/playback-telemetry.
// We keep the last 60 s of samples per platform and aggregate into a single
// drop ratio (dropped / decoded). Out-of-the-box truth: when no client reports,
// the field is null and the UI shows "—" rather than fabricating zeros.

const TELEMETRY_WINDOW_MS = 60_000;
type FrameSample = { ts: number; platform: SSEPlatform; decoded: number; dropped: number };
const frameSamples: FrameSample[] = [];

export function recordPlaybackTelemetry(
  platform: unknown,
  decoded: number,
  dropped: number,
): void {
  if (!Number.isFinite(decoded) || !Number.isFinite(dropped)) return;
  if (decoded < 0 || dropped < 0) return;
  if (decoded === 0 && dropped === 0) return;
  // Cap obviously-bogus reports so a single misbehaving client can't poison
  // the rolling aggregate (60 fps × 30 s buffered delta is the realistic max
  // for the ~5 s reporting cadence we ask players to use).
  const HARD_CAP = 10_000;
  const d = Math.min(decoded, HARD_CAP);
  const x = Math.min(dropped, HARD_CAP);
  const p: SSEPlatform =
    platform === "tv" || platform === "mobile" || platform === "admin" ? platform : "unknown";
  const now = Date.now();
  frameSamples.push({ ts: now, platform: p, decoded: d, dropped: x });
  const cutoff = now - TELEMETRY_WINDOW_MS;
  while (frameSamples.length > 0 && frameSamples[0]!.ts < cutoff) {
    frameSamples.shift();
  }
}

// ---------------------------------------------------------------------------
// Client recovery telemetry — per-platform "the player had to realign" events
// ---------------------------------------------------------------------------
//
// Whenever a player invokes its `recoverBroadcastPlayback()` path (offline
// short-circuit in the network-aware skip gate, post-reconnect grace window,
// queued-retry straggler, drift correction, broken-item soft fallback) it
// fires a one-shot POST here. We keep the last 60 s of those marks per
// platform and surface two derived fields on the stream-health snapshot:
//   • `recoveriesByPlatform` — raw counts in the window, per-platform
//   • `recoveryRatePerMin`  — total events normalized to "events / minute"
//                              so the admin card reads the same regardless
//                              of polling cadence.
//
// Critically: we do NOT alert on this. A handful of recoveries per minute is
// healthy plumbing doing its job. This metric is for spotting a sudden
// surge — e.g. "mobile recoveries 0/min → 40/min in 30 s" almost always
// means a CDN edge is hiccuping for an entire mobile carrier, and the
// operator can mitigate (force-rotate the manifest, switch ingest, etc.)
// long before viewers churn. The signal that drove this surface area:
// the network-aware skip gate shipped 2026-04-27 silently absorbs flaky
// connectivity, and without this metric operators have no way to see it
// firing in production.

const RECOVERY_WINDOW_MS = 60_000;
type RecoverySample = { ts: number; platform: SSEPlatform };
const recoverySamples: RecoverySample[] = [];

export function recordRecoverEvent(platform: unknown): void {
  const p: SSEPlatform =
    platform === "tv" || platform === "mobile" || platform === "admin" ? platform : "unknown";
  const now = Date.now();
  recoverySamples.push({ ts: now, platform: p });
  // Same rolling-window trim pattern as the frame samples — bounded memory
  // even under sustained chatty clients, and the per-second snapshot reads
  // a simple linear scan over what's at most a few hundred entries.
  const cutoff = now - RECOVERY_WINDOW_MS;
  while (recoverySamples.length > 0 && recoverySamples[0]!.ts < cutoff) {
    recoverySamples.shift();
  }
}

function computeRecoveryStats(): {
  recoveriesByPlatform: Record<SSEPlatform, number>;
  recoveryRatePerMin: number;
} {
  const by: Record<SSEPlatform, number> = { tv: 0, mobile: 0, admin: 0, unknown: 0 };
  for (const s of recoverySamples) by[s.platform] += 1;
  // The window is exactly 60 s, so total / 1.0 = events-per-minute. Kept as
  // an explicit divide so future window tweaks don't silently break the unit.
  const total = recoverySamples.length;
  const recoveryRatePerMin = Math.round((total / (RECOVERY_WINDOW_MS / 60_000)) * 10) / 10;
  return { recoveriesByPlatform: by, recoveryRatePerMin };
}

// ---------------------------------------------------------------------------
// Broken-item skip telemetry — Mission Control feed
// ---------------------------------------------------------------------------
//
// The mobile player's `handleBroadcastError` runs a 2-in-30s broken-item gate:
// when the same broadcast queue item fails to load twice within 30 seconds AND
// the device is online, the player jumps locally to the up-next item rather
// than looping on a 404 / corrupt manifest. That gate has been silently saving
// viewer experience since 2026-04-26, but operators had no way to SEE it
// firing in production — which means dead assets sat in the broadcast queue
// indefinitely (every viewer hit them, skipped past them locally, but the
// queue itself was never cleaned up and the underlying root cause — usually
// "Render's ephemeral disk evicted the file before S3 mirroring caught up" —
// stayed invisible).
//
// This module captures every gate firing into two complementary structures:
//
//   1. `skipEvents`          — bounded ring buffer of the most recent N events
//                              (timestamp, platform, videoId, title, reason).
//                              Powers the "Recent skips" timeline in the admin
//                              dashboard and any forensic "what skipped at
//                              09:42?" investigation.
//   2. `skipAggregatesById`  — Map<videoId → {count, title, lastSeenAt,
//                              lastReason, platforms}> rolled up over the
//                              full retention window. Powers the "Top
//                              offenders" leaderboard so operators can
//                              triage the highest-impact assets first.
//
// Retention: 7 days OR 2000 events, whichever bound trips first. 7 days
// covers a full weekly programming cycle (so operators see "this Tuesday's
// 9pm slot has skipped 18 times" patterns), and the 2000-event hard cap
// keeps memory bounded under a misconfigured-client storm. Each event is
// ~200 bytes → max ~400 KB resident, trivial.
//
// Privacy: we deliberately do NOT record viewer device IDs, IPs, or any
// per-user attribute. The signal is asset-quality and platform-mix, both
// aggregate-only. Same posture as the existing recovery counter.

const SKIP_EVENTS_MAX = 2000;
const SKIP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface SkipEvent {
  ts: number;
  platform: SSEPlatform;
  videoId: string;
  videoTitle: string | null;
  reason: string;
}

interface SkipAggregate {
  videoId: string;
  videoTitle: string | null;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastReason: string;
  platforms: Record<SSEPlatform, number>;
}

const skipEvents: SkipEvent[] = [];
const skipAggregatesById = new Map<string, SkipAggregate>();

function decrementAggregateFor(evicted: SkipEvent): void {
  // Bookkeeping helper used by both eviction paths (age cutoff + hard cap):
  // when an event leaves the ring buffer, decrement its aggregate's count
  // and platform-split, and drop the aggregate entry entirely once it hits
  // zero so the Map doesn't accumulate dead videoIds forever.
  const agg = skipAggregatesById.get(evicted.videoId);
  if (!agg) return;
  agg.count -= 1;
  const platCount = agg.platforms[evicted.platform];
  if (typeof platCount === "number" && platCount > 0) {
    agg.platforms[evicted.platform] = platCount - 1;
  }
  if (agg.count <= 0) skipAggregatesById.delete(evicted.videoId);
}

function trimSkipEvents(now: number): void {
  // Drop anything past the retention window. The buffer is append-only and
  // ordered by insertion time, so a single from-the-front shift loop is the
  // cheapest way to maintain the invariant without a heap.
  const cutoff = now - SKIP_RETENTION_MS;
  while (skipEvents.length > 0 && skipEvents[0]!.ts < cutoff) {
    decrementAggregateFor(skipEvents.shift()!);
  }
  // Hard-cap the ring buffer regardless of timestamps — protects against a
  // misbehaving client flooding the endpoint inside the retention window.
  while (skipEvents.length > SKIP_EVENTS_MAX) {
    decrementAggregateFor(skipEvents.shift()!);
  }
}

export function recordSkipEvent(input: {
  platform: unknown;
  videoId: unknown;
  videoTitle?: unknown;
  reason?: unknown;
}): void {
  // Validate inputs strictly — telemetry endpoints are the easiest place for
  // a misbehaving client to inject garbage that pollutes operator dashboards.
  if (typeof input.videoId !== "string") return;
  const videoId = input.videoId.trim();
  if (videoId.length === 0 || videoId.length > 128) return;

  const platform: SSEPlatform =
    input.platform === "tv" || input.platform === "mobile" || input.platform === "admin"
      ? input.platform
      : "unknown";

  const rawTitle = typeof input.videoTitle === "string" ? input.videoTitle.trim() : "";
  // Cap title to a reasonable display length — broadcast item titles are
  // already short (~80 chars), but we don't want a bug to push 10 KB strings.
  const videoTitle = rawTitle.length === 0 ? null : rawTitle.slice(0, 200);

  const rawReason = typeof input.reason === "string" ? input.reason.trim() : "";
  // Reasons are agent-emitted ("broken-item-skip", "decode-error", etc.) so
  // a small allowed alphabet + length cap is sufficient sanitation.
  const reason = rawReason.length === 0
    ? "unspecified"
    : rawReason.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unspecified";

  const now = Date.now();
  const event: SkipEvent = { ts: now, platform, videoId, videoTitle, reason };
  skipEvents.push(event);

  // Update or create the aggregate. We keep the freshest title we've seen
  // (operators usually rename queue items as they investigate, and the
  // most-recent title is the most actionable one).
  const existing = skipAggregatesById.get(videoId);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    existing.lastReason = reason;
    if (videoTitle) existing.videoTitle = videoTitle;
    existing.platforms[platform] = (existing.platforms[platform] ?? 0) + 1;
  } else {
    skipAggregatesById.set(videoId, {
      videoId,
      videoTitle,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastReason: reason,
      platforms: {
        tv: platform === "tv" ? 1 : 0,
        mobile: platform === "mobile" ? 1 : 0,
        admin: platform === "admin" ? 1 : 0,
        unknown: platform === "unknown" ? 1 : 0,
      },
    });
  }

  trimSkipEvents(now);
}

export interface SkipTelemetrySnapshot {
  /** Server time when the snapshot was generated, for client-side age math. */
  generatedAt: number;
  /** Total skips in three rolling windows — quick at-a-glance trend signal. */
  totals: { lastHour: number; last24h: number; last7d: number };
  /** Per-platform splits over the full 7-day retention window. */
  byPlatform: Record<SSEPlatform, number>;
  /** Reason histogram over the full retention window. */
  byReason: Record<string, number>;
  /**
   * Highest-skip-count assets (descending by count). Capped at 25 so the JSON
   * payload stays under 10 KB even at peak retention. Operator drills into
   * the queue page for full forensics.
   */
  topVideos: Array<{
    videoId: string;
    videoTitle: string | null;
    count: number;
    lastSeenAt: number;
    lastReason: string;
  }>;
  /** Most recent N events (newest first). Capped at 50 for the timeline view. */
  recent: Array<{
    ts: number;
    platform: SSEPlatform;
    videoId: string;
    videoTitle: string | null;
    reason: string;
  }>;
  /** Total events currently in the ring buffer (informational). */
  bufferSize: number;
  /** Hard cap on the ring buffer (informational, helps spot saturation). */
  bufferCap: number;
}

export function getSkipTelemetrySnapshot(): SkipTelemetrySnapshot {
  const now = Date.now();
  trimSkipEvents(now);

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  let lastHour = 0;
  let last24h = 0;
  let last7d = 0;
  const byPlatform: Record<SSEPlatform, number> = { tv: 0, mobile: 0, admin: 0, unknown: 0 };
  const byReason: Record<string, number> = {};

  for (const ev of skipEvents) {
    const age = now - ev.ts;
    if (age < HOUR) lastHour += 1;
    if (age < DAY) last24h += 1;
    if (age < WEEK) last7d += 1;
    byPlatform[ev.platform] += 1;
    byReason[ev.reason] = (byReason[ev.reason] ?? 0) + 1;
  }

  const topVideos = Array.from(skipAggregatesById.values())
    .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
    .slice(0, 25)
    .map((a) => ({
      videoId: a.videoId,
      videoTitle: a.videoTitle,
      count: a.count,
      lastSeenAt: a.lastSeenAt,
      lastReason: a.lastReason,
    }));

  // Recent timeline = newest 50 events, ordered newest-first. We slice from
  // the end of the ring buffer (already chronological) and reverse, which is
  // O(50) regardless of buffer size — no full sort needed.
  const recent = skipEvents
    .slice(-50)
    .reverse()
    .map((ev) => ({
      ts: ev.ts,
      platform: ev.platform,
      videoId: ev.videoId,
      videoTitle: ev.videoTitle,
      reason: ev.reason,
    }));

  return {
    generatedAt: now,
    totals: { lastHour, last24h, last7d },
    byPlatform,
    byReason,
    topVideos,
    recent,
    bufferSize: skipEvents.length,
    bufferCap: SKIP_EVENTS_MAX,
  };
}

function computeDroppedFrameRate(): {
  droppedFrameRate: number | null;
  decodedFramesWindow: number;
  droppedFramesWindow: number;
  reportingClients: number;
} {
  if (frameSamples.length === 0) {
    return { droppedFrameRate: null, decodedFramesWindow: 0, droppedFramesWindow: 0, reportingClients: 0 };
  }
  let dec = 0;
  let drop = 0;
  // Distinct sample sources in the window (rough proxy for active reporters)
  const uniqueBuckets = new Set<string>();
  for (const s of frameSamples) {
    dec += s.decoded;
    drop += s.dropped;
    uniqueBuckets.add(`${s.platform}:${Math.floor(s.ts / 5000)}`);
  }
  const rate = dec > 0 ? drop / dec : 0;
  return {
    droppedFrameRate: Math.round(rate * 10000) / 10000,
    decodedFramesWindow: dec,
    droppedFramesWindow: drop,
    reportingClients: uniqueBuckets.size,
  };
}

// ---------------------------------------------------------------------------
// HLS network probe — segment fetch latency + bitrate from m3u8 BANDWIDTH tag
// ---------------------------------------------------------------------------

const LATENCY_EMA_ALPHA = 0.4; // weight for newest sample
let latencyEmaMs: number | null = null;
let lastProbeAt = 0;
let lastProbeOk = true;

let cachedBitrateKbps: number | null = null;
let cachedBitrateForUrl: string | null = null;

function extractProbeUrl(payload: ReturnType<typeof getLastTrackedBroadcastPayload>): string | null {
  const item = payload?.item;
  if (!item) return null;
  // For locally-transcoded items the playable URL IS the HLS master (.m3u8).
  // YouTube items are delivered through the YouTube embed and aren't probeable
  // from our server, so we report `null` and the bitrate/latency cards
  // gracefully render as "—".
  if (item.videoSource === "local" && item.localVideoUrl) return item.localVideoUrl;
  return null;
}

async function probeHls(masterUrl: string | null | undefined): Promise<void> {
  if (!masterUrl) {
    latencyEmaMs = null;
    cachedBitrateKbps = null;
    cachedBitrateForUrl = null;
    return;
  }

  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    const res = await fetch(masterUrl, {
      method: "GET",
      signal: ctrl.signal,
      // Prevent any intermediate cache from masking real CDN latency.
      headers: { "Cache-Control": "no-cache" },
    });
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    lastProbeOk = res.ok;
    if (res.ok) {
      // Update EMA so a single bad sample doesn't whipsaw the UI
      latencyEmaMs =
        latencyEmaMs === null
          ? elapsed
          : Math.round(LATENCY_EMA_ALPHA * elapsed + (1 - LATENCY_EMA_ALPHA) * latencyEmaMs);

      // Refresh bitrate only when the URL changes (m3u8 contents are stable
      // for a given output ladder). Parses the highest BANDWIDTH variant.
      if (cachedBitrateForUrl !== masterUrl) {
        try {
          const text = await res.text();
          const matches = [...text.matchAll(/BANDWIDTH=(\d+)/g)];
          if (matches.length > 0) {
            const max = Math.max(...matches.map((m) => Number(m[1])));
            cachedBitrateKbps = Math.round(max / 1000);
          } else {
            cachedBitrateKbps = null;
          }
          cachedBitrateForUrl = masterUrl;
        } catch {
          cachedBitrateKbps = null;
        }
      }
    }
  } catch {
    lastProbeOk = false;
    // Intentionally do NOT clear the EMA on a single failure — a transient
    // network blip shouldn't blank the card. The next successful probe will
    // pull the EMA back to truth.
  }
  lastProbeAt = Date.now();
}

// ---------------------------------------------------------------------------
// Per-second emitter
// ---------------------------------------------------------------------------

export interface StreamHealthSnapshot {
  ts: number;
  /** Connected SSE clients across all surfaces (TV, mobile, admin) */
  viewerCount: number;
  /** Connected viewer count broken out by client platform */
  viewersByPlatform: Record<SSEPlatform, number>;
  /** Fraction of frames the viewer-side decoders dropped (0..1), null if no clients reported */
  droppedFrameRate: number | null;
  /** Total frames decoded across all reporting clients in the last 60 s */
  decodedFramesWindow: number;
  /** Total frames dropped across all reporting clients in the last 60 s */
  droppedFramesWindow: number;
  /** Number of distinct client samples that contributed to the rate (0 = no telemetry) */
  reportingClients: number;
  /**
   * Per-platform count of `recoverBroadcastPlayback()` invocations in the
   * last 60 s, reported by viewer clients. Healthy baseline is 0–a few per
   * minute (flaky-edge absorption); a sudden surge signals a real upstream
   * problem (CDN edge, ingest, carrier-wide outage). Surfaced on the admin
   * live-monitor as the "Recoveries (60s)" tile.
   */
  recoveriesByPlatform: Record<SSEPlatform, number>;
  /** Total recovery events normalized to events-per-minute (0–1 decimal). */
  recoveryRatePerMin: number;
  /** Whether anything is currently airing */
  isOnAir: boolean;
  /** Title of the currently airing item, if any */
  currentTitle: string | null;
  /** Wall-clock seconds the current item has been on air (from anchor) */
  itemUptimeSecs: number;
  /** Wall-clock seconds the api-server process has been running */
  serverUptimeSecs: number;
  /** Estimated peak HLS variant bitrate (kbps), null when no HLS source */
  bitrateKbps: number | null;
  /** EMA of HLS master fetch latency (ms), null when no probe data */
  segmentLatencyMs: number | null;
  /** True if the most recent HLS probe succeeded */
  deliveryOk: boolean;
  /** Time since last successful probe (ms) */
  lastProbeAgoMs: number;
  /** % of SSE writes that succeeded over the last 60 s (100 = perfect) */
  stabilityPercent: number;
  /** Fraction of SSE writes that failed over the last 60 s (0..1) */
  connectionFailureRate: number;
  /** Server-side anchor sync state — true when anchor is fresh and tracking */
  syncOk: boolean;
  /** Position percentage through the current item (0..100, null off-air) */
  progressPercent: number | null;
  /** Overall health classification derived from the numbers above */
  health: "healthy" | "warning" | "critical";
  /** Human-readable explanation of the health status */
  healthReason: string;
}

function classifyHealth(s: Omit<StreamHealthSnapshot, "health" | "healthReason">): {
  health: StreamHealthSnapshot["health"];
  healthReason: string;
} {
  if (!s.isOnAir) {
    return { health: "warning", healthReason: "Off air — no broadcast item active" };
  }
  if (!s.deliveryOk && s.bitrateKbps !== null) {
    return { health: "critical", healthReason: "HLS delivery probe failed" };
  }
  if (s.segmentLatencyMs !== null && s.segmentLatencyMs > 1500) {
    return { health: "critical", healthReason: `Segment latency ${s.segmentLatencyMs}ms exceeds 1500ms` };
  }
  if (s.connectionFailureRate > 0.05) {
    return { health: "warning", healthReason: `${(s.connectionFailureRate * 100).toFixed(1)}% SSE write failures` };
  }
  if (s.droppedFrameRate !== null && s.droppedFrameRate > 0.05) {
    return {
      health: "critical",
      healthReason: `${(s.droppedFrameRate * 100).toFixed(1)}% dropped frames at viewer decoders`,
    };
  }
  if (s.droppedFrameRate !== null && s.droppedFrameRate > 0.01) {
    return {
      health: "warning",
      healthReason: `${(s.droppedFrameRate * 100).toFixed(1)}% dropped frames at viewer decoders`,
    };
  }
  if (s.segmentLatencyMs !== null && s.segmentLatencyMs > 800) {
    return { health: "warning", healthReason: `Segment latency ${s.segmentLatencyMs}ms above optimal` };
  }
  return { health: "healthy", healthReason: "All systems nominal" };
}

function buildSnapshot(): StreamHealthSnapshot {
  const payload = getLastTrackedBroadcastPayload();
  const item = payload?.item ?? null;
  const itemStart = payload?.itemStartEpochSecs ?? null;
  const isOnAir = !!item;

  const itemUptimeSecs = itemStart ? Math.max(0, Math.floor(Date.now() / 1000 - itemStart)) : 0;
  const { stabilityPercent, failureRate } = computeStability();
  const frames = computeDroppedFrameRate();
  const recovery = computeRecoveryStats();

  const base = {
    ts: Date.now(),
    viewerCount: getSSEClientCount(),
    viewersByPlatform: getSSEClientCountsByPlatform(),
    droppedFrameRate: frames.droppedFrameRate,
    decodedFramesWindow: frames.decodedFramesWindow,
    droppedFramesWindow: frames.droppedFramesWindow,
    reportingClients: frames.reportingClients,
    recoveriesByPlatform: recovery.recoveriesByPlatform,
    recoveryRatePerMin: recovery.recoveryRatePerMin,
    isOnAir,
    currentTitle: item?.title ?? null,
    itemUptimeSecs,
    serverUptimeSecs: Math.floor(process.uptime()),
    bitrateKbps: cachedBitrateKbps,
    segmentLatencyMs: latencyEmaMs,
    deliveryOk: lastProbeOk,
    lastProbeAgoMs: lastProbeAt > 0 ? Date.now() - lastProbeAt : 0,
    stabilityPercent: Math.round(stabilityPercent * 10) / 10,
    connectionFailureRate: Math.round(failureRate * 10000) / 10000,
    syncOk: !!itemStart,
    progressPercent: typeof payload?.progressPercent === "number" ? payload.progressPercent : null,
  };
  return { ...base, ...classifyHealth(base) };
}

let emitterHandle: ReturnType<typeof setInterval> | null = null;
let probeHandle: ReturnType<typeof setInterval> | null = null;

export function startStreamHealthEmitter(): void {
  if (emitterHandle) return;

  // Hook into the SSE write pipeline so we can compute connection stability
  // from real write outcomes — no synthetic data, no separate probes.
  registerSSEWriteObserver((ok, failed) => recordWrite(ok, failed));

  // Per-second push. Skip the actual broadcast when no clients are listening
  // so an idle deployment costs ~zero CPU; the snapshot is still cheap to
  // build (no I/O) so we keep the cadence honest.
  emitterHandle = setInterval(() => {
    if (getSSEClientCount() === 0) return;
    try {
      const snapshot = buildSnapshot();
      // Per-instance pipeline-health snapshot — never publish to the
      // cross-instance bus. The snapshot describes THIS instance's
      // SSE-write outcomes, ffmpeg health, and HLS probe results;
      // cross-publishing would just have every other instance receive
      // a snapshot of the publisher's pipeline (semantically wrong) at
      // 1 Hz × N instances (bandwidth waste).
      broadcastLiveEventLocal("stream-health", snapshot);
    } catch {
      // Never crash the timer
    }
  }, 1_000);
  emitterHandle.unref();

  // Network probe runs every 5 s — independent of viewer presence so when an
  // admin opens the page the cached EMA already reflects current reality.
  probeHandle = setInterval(() => {
    const payload = getLastTrackedBroadcastPayload();
    void probeHls(extractProbeUrl(payload));
  }, 5_000);
  probeHandle.unref();

  // Kick off an immediate probe so the first emission has data
  void probeHls(extractProbeUrl(getLastTrackedBroadcastPayload()));
}

export function stopStreamHealthEmitter(): void {
  if (emitterHandle) {
    clearInterval(emitterHandle);
    emitterHandle = null;
  }
  if (probeHandle) {
    clearInterval(probeHandle);
    probeHandle = null;
  }
}
