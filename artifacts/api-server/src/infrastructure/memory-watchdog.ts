/**
 * Memory pressure watchdog.
 *
 * Samples process.memoryUsage() on a fixed interval and:
 *
 *   1. RSS alert — emits a structured "ops-alert" SSE event when RSS
 *      exceeds MEMORY_WARN_RSS_MB for SUSTAIN_SAMPLES consecutive readings.
 *      Recovers when RSS drops 200 MB below the threshold.
 *
 *   2. External memory slope alert — tracks the rate of change of the
 *      `external` heap (native bindings, Buffer allocations) over a
 *      rolling SLOPE_WINDOW_SAMPLES window and alerts when sustained
 *      growth exceeds EXTERNAL_GROWTH_ALERT_MB_PER_MIN.
 *
 *   3. Heap-used slope alert — tracks the rate of change of V8 `heapUsed`
 *      (JS objects) over the same rolling window and alerts when sustained
 *      growth exceeds HEAP_USED_GROWTH_ALERT_MB_PER_MIN. This catches JS
 *      object leaks that don't show up in the `external` counter.
 *
 *   4. Critical escalation — in production only, voluntarily exits after
 *      CRITICAL_SAMPLES_FOR_EXIT consecutive over-threshold RSS samples so
 *      the supervisor (Replit, k8s) can restart cleanly.
 *
 * State is exposed via getWatchdogState() for the
 * GET /admin/diagnostics/memory endpoint.
 */

import { logger } from "./logger.js";
import { env } from "../config/env.js";
import { processRssGauge, SERVICE_LABELS } from "./metrics.js";
import { sampleNamedStorePeaks, getRegisteredCacheStats, purgeExpiredCacheEntries } from "./cache.js";
import { getEventLoopLagMs, isEventLoopLagAlertActive } from "./event-loop-lag.js";

const SAMPLE_INTERVAL_MS = 30_000;
const SUSTAIN_SAMPLES = 3;
const CRITICAL_SAMPLES_FOR_EXIT = 10;
// Grace period between process.kill(SIGTERM) and the hard process.exit(1)
// fallback. Must exceed the longest realistic shutdown drain sequence:
//   • SSE force-close + drain   ≈ 0-2 s
//   • app.close() drain         ≈ 0-5 s
//   • storage stream drain      ≈ 0-10 s (floor max(5 s, SHUTDOWN_DRAIN_MS))
//   • DB pool close             ≈ 0-2 s
// Total worst-case ≈ 20 s. 60 s gives 3× headroom so in-flight HLS streams
// and long-running uploads can drain without triggering the hard exit.
// Previously 30 s — which could fire while storage streams were still draining,
// resulting in "Cannot use a pool after calling end on the pool" errors.
const FORCE_EXIT_GRACE_MS = 60_000;

/**
 * Rolling window size (samples) for slope calculations AND the in-UI sparkline.
 * 60 samples × 30 s = 30 minutes of data.  A larger window reduces false
 * positives from momentary GC spikes and gives a useful sparkline history.
 */
const SLOPE_WINDOW_SAMPLES = 60;
/** Alert when external memory is growing faster than this (MB / min). */
const EXTERNAL_GROWTH_ALERT_MB_PER_MIN = 50;
/** Recovery threshold (MB / min) — external slope must fall below this to clear alert. */
const EXTERNAL_GROWTH_RECOVERY_MB_PER_MIN = 10;
/** Alert when V8 heapUsed is growing faster than this (MB / min). */
const HEAP_USED_GROWTH_ALERT_MB_PER_MIN = 30;
/** Recovery threshold (MB / min) — heapUsed slope must fall below this to clear alert. */
const HEAP_USED_GROWTH_RECOVERY_MB_PER_MIN = 5;
/** How many consecutive over-slope samples before a slope alert fires. */
const CONSECUTIVE_SLOPE_FOR_ALERT = 3;

let criticalExitInFlight = false;

