/**
 * stream-health — rolling in-memory telemetry aggregator for broadcast quality.
 *
 * Clients POST samples to /broadcast/playback-telemetry; this module keeps
 * a 5-minute sliding window of stall events, playback errors, buffer levels,
 * startup times, and per-platform breakdowns so the admin dashboard can
 * surface meaningful streaming KPIs without a database write per sample.
 *
 * Thread safety: Node.js is single-threaded — no locking needed.
 */

export interface TelemetrySample {
  platform?: string;
  stalls?: number;
  bufferedSecs?: number;
  bitrateKbps?: number;
  droppedFrames?: number;
  sessionId?: string;
  startupMs?: number;
  event?: string;
  videoId?: string;
  errorType?: string;
}

interface Bucket {
  timestampMs: number;
  stalls: number;
  errors: number;
  bufferSamples: number[];
  bitrateKbps: number[];
  platforms: Map<string, number>;
  startupMsSamples: number[];
  droppedFrames: number;
  errorsByType: Map<string, number>;
  errorsByPlatform: Map<string, number>;
}

export interface StreamHealthStats {
  windowMs: number;
  totalStalls: number;
  totalErrors: number;
  avgBufferedSecs: number | null;
  avgBitrateKbps: number | null;
  activeSessions: number;
  platformBreakdown: Record<string, number>;
  checkedAt: string;
}

export interface StreamHealthDetailedStats extends StreamHealthStats {
  /** Startup time percentiles in milliseconds */
  startupMs: {
    p50: number | null;
    p95: number | null;
    avg: number | null;
    sampleCount: number;
  };
  /** Total dropped frames across all sessions in the window */
  totalDroppedFrames: number;
  /** Error breakdown by category (network, media, fatal, etc.) */
  errorsByType: Record<string, number>;
  /** Errors grouped by client platform */
  errorsByPlatform: Record<string, number>;
  /** Stall rate: stalls per active session */
  stallsPerSession: number | null;
  /** Buffer health: % of samples above 10s buffered */
  bufferHealthPct: number | null;
  /** Total startup events tracked in this window */
  startupEventCount: number;
}

const WINDOW_MS = 5 * 60 * 1000;
const BUCKET_SIZE_MS = 15_000;

const buckets: Bucket[] = [];
const activeSessions = new Map<string, number>();

