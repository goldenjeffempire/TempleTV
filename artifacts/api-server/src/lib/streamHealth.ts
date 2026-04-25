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
  broadcastLiveEvent,
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

  const base = {
    ts: Date.now(),
    viewerCount: getSSEClientCount(),
    viewersByPlatform: getSSEClientCountsByPlatform(),
    droppedFrameRate: frames.droppedFrameRate,
    decodedFramesWindow: frames.decodedFramesWindow,
    droppedFramesWindow: frames.droppedFramesWindow,
    reportingClients: frames.reportingClients,
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
      broadcastLiveEvent("stream-health", snapshot);
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