export interface WatchdogState {
  enabled: boolean;
  sampleIntervalMs: number;
  thresholds: {
    rssAlertMb: number;
    rssRestartMb: number;
    rssRecoveryMb: number;
    externalGrowthAlertMbPerMin: number;
    externalGrowthRecoveryMbPerMin: number;
    heapUsedGrowthAlertMbPerMin: number;
    heapUsedGrowthRecoveryMbPerMin: number;
    sustainSamples: number;
    slopeWindowSamples: number;
    criticalSamplesForExit: number;
  };
  current: {
    rssMb: number;
    consecutiveRssOver: number;
    consecutiveRssOverRestart: number;
    externalGrowthMbPerMin: number | null;
    consecutiveSlopeOver: number;
    heapUsedGrowthMbPerMin: number | null;
    consecutiveHeapOver: number;
    eventLoopLagMs: number;
  };
  alerts: {
    rssAlertActive: boolean;
    slopeAlertActive: boolean;
    heapUsedAlertActive: boolean;
    eventLoopLagAlertActive: boolean;
  };
}

let interval: NodeJS.Timeout | null = null;
let consecutiveRssOver = 0;
/** Separate counter that only increments when RSS ≥ MEMORY_RESTART_RSS_MB.
 *  This decouples the "warn" alert from the "critical exit" trigger so the
 *  operator can set MEMORY_WARN_RSS_MB low for early visibility without the
 *  process being killed every time RSS exceeds that low watermark. */
let consecutiveRssOverRestart = 0;
let consecutiveSlopeOver = 0;
let consecutiveHeapOver = 0;
let rssAlertActive = false;
let slopeAlertActive = false;
let heapUsedAlertActive = false;
let lastRssMb = 0;
let lastExternalGrowthMbPerMin: number | null = null;
let lastHeapUsedGrowthMbPerMin: number | null = null;

/** Rolling window of { external bytes, heapUsed bytes, timestamp ms } pairs. */
const memWindow: Array<{ external: number; heapUsed: number; ts: number }> = [];

type BroadcastEngineEvent = { type: string; data: unknown };
let _emit: ((e: BroadcastEngineEvent) => void) | null = null;

async function loadEmitter() {
  if (_emit) return;
  const { broadcastEngine } = await import("../modules/broadcast/queue.engine.js");
  _emit = (e) => broadcastEngine.emit("event", e);
}

/** Calculate external memory growth rate (MB/min) from the rolling window. */
function calcExternalGrowthMbPerMin(): number | null {
  if (memWindow.length < 2) return null;
  const oldest = memWindow[0];
  const newest = memWindow[memWindow.length - 1];
  const dtMs = newest.ts - oldest.ts;
  if (dtMs < 1_000) return null;
  const deltaBytes = newest.external - oldest.external;
  const dtMin = dtMs / 60_000;
  return (deltaBytes / (1024 * 1024)) / dtMin;
}

/** Calculate V8 heapUsed growth rate (MB/min) from the rolling window. */
function calcHeapUsedGrowthMbPerMin(): number | null {
  if (memWindow.length < 2) return null;
  const oldest = memWindow[0];
  const newest = memWindow[memWindow.length - 1];
  const dtMs = newest.ts - oldest.ts;
  if (dtMs < 1_000) return null;
  const deltaBytes = newest.heapUsed - oldest.heapUsed;
  const dtMin = dtMs / 60_000;
  return (deltaBytes / (1024 * 1024)) / dtMin;
}