function currentBucket(): Bucket {
  const now = Date.now();
  const bucketTs = Math.floor(now / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;
  const last = buckets[buckets.length - 1];
  if (last && last.timestampMs === bucketTs) return last;
  const b: Bucket = {
    timestampMs: bucketTs,
    stalls: 0,
    errors: 0,
    bufferSamples: [],
    bitrateKbps: [],
    platforms: new Map(),
    startupMsSamples: [],
    droppedFrames: 0,
    errorsByType: new Map(),
    errorsByPlatform: new Map(),
  };
  buckets.push(b);
  return b;
}

function purgeOldBuckets(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (buckets.length > 0 && buckets[0]!.timestampMs < cutoff) {
    buckets.shift();
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.min(idx, sorted.length - 1)] ?? null;
}

export const streamHealthAggregator = {
  record(sample: TelemetrySample): void {
    purgeOldBuckets();
    const b = currentBucket();

    if (sample.stalls && sample.stalls > 0) b.stalls += sample.stalls;
    if (sample.bufferedSecs != null && sample.bufferedSecs >= 0) {
      b.bufferSamples.push(sample.bufferedSecs);
    }
    if (sample.bitrateKbps != null && sample.bitrateKbps > 0) {
      b.bitrateKbps.push(sample.bitrateKbps);
    }
    if (sample.platform) {
      b.platforms.set(sample.platform, (b.platforms.get(sample.platform) ?? 0) + 1);
    }
    if (sample.sessionId) {
      activeSessions.set(sample.sessionId, Date.now());
    }
    // Startup time tracking (A4: Observability)
    if (sample.startupMs != null && sample.startupMs > 0 && sample.event === "startup") {
      b.startupMsSamples.push(sample.startupMs);
    }
    // Dropped frames
    if (sample.droppedFrames != null && sample.droppedFrames > 0) {
      b.droppedFrames += sample.droppedFrames;
    }
  },

  recordError(platform?: string, errorType?: string): void {
    purgeOldBuckets();
    const b = currentBucket();
    b.errors += 1;
    if (platform) {
      b.platforms.set(platform, (b.platforms.get(platform) ?? 0) + 1);
      b.errorsByPlatform.set(platform, (b.errorsByPlatform.get(platform) ?? 0) + 1);
    }
    if (errorType) {
      b.errorsByType.set(errorType, (b.errorsByType.get(errorType) ?? 0) + 1);
    }
  },

  getStats(): StreamHealthStats {
    purgeOldBuckets();

    const SESSION_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
    const now = Date.now();
    for (const [id, ts] of activeSessions) {
      if (now - ts > SESSION_ACTIVE_WINDOW_MS) activeSessions.delete(id);
    }

    let totalStalls = 0;
    let totalErrors = 0;
    const allBufferSamples: number[] = [];
    const allBitrateKbps: number[] = [];
    const platformTotals = new Map<string, number>();

    for (const b of buckets) {
      totalStalls += b.stalls;
      totalErrors += b.errors;
      allBufferSamples.push(...b.bufferSamples);
      allBitrateKbps.push(...b.bitrateKbps);
      for (const [platform, count] of b.platforms) {
        platformTotals.set(platform, (platformTotals.get(platform) ?? 0) + count);
      }
    }

    const avgBufferedSecs =
      allBufferSamples.length > 0
        ? allBufferSamples.reduce((s, v) => s + v, 0) / allBufferSamples.length
        : null;

    const avgBitrateKbps =
      allBitrateKbps.length > 0
        ? allBitrateKbps.reduce((s, v) => s + v, 0) / allBitrateKbps.length
        : null;

    const platformBreakdown: Record<string, number> = {};
    for (const [p, c] of platformTotals) platformBreakdown[p] = c;

    return {
      windowMs: WINDOW_MS,
      totalStalls,
      totalErrors,
      avgBufferedSecs: avgBufferedSecs != null ? Math.round(avgBufferedSecs * 10) / 10 : null,
      avgBitrateKbps: avgBitrateKbps != null ? Math.round(avgBitrateKbps) : null,
      activeSessions: activeSessions.size,
      platformBreakdown,
      checkedAt: new Date().toISOString(),
    };
  },

  getDetailedStats(): StreamHealthDetailedStats {
    purgeOldBuckets();

    const SESSION_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
    const now = Date.now();
    for (const [id, ts] of activeSessions) {
      if (now - ts > SESSION_ACTIVE_WINDOW_MS) activeSessions.delete(id);
    }

    let totalStalls = 0;
    let totalErrors = 0;
    let totalDroppedFrames = 0;
    const allBufferSamples: number[] = [];
    const allBitrateKbps: number[] = [];
    const allStartupMs: number[] = [];
    const platformTotals = new Map<string, number>();
    const errorsByType = new Map<string, number>();
    const errorsByPlatform = new Map<string, number>();

    for (const b of buckets) {
      totalStalls += b.stalls;
      totalErrors += b.errors;
      totalDroppedFrames += b.droppedFrames;
      allBufferSamples.push(...b.bufferSamples);
      allBitrateKbps.push(...b.bitrateKbps);
      allStartupMs.push(...b.startupMsSamples);
      for (const [platform, count] of b.platforms) {
        platformTotals.set(platform, (platformTotals.get(platform) ?? 0) + count);
      }
      for (const [type, count] of b.errorsByType) {
        errorsByType.set(type, (errorsByType.get(type) ?? 0) + count);
      }
      for (const [platform, count] of b.errorsByPlatform) {
        errorsByPlatform.set(platform, (errorsByPlatform.get(platform) ?? 0) + count);
      }
    }

    const avgBufferedSecs =
      allBufferSamples.length > 0
        ? allBufferSamples.reduce((s, v) => s + v, 0) / allBufferSamples.length
        : null;
    const avgBitrateKbps =
      allBitrateKbps.length > 0
        ? allBitrateKbps.reduce((s, v) => s + v, 0) / allBitrateKbps.length
        : null;

    const platformBreakdown: Record<string, number> = {};
    for (const [p, c] of platformTotals) platformBreakdown[p] = c;

    const errorsByTypeObj: Record<string, number> = {};
    for (const [t, c] of errorsByType) errorsByTypeObj[t] = c;

    const errorsByPlatformObj: Record<string, number> = {};
    for (const [p, c] of errorsByPlatform) errorsByPlatformObj[p] = c;

    // Startup time percentiles
    const sortedStartup = [...allStartupMs].sort((a, b) => a - b);
    const avgStartupMs =
      sortedStartup.length > 0
        ? sortedStartup.reduce((s, v) => s + v, 0) / sortedStartup.length
        : null;

    // Buffer health: % of buffer samples > 10 seconds
    const BUFFER_HEALTHY_THRESHOLD = 10;
    const bufferHealthPct =
      allBufferSamples.length > 0
        ? Math.round(
            (allBufferSamples.filter((s) => s >= BUFFER_HEALTHY_THRESHOLD).length /
              allBufferSamples.length) *
              100,
          )
        : null;

    const stallsPerSession =
      activeSessions.size > 0 ? Math.round((totalStalls / activeSessions.size) * 10) / 10 : null;

    return {
      windowMs: WINDOW_MS,
      totalStalls,
      totalErrors,
      totalDroppedFrames,
      avgBufferedSecs: avgBufferedSecs != null ? Math.round(avgBufferedSecs * 10) / 10 : null,
      avgBitrateKbps: avgBitrateKbps != null ? Math.round(avgBitrateKbps) : null,
      activeSessions: activeSessions.size,
      platformBreakdown,
      errorsByType: errorsByTypeObj,
      errorsByPlatform: errorsByPlatformObj,
      startupMs: {
        p50: percentile(sortedStartup, 50),
        p95: percentile(sortedStartup, 95),
        avg: avgStartupMs != null ? Math.round(avgStartupMs) : null,
        sampleCount: sortedStartup.length,
      },
      stallsPerSession,
      bufferHealthPct,
      startupEventCount: sortedStartup.length,
      checkedAt: new Date().toISOString(),
    };
  },
};