function sample() {
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / (1024 * 1024));
  lastRssMb = rssMb;
  processRssGauge.set(SERVICE_LABELS, mem.rss);
  const thresholdMb = env.MEMORY_WARN_RSS_MB;
  // The restart threshold must be ≥ the warn threshold. If the operator
  // configures MEMORY_RESTART_RSS_MB lower than MEMORY_WARN_RSS_MB (or
  // leaves MEMORY_RESTART_RSS_MB at its default while setting a high
  // MEMORY_WARN_RSS_MB) we clamp to the larger of the two so the process
  // is never killed before the warn alert has had a chance to fire.
  const restartThresholdMb = Math.max(env.MEMORY_RESTART_RSS_MB, thresholdMb);

  // ── RSS tracking ───────────────────────────────────────────────────────────
  if (rssMb >= thresholdMb) {
    consecutiveRssOver++;
  } else {
    if (rssAlertActive && rssMb < thresholdMb - 200) {
      rssAlertActive = false;
      logger.info({ rssMb, thresholdMb }, "[memory-watchdog] RSS pressure recovered");
      _emit?.({
        type: "ops-alert",
        data: {
          level: "info",
          code: "memory-recovered",
          message: `RSS dropped to ${rssMb} MB (threshold: ${thresholdMb} MB)`,
          rssMb,
          thresholdMb,
        },
      });
    }
    consecutiveRssOver = 0;
  }

  // Track a separate counter for the restart (critical-exit) threshold.
  // This is independent from the warn counter so a server sitting between
  // the warn threshold and the restart threshold emits alerts but is NOT
  // killed — which is the expected behaviour when MEMORY_WARN_RSS_MB is
  // set low for early-warning visibility on a constrained host.
  if (rssMb >= restartThresholdMb) {
    consecutiveRssOverRestart++;
  } else {
    consecutiveRssOverRestart = 0;
  }

  if (consecutiveRssOver >= SUSTAIN_SAMPLES && !rssAlertActive) {
    rssAlertActive = true;
    logger.warn(
      { rssMb, thresholdMb, consecutiveRssOver },
      "[memory-watchdog] RSS threshold exceeded — emitting ops-alert",
    );
    void import("./sentry.js").then(({ captureEvent }) =>
      captureEvent(
        `[memory-watchdog] RSS sustained above ${thresholdMb} MB (current: ${rssMb} MB) — OOM risk elevated`,
        "warning",
        { rssMb, thresholdMb, consecutiveSamples: consecutiveRssOver },
      ),
    ).catch(() => {});
    _emit?.({
      type: "ops-alert",
      data: {
        level: "warn",
        code: "memory-pressure",
        message: `RSS has been above ${thresholdMb} MB for ${consecutiveRssOver} consecutive samples (current: ${rssMb} MB). OOM risk is elevated.`,
        rssMb,
        thresholdMb,
        consecutiveSamples: consecutiveRssOver,
      },
    });
  } else if (rssAlertActive && consecutiveRssOver % 60 === 0) {
    // Fire a "still elevated" reminder every 60 samples (60 × 30 s = 30 min).
    // The previous cadence of every 10 samples (5 min) produced a new toast
    // every 5 minutes even though the message text changes slightly each time
    // (different rssMb value), bypassing the admin UI's code-based dedup and
    // stacking identical-looking alerts in the notification panel. At 30 min
    // the reminder is still timely for an overnight on-call check, but not
    // noisy enough to fill the toast stack during a quiet steady-state.
    _emit?.({
      type: "ops-alert",
      data: {
        level: "warn",
        code: "memory-pressure",
        message: `RSS still elevated: ${rssMb} MB (threshold: ${thresholdMb} MB, ${consecutiveRssOver} samples over)`,
        rssMb,
        thresholdMb,
        consecutiveSamples: consecutiveRssOver,
      },
    });
  }

  // ── Named store peak sampling ─────────────────────────────────────────────
  // Update lifetime high-water marks for every registered in-memory store so
  // peaks accumulate accurately on a fixed cadence regardless of whether the
  // diagnostics endpoint is actively being polled by an operator.
  sampleNamedStorePeaks();

  // ── Slope tracking (shared rolling window) ────────────────────────────────
  memWindow.push({ external: mem.external, heapUsed: mem.heapUsed, ts: Date.now() });
  if (memWindow.length > SLOPE_WINDOW_SAMPLES) memWindow.shift();

  // ── External memory slope alert ───────────────────────────────────────────
  const externalGrowthRate = calcExternalGrowthMbPerMin();
  lastExternalGrowthMbPerMin = externalGrowthRate !== null ? Math.round(externalGrowthRate * 10) / 10 : null;

  if (externalGrowthRate !== null && externalGrowthRate > EXTERNAL_GROWTH_ALERT_MB_PER_MIN) {
    consecutiveSlopeOver++;
    if (consecutiveSlopeOver >= CONSECUTIVE_SLOPE_FOR_ALERT && !slopeAlertActive) {
      slopeAlertActive = true;
      logger.warn(
        { growthMbPerMin: Math.round(externalGrowthRate * 10) / 10, threshold: EXTERNAL_GROWTH_ALERT_MB_PER_MIN },
        "[memory-watchdog] external memory growth rate exceeded threshold",
      );
      _emit?.({
        type: "ops-alert",
        data: {
          level: "warn",
          code: "memory-external-growth",
          message: `External memory growing at ${Math.round(externalGrowthRate * 10) / 10} MB/min (threshold: ${EXTERNAL_GROWTH_ALERT_MB_PER_MIN} MB/min) — possible native memory leak`,
          growthMbPerMin: Math.round(externalGrowthRate * 10) / 10,
          threshold: EXTERNAL_GROWTH_ALERT_MB_PER_MIN,
        },
      });
    }
  } else if (slopeAlertActive && (externalGrowthRate === null || externalGrowthRate < EXTERNAL_GROWTH_RECOVERY_MB_PER_MIN)) {
    slopeAlertActive = false;
    consecutiveSlopeOver = 0;
    logger.info(
      { growthMbPerMin: lastExternalGrowthMbPerMin },
      "[memory-watchdog] external memory growth rate recovered",
    );
    _emit?.({
      type: "ops-alert",
      data: {
        level: "info",
        code: "memory-external-recovered",
        message: `External memory growth rate recovered (${lastExternalGrowthMbPerMin ?? 0} MB/min)`,
        growthMbPerMin: lastExternalGrowthMbPerMin ?? 0,
      },
    });
  } else if (!slopeAlertActive) {
    consecutiveSlopeOver = 0;
  }

  // ── V8 heapUsed slope alert ───────────────────────────────────────────────
  // Tracks JS object allocations. Positive sustained slope indicates a JS
  // object leak (closures, Maps/Sets that grow unboundedly, event listener
  // accumulation, etc.). GC can cause the instantaneous slope to be negative,
  // so we require CONSECUTIVE_SLOPE_FOR_ALERT samples above threshold before
  // triggering — this avoids false-positives from normal GC cycles.
  const heapGrowthRate = calcHeapUsedGrowthMbPerMin();
  lastHeapUsedGrowthMbPerMin = heapGrowthRate !== null ? Math.round(heapGrowthRate * 10) / 10 : null;

  if (heapGrowthRate !== null && heapGrowthRate > HEAP_USED_GROWTH_ALERT_MB_PER_MIN) {
    consecutiveHeapOver++;
    if (consecutiveHeapOver >= CONSECUTIVE_SLOPE_FOR_ALERT && !heapUsedAlertActive) {
      heapUsedAlertActive = true;
      logger.warn(
        { growthMbPerMin: Math.round(heapGrowthRate * 10) / 10, threshold: HEAP_USED_GROWTH_ALERT_MB_PER_MIN },
        "[memory-watchdog] V8 heapUsed growth rate exceeded threshold — possible JS object leak",
      );
      void import("./sentry.js").then(({ captureEvent }) =>
        captureEvent(
          `[memory-watchdog] V8 heapUsed growing at ${Math.round(heapGrowthRate * 10) / 10} MB/min — possible JS object leak`,
          "warning",
          { growthMbPerMin: Math.round(heapGrowthRate * 10) / 10, threshold: HEAP_USED_GROWTH_ALERT_MB_PER_MIN },
        ),
      ).catch(() => {});
      _emit?.({
        type: "ops-alert",
        data: {
          level: "warn",
          code: "memory-heap-growth",
          message: `V8 heapUsed growing at ${Math.round(heapGrowthRate * 10) / 10} MB/min (threshold: ${HEAP_USED_GROWTH_ALERT_MB_PER_MIN} MB/min) — possible JS object leak`,
          growthMbPerMin: Math.round(heapGrowthRate * 10) / 10,
          threshold: HEAP_USED_GROWTH_ALERT_MB_PER_MIN,
        },
      });
    }
  } else if (heapUsedAlertActive && (heapGrowthRate === null || heapGrowthRate < HEAP_USED_GROWTH_RECOVERY_MB_PER_MIN)) {
    heapUsedAlertActive = false;
    consecutiveHeapOver = 0;
    logger.info(
      { growthMbPerMin: lastHeapUsedGrowthMbPerMin },
      "[memory-watchdog] V8 heapUsed growth rate recovered",
    );
    _emit?.({
      type: "ops-alert",
      data: {
        level: "info",
        code: "memory-heap-recovered",
        message: `V8 heapUsed growth rate recovered (${lastHeapUsedGrowthMbPerMin ?? 0} MB/min)`,
        growthMbPerMin: lastHeapUsedGrowthMbPerMin ?? 0,
      },
    });
  } else if (!heapUsedAlertActive) {
    consecutiveHeapOver = 0;
  }

  // ── Proactive GC nudge ───────────────────────────────────────────────────
  // When RSS is in the warn zone, nudge V8's garbage collector to free
  // unreferenced Buffer memory (e.g. completed HLS segment responses waiting
  // for collection). This can reduce RSS enough to avoid crossing the restart
  // threshold and triggering a full restart cycle.
  //
  // Only runs when Node.js is started with --expose-gc (production start:prod
  // script does NOT include it by default, so gcFn will be undefined in most
  // environments and this becomes a no-op).  Set EXPOSE_GC=1 in your process
  // manager / Render env and add --expose-gc to the start:prod node flags to
  // enable this safety valve.
  // Nudge V8's GC when RSS is in the warn zone OR when heapUsed is growing
  // faster than the alert threshold. Previously this only triggered on RSS
  // pressure; adding the heapUsed guard lets the GC reclaim leaked JS objects
  // before they push RSS past the restart threshold, buying recovery time.
  if (rssAlertActive || heapUsedAlertActive) {
    // First, flush expired in-process cache entries so the GC has smaller
    // live-set to scan. This reliably reclaims catalog/broadcast JSON objects
    // that are past their TTL but haven't been touched (lazy eviction would
    // leave them in the Map until their key is accessed, which may be never
    // on a 24/7 server after a video rotation).
    const purged = purgeExpiredCacheEntries();
    if (purged > 0) {
      logger.info({ purged }, "[memory-watchdog] flushed expired cache entries during pressure");
    }
  }
  const gcFn = (global as { gc?: () => void }).gc;
  if ((rssAlertActive || heapUsedAlertActive) && gcFn) {
    gcFn();
  }

  // ── Critical escalation (production only) ────────────────────────────────
  // Uses consecutiveRssOverRestart (RSS ≥ MEMORY_RESTART_RSS_MB) rather than
  // consecutiveRssOver (RSS ≥ MEMORY_WARN_RSS_MB) so a low warn threshold
  // does NOT cause the process to exit — it only triggers the ops-alert above.
  if (
    env.NODE_ENV === "production" &&
    consecutiveRssOverRestart >= CRITICAL_SAMPLES_FOR_EXIT &&
    !criticalExitInFlight
  ) {
    criticalExitInFlight = true;
    const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
    const externalMb  = Math.round(mem.external  / (1024 * 1024));
    // Snapshot the full memory breakdown at the moment of exit so engineers
    // can distinguish Buffer pressure (externalMb high) from heap leaks
    // (heapUsedMb high) when reviewing logs after a restart cycle.
    logger.fatal(
      {
        rssMb,
        heapUsedMb,
        heapTotalMb,
        externalMb,
        arrayBuffersMb: Math.round(mem.arrayBuffers / (1024 * 1024)),
        warnThresholdMb: thresholdMb,
        restartThresholdMb,
        consecutiveRssOver,
        consecutiveRssOverRestart,
        criticalThreshold: CRITICAL_SAMPLES_FOR_EXIT,
      },
      "[memory-watchdog] CRITICAL: sustained memory pressure — initiating graceful exit (supervisor will restart)",
    );
    void import("./sentry.js").then(({ captureEvent }) =>
      captureEvent(
        `[memory-watchdog] CRITICAL: RSS sustained above restart threshold ${restartThresholdMb} MB for ${consecutiveRssOverRestart} samples — forcing graceful exit`,
        "fatal",
        { rssMb, restartThresholdMb, consecutiveRssOverRestart, graceMs: FORCE_EXIT_GRACE_MS },
      ),
    ).catch(() => {});
    _emit?.({
      type: "ops-alert",
      data: {
        level: "fatal",
        code: "memory-critical-exit",
        message: `RSS sustained above restart threshold ${restartThresholdMb} MB for ${consecutiveRssOverRestart} samples — process will exit for clean restart in ${FORCE_EXIT_GRACE_MS / 1000}s`,
        rssMb,
        restartThresholdMb,
        graceMs: FORCE_EXIT_GRACE_MS,
      },
    });
    // Email alert (fire-and-forget before SIGTERM). SSE only reaches an open
    // admin dashboard — email is the only out-of-band signal for an overnight
    // OOM restart that would otherwise appear only as a gap in uptime metrics.
    void import("../modules/mail/mail.service.js")
      .then(({ sendAdminAlert }) =>
        sendAdminAlert({
          subject: "API process restarting — critical memory pressure",
          severity: "critical",
          body: [
            `RSS has been above the restart threshold (${restartThresholdMb} MB) for ${consecutiveRssOverRestart} consecutive samples.`,
            `Current: ${rssMb} MB  |  heap: ${heapUsedMb}/${heapTotalMb} MB  |  external: ${externalMb} MB`,
            "",
            `The process is sending SIGTERM now and will exit in ${FORCE_EXIT_GRACE_MS / 1000}s.`,
            "The supervisor (Render/k8s) will restart it automatically.",
            "",
            "If restarts are frequent, reduce HLS_MAX_CONCURRENT or raise your host memory.",
          ].join("\n"),
        }),
      )
      .catch(() => {/* non-fatal — process is about to exit anyway */});
    process.kill(process.pid, "SIGTERM");
    const forceExitTimer = setTimeout(() => {
      logger.fatal(
        { graceMs: FORCE_EXIT_GRACE_MS },
        "[memory-watchdog] graceful drain exceeded budget — force-exiting now",
      );
      process.exit(1);
    }, FORCE_EXIT_GRACE_MS);
    forceExitTimer.unref();
  }
}

/**
 * Returns the rolling memory sample window as MB-valued objects for sparkline
 * rendering.  The window holds up to SLOPE_WINDOW_SAMPLES entries at
 * SAMPLE_INTERVAL_MS cadence (default: 6 × 30 s = last 3 minutes).
 */
export function getMemoryHistory(): Array<{ ts: number; heapUsedMb: number; externalMb: number }> {
  const MiB = 1024 * 1024;
  return memWindow.map(({ ts, heapUsed, external }) => ({
    ts,
    heapUsedMb: Math.round((heapUsed / MiB) * 10) / 10,
    externalMb: Math.round((external / MiB) * 10) / 10,
  }));
}

/** Write one row to memory_hourly_snapshots.  Uses a dynamic import so the
 *  watchdog has no hard dep on DB at module load time (avoids init-order races). */
async function persistHourlySnapshot(row: {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  heapUsedGrowthMbPerMin: number | null;
  externalGrowthMbPerMin: number | null;
  namedStores: Array<{ name: string; size: number; peak: number }>;
}): Promise<void> {
  const { db, schema } = await import("./db.js");
  const { lt } = await import("drizzle-orm");
  await db.insert(schema.memoryHourlySnapshotsTable).values(row);

  // Prune rows older than 7 days so the table doesn't grow unboundedly on
  // long-running servers.  Fire-and-forget — non-fatal if it fails.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  db.delete(schema.memoryHourlySnapshotsTable)
    .where(lt(schema.memoryHourlySnapshotsTable.snapshotAt, cutoff))
    .catch((err: unknown) => {
      logger.warn({ err }, "[memory-watchdog] snapshot prune failed — non-fatal");
    });
}

function logMemorySummary(): void {
  const m = process.memoryUsage();
  const mb = (b: number) => Math.round((b / (1024 * 1024)) * 10) / 10;
  const stores = getRegisteredCacheStats().map(({ name, size, peak }) => ({ name, size, peak }));
  logger.info(
    {
      rssMb: mb(m.rss),
      heapUsedMb: mb(m.heapUsed),
      heapTotalMb: mb(m.heapTotal),
      externalMb: mb(m.external),
      arrayBuffersMb: mb(m.arrayBuffers),
      externalGrowthMbPerMin: lastExternalGrowthMbPerMin,
      heapUsedGrowthMbPerMin: lastHeapUsedGrowthMbPerMin,
      alerts: { rssAlertActive, slopeAlertActive, heapUsedAlertActive },
      stores,
    },
    "[memory-watchdog] hourly memory summary",
  );
  persistHourlySnapshot({
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external),
    heapUsedGrowthMbPerMin: lastHeapUsedGrowthMbPerMin,
    externalGrowthMbPerMin: lastExternalGrowthMbPerMin,
    namedStores: stores,
  }).catch((err) => {
    logger.warn({ err }, "[memory-watchdog] hourly snapshot persist failed — non-fatal");
  });
}

const HOURLY_LOG_INTERVAL_MS = 60 * 60_000;
let hourlyLogInterval: NodeJS.Timeout | null = null;

export function startMemoryWatchdog(): void {
  if (interval) return;
  loadEmitter().catch(() => { /* non-fatal */ });
  interval = setInterval(() => {
    loadEmitter().then(() => sample()).catch(() => { /* non-fatal */ });
  }, SAMPLE_INTERVAL_MS);
  interval.unref();
  hourlyLogInterval = setInterval(logMemorySummary, HOURLY_LOG_INTERVAL_MS);
  hourlyLogInterval.unref();
  logger.info(
    { thresholdMb: env.MEMORY_WARN_RSS_MB, intervalMs: SAMPLE_INTERVAL_MS },
    "[memory-watchdog] started",
  );

  // Warn operators when MEMORY_RESTART_RSS_MB is configured too aggressively
  // for a server that serves HLS segments, runs FFmpeg transcodes, and assembles
  // large uploads.  RSS budget components:
  //   baseline      ≈ 300–400 MB  (V8 heap + glibc arenas + pg pool + pino)
  //   HLS           ≈ 24 MB per concurrent stream (16 MiB BYTEA + 8 MiB Buffer)
  //   FFmpeg encode ≈ 200–800 MB per active job (depends on resolution/codec)
  //   upload assembly ≈ O(1) in Node (iterative pg UPDATE), negligible heap cost
  //
  // Recommended minimums:
  //   2 GiB host:  MEMORY_RESTART_RSS_MB=1536  (default)
  //   4 GiB host:  MEMORY_RESTART_RSS_MB=3072
  //   Constrained (512 MiB free-tier): MEMORY_RESTART_RSS_MB=460, HLS_MAX_CONCURRENT=5
  //
  // Previous root cause of restart loops: MEMORY_RESTART_RSS_MB set below the
  // estimated peak RSS caused the watchdog to fire on normal HLS load.
  const effectiveRestartMb = Math.max(env.MEMORY_RESTART_RSS_MB, env.MEMORY_WARN_RSS_MB);
  if (effectiveRestartMb < 350) {
    // < 350 MB is genuinely dangerous on any host — RSS at idle typically
    // reaches 300–380 MB (V8 heap + glibc arenas + pg pool + pino buffers) and
    // the process would restart before serving a single request.
    logger.warn(
      {
        MEMORY_RESTART_RSS_MB: env.MEMORY_RESTART_RSS_MB,
        MEMORY_WARN_RSS_MB: env.MEMORY_WARN_RSS_MB,
        effectiveRestartMb,
        recommendedMinimumMb: 400,
      },
      "[memory-watchdog] MEMORY_RESTART_RSS_MB is dangerously low — the process " +
      "will restart before it can serve requests. Set to ≥ 400 MB for constrained hosts, " +
      "≥ 1536 MB for production hosts with ≥ 2 GiB RAM.",
    );
  } else if (effectiveRestartMb < 500) {
    // 350–499 MB: acceptable on memory-constrained hosts (512 MiB free tier)
    // when HLS_MAX_CONCURRENT is tuned low enough that peak RSS stays under
    // the threshold. Formula: baseline(~350 MB) + 24×HLS_MAX_CONCURRENT.
    // At HLS_MAX_CONCURRENT=5: peak ≈ 470 MB — set MEMORY_RESTART_RSS_MB=470.
    // For production hosts with ≥ 2 GiB RAM set MEMORY_RESTART_RSS_MB ≥ 1536.
    logger.info(
      {
        MEMORY_RESTART_RSS_MB: env.MEMORY_RESTART_RSS_MB,
        MEMORY_WARN_RSS_MB: env.MEMORY_WARN_RSS_MB,
        effectiveRestartMb,
        note: "constrained-host mode — verify HLS_MAX_CONCURRENT and TRANSCODER_DISABLE match your host RAM",
      },
      "[memory-watchdog] running in constrained-host mode (restart threshold < 500 MB). " +
      "Intentional on memory-constrained instances. For ≥ 2 GiB production hosts " +
      "set MEMORY_RESTART_RSS_MB ≥ 1536 and MEMORY_WARN_RSS_MB ≥ 1024.",
    );
  }
}

export function stopMemoryWatchdog(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  if (hourlyLogInterval) {
    clearInterval(hourlyLogInterval);
    hourlyLogInterval = null;
  }
}

export function getWatchdogState(): WatchdogState {
  const restartMb = Math.max(env.MEMORY_RESTART_RSS_MB, env.MEMORY_WARN_RSS_MB);
  return {
    enabled: interval !== null,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    thresholds: {
      rssAlertMb: env.MEMORY_WARN_RSS_MB,
      rssRestartMb: restartMb,
      rssRecoveryMb: env.MEMORY_WARN_RSS_MB - 200,
      externalGrowthAlertMbPerMin: EXTERNAL_GROWTH_ALERT_MB_PER_MIN,
      externalGrowthRecoveryMbPerMin: EXTERNAL_GROWTH_RECOVERY_MB_PER_MIN,
      heapUsedGrowthAlertMbPerMin: HEAP_USED_GROWTH_ALERT_MB_PER_MIN,
      heapUsedGrowthRecoveryMbPerMin: HEAP_USED_GROWTH_RECOVERY_MB_PER_MIN,
      sustainSamples: SUSTAIN_SAMPLES,
      slopeWindowSamples: SLOPE_WINDOW_SAMPLES,
      criticalSamplesForExit: CRITICAL_SAMPLES_FOR_EXIT,
    },
    current: {
      rssMb: lastRssMb,
      consecutiveRssOver,
      consecutiveRssOverRestart,
      externalGrowthMbPerMin: lastExternalGrowthMbPerMin,
      consecutiveSlopeOver,
      heapUsedGrowthMbPerMin: lastHeapUsedGrowthMbPerMin,
      consecutiveHeapOver,
      eventLoopLagMs: getEventLoopLagMs(),
    },
    alerts: {
      rssAlertActive,
      slopeAlertActive,
      heapUsedAlertActive,
      eventLoopLagAlertActive: isEventLoopLagAlertActive(),
    },
  };
}
