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
 *   4. Critical escalation — in production only, runs a self-healing relief
 *      pass (cancel faststart jobs, drain HLS cache, run GC) after
 *      CRITICAL_SAMPLES_FOR_EXIT consecutive over-threshold RSS samples.
 *      The process does NOT auto-restart; all thresholds are log-only.
 *      Relief re-fires after RELIEF_COOLDOWN_MS if pressure persists.
 *
 * State is exposed via getWatchdogState() for the
 * GET /admin/diagnostics/memory endpoint.
 */

import v8 from "node:v8";
import { logger } from "./logger.js";
import { env } from "../config/env.js";
import { processRssGauge, SERVICE_LABELS } from "./metrics.js";
import { sampleNamedStorePeaks, getRegisteredCacheStats, purgeExpiredCacheEntries } from "./cache.js";
import { getEventLoopLagMs, isEventLoopLagAlertActive } from "./event-loop-lag.js";
import { adminEventBus } from "../modules/admin-ops/admin-event-bus.js";

/**
 * Reduced from 30 s → 10 s for faster Exit-Code-134 (V8 OOM abort) prevention.
 *
 * At 30 s, CRITICAL_SAMPLES_FOR_EXIT × 30 s = 5 min of sustained over-threshold
 * RSS before a graceful restart was triggered — long enough for V8 to exhaust
 * its old-space limit and SIGABRT the process with code 134 before the watchdog
 * could act.  At 10 s the detection window shrinks to ~3 min, giving the
 * watchdog a realistic chance to SIGTERM cleanly before V8 aborts.
 *
 * Slope-window samples are scaled up proportionally (60 → 180) so the rolling
 * 30-minute history is preserved.  All SUSTAIN_SAMPLES and CRITICAL_SAMPLES
 * thresholds are recalibrated to maintain the same real-time durations.
 */
const SAMPLE_INTERVAL_MS = 10_000;
/**
 * Consecutive over-threshold samples before a warn alert fires.
 * 6 × 10 s = 60 s (same 60 s wall-clock as the old 2 × 30 s).
 */
const SUSTAIN_SAMPLES = 6;
/**
 * Consecutive RESTART-threshold samples before a graceful exit is triggered.
 * 8 × 10 s = 80 s — down from 18 × 10 s (3 min).  3 min was long enough for
 * RSS to climb from 470 → 821 MiB on the Render 512 MiB free tier during a
 * concurrent-upload + HLS spike.  80 s still distinguishes a brief spike from
 * genuine sustained pressure (a transient spike that lasts > 80 s IS genuine
 * pressure on a memory-constrained host) while cutting the balloon window by
 * ~2 min.  MEMORY_ABSOLUTE_MAX_RSS_MB provides an additional hard ceiling for
 * true emergency escalation without any consecutive-count requirement.
 */
const CRITICAL_SAMPLES_FOR_EXIT = 8;
/**
 * Minimum time between consecutive relief attempts when the process stays
 * above the restart threshold after a failed relief pass.  Prevents
 * rapid-fire relief loops.  90 s gives the GC / allocator time to release
 * memory between attempts without being so long that pressure balloons
 * unchecked.
 */
const RELIEF_COOLDOWN_MS = 90_000;

/**
 * Rolling window size (samples) for slope calculations AND the in-UI sparkline.
 * 180 samples × 10 s = 30 minutes of data (same wall-clock as the old 60 × 30 s).
 * A larger window reduces false positives from momentary GC spikes and gives a
 * useful sparkline history.
 */
const SLOPE_WINDOW_SAMPLES = 180;

/**
 * V8 heap utilisation above which a proactive GC nudge fires even when RSS is
 * still below the warn threshold.  V8 aborts with SIGABRT (Exit Code 134) when
 * heapUsed approaches heap_size_limit — catching this BEFORE RSS crosses the
 * MEMORY_RESTART threshold is the primary defence against code-134 crashes.
 *
 * At 88 % utilisation we run a full GC + cache purge; if heapUsed stays ≥ 93 %
 * for V8_HEAP_CRITICAL_SAMPLES consecutive ticks we trigger a graceful SIGTERM
 * restart before V8 can abort.
 */
const V8_HEAP_WARN_PCT = 0.88;
const V8_HEAP_CRITICAL_PCT = 0.93;
const V8_HEAP_CRITICAL_SAMPLES = 6; // 6 × 10 s = 60 s before graceful restart
let consecutiveV8HeapCritical = 0;
let v8HeapAlertActive = false;
/** Alert when external memory is growing faster than this (MB / min). */
const EXTERNAL_GROWTH_ALERT_MB_PER_MIN = 50;
/** Recovery threshold (MB / min) — external slope must fall below this to clear alert. */
const EXTERNAL_GROWTH_RECOVERY_MB_PER_MIN = 10;
/** Alert when V8 heapUsed is growing faster than this (MB / min). */
const HEAP_USED_GROWTH_ALERT_MB_PER_MIN = 30;
/** Recovery threshold (MB / min) — heapUsed slope must fall below this to clear alert. */
const HEAP_USED_GROWTH_RECOVERY_MB_PER_MIN = 5;
/**
 * Alert when ArrayBuffers are growing faster than this (MB / min).
 * ArrayBuffers are a subset of `external` (they ARE counted in `external`)
 * but tracking them separately lets the watchdog surface HLS segment-cache /
 * Buffer-pool pressure distinctly from native C++ object growth.
 * Threshold is tighter than the `external` alert (50 MB/min) because normal
 * ArrayBuffer churn during steady-state HLS serving is < 5 MB/min.
 */
const ARRAY_BUFFERS_GROWTH_ALERT_MB_PER_MIN = 20;
/** Recovery threshold (MB / min) for the arrayBuffers slope alert. */
const ARRAY_BUFFERS_GROWTH_RECOVERY_MB_PER_MIN = 5;
/** How many consecutive over-slope samples before a slope alert fires. */
const CONSECUTIVE_SLOPE_FOR_ALERT = 3;

let criticalExitInFlight = false;
/** ms timestamp of when the most recent relief attempt started. Used to enforce RELIEF_COOLDOWN_MS. */
let lastReliefAttemptMs = 0;

/** Separate slope-alert state for the ArrayBuffers metric. */
let arrayBuffersAlertActive = false;
let lastArrayBuffersMbPerMin: number | null = null;
let consecutiveArrayBuffersOver = 0;

export interface WatchdogState {
  enabled: boolean;
  sampleIntervalMs: number;
  thresholds: {
    rssAlertMb: number;
    rssRestartMb: number;
    rssAbsoluteMaxMb: number;
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
    arrayBuffersAlertActive: boolean;
    eventLoopLagAlertActive: boolean;
  };
}

let interval: NodeJS.Timeout | null = null;
let consecutiveRssOver = 0;
// NOTE: consecutiveArrayBuffersOver, arrayBuffersAlertActive, lastArrayBuffersMbPerMin
// are declared above (before the WatchdogState interface) as module-level state.
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

/** Rolling window of { external bytes, heapUsed bytes, arrayBuffers bytes, timestamp ms } pairs. */
const memWindow: Array<{ external: number; heapUsed: number; arrayBuffers: number; ts: number }> = [];

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

/**
 * Calculate ArrayBuffers growth rate (MB/min) from the rolling window.
 * ArrayBuffers track Buffer/TypedArray allocations — the dominant source is
 * the HLS segment in-process cache.  A sustained positive slope here
 * indicates the segment cache is being filled faster than it is evicted,
 * or that Buffers created during upload/transcode are not being released.
 */
function calcArrayBuffersGrowthMbPerMin(): number | null {
  if (memWindow.length < 2) return null;
  const oldest = memWindow[0];
  const newest = memWindow[memWindow.length - 1];
  const dtMs = newest.ts - oldest.ts;
  if (dtMs < 1_000) return null;
  const deltaBytes = newest.arrayBuffers - oldest.arrayBuffers;
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
      adminEventBus.push("ops-alert", {
        level: "info",
        code: "memory-recovered",
        message: `RSS dropped to ${rssMb} MB (threshold: ${thresholdMb} MB)`,
        rssMb,
        thresholdMb,
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
    adminEventBus.push("ops-alert", {
      level: "warn",
      code: "memory-pressure",
      message: `RSS has been above ${thresholdMb} MB for ${consecutiveRssOver} consecutive samples (current: ${rssMb} MB). OOM risk is elevated.`,
      rssMb,
      thresholdMb,
      consecutiveSamples: consecutiveRssOver,
    });
    // Trim HLS segment cache on first RSS alert — it is the largest
    // controllable Buffer consumer and a trim may recover enough RSS to
    // avoid crossing the restart threshold entirely.
    void import("../modules/video-serve/video-serve.routes.js")
      .then(({ trimHlsSegmentCache }) => {
        const hlsCacheMb = env.HLS_SEGMENT_CACHE_MB;
        const freed = trimHlsSegmentCache(hlsCacheMb / 2);
        if (freed > 0) {
          logger.info(
            { freedBytes: freed, targetMb: hlsCacheMb / 2 },
            "[memory-watchdog] trimmed HLS segment cache under RSS pressure",
          );
        }
      })
      .catch(() => {/* non-fatal — module may not be initialised yet */});
  } else if (rssAlertActive && consecutiveRssOver % 60 === 0) {
    // Fire a "still elevated" reminder every 60 samples (60 × 30 s = 30 min).
    // The previous cadence of every 10 samples (5 min) produced a new toast
    // every 5 minutes even though the message text changes slightly each time
    // (different rssMb value), bypassing the admin UI's code-based dedup and
    // stacking identical-looking alerts in the notification panel. At 30 min
    // the reminder is still timely for an overnight on-call check, but not
    // noisy enough to fill the toast stack during a quiet steady-state.
    adminEventBus.push("ops-alert", {
      level: "warn",
      code: "memory-pressure",
      message: `RSS still elevated: ${rssMb} MB (threshold: ${thresholdMb} MB, ${consecutiveRssOver} samples over)`,
      rssMb,
      thresholdMb,
      consecutiveSamples: consecutiveRssOver,
    });
  }

  // ── Named store peak sampling ─────────────────────────────────────────────
  // Update lifetime high-water marks for every registered in-memory store so
  // peaks accumulate accurately on a fixed cadence regardless of whether the
  // diagnostics endpoint is actively being polled by an operator.
  sampleNamedStorePeaks();

  // ── Slope tracking (shared rolling window) ────────────────────────────────
  memWindow.push({ external: mem.external, heapUsed: mem.heapUsed, arrayBuffers: mem.arrayBuffers, ts: Date.now() });
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
      adminEventBus.push("ops-alert", {
        level: "warn",
        code: "memory-external-growth",
        message: `External memory growing at ${Math.round(externalGrowthRate * 10) / 10} MB/min (threshold: ${EXTERNAL_GROWTH_ALERT_MB_PER_MIN} MB/min) — possible native memory leak`,
        growthMbPerMin: Math.round(externalGrowthRate * 10) / 10,
        threshold: EXTERNAL_GROWTH_ALERT_MB_PER_MIN,
      });
    }
  } else if (slopeAlertActive && (externalGrowthRate === null || externalGrowthRate < EXTERNAL_GROWTH_RECOVERY_MB_PER_MIN)) {
    slopeAlertActive = false;
    consecutiveSlopeOver = 0;
    logger.info(
      { growthMbPerMin: lastExternalGrowthMbPerMin },
      "[memory-watchdog] external memory growth rate recovered",
    );
    adminEventBus.push("ops-alert", {
      level: "info",
      code: "memory-external-recovered",
      message: `External memory growth rate recovered (${lastExternalGrowthMbPerMin ?? 0} MB/min)`,
      growthMbPerMin: lastExternalGrowthMbPerMin ?? 0,
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
      adminEventBus.push("ops-alert", {
        level: "warn",
        code: "memory-heap-growth",
        message: `V8 heapUsed growing at ${Math.round(heapGrowthRate * 10) / 10} MB/min (threshold: ${HEAP_USED_GROWTH_ALERT_MB_PER_MIN} MB/min) — possible JS object leak`,
        growthMbPerMin: Math.round(heapGrowthRate * 10) / 10,
        threshold: HEAP_USED_GROWTH_ALERT_MB_PER_MIN,
      });
    }
  } else if (heapUsedAlertActive && (heapGrowthRate === null || heapGrowthRate < HEAP_USED_GROWTH_RECOVERY_MB_PER_MIN)) {
    heapUsedAlertActive = false;
    consecutiveHeapOver = 0;
    logger.info(
      { growthMbPerMin: lastHeapUsedGrowthMbPerMin },
      "[memory-watchdog] V8 heapUsed growth rate recovered",
    );
    adminEventBus.push("ops-alert", {
      level: "info",
      code: "memory-heap-recovered",
      message: `V8 heapUsed growth rate recovered (${lastHeapUsedGrowthMbPerMin ?? 0} MB/min)`,
      growthMbPerMin: lastHeapUsedGrowthMbPerMin ?? 0,
    });
  } else if (!heapUsedAlertActive) {
    consecutiveHeapOver = 0;
  }

  // ── ArrayBuffers slope alert + HLS segment cache trim ────────────────────
  // A sustained positive slope in `arrayBuffers` means Buffer memory is not
  // being released — most likely the HLS segment LRU is filling faster than
  // it evicts.  On first alert we attempt a proactive trim of the cache to
  // its configured half-limit before emitting the ops-alert, giving the
  // process a chance to recover without operator intervention.
  const abGrowthRate = calcArrayBuffersGrowthMbPerMin();
  lastArrayBuffersMbPerMin = abGrowthRate !== null ? Math.round(abGrowthRate * 10) / 10 : null;

  if (abGrowthRate !== null && abGrowthRate > ARRAY_BUFFERS_GROWTH_ALERT_MB_PER_MIN) {
    consecutiveArrayBuffersOver++;
    if (consecutiveArrayBuffersOver >= CONSECUTIVE_SLOPE_FOR_ALERT && !arrayBuffersAlertActive) {
      arrayBuffersAlertActive = true;
      // Proactively trim the HLS segment cache to half its configured limit
      // before alerting, so a transient burst of segment requests doesn't
      // trigger unnecessary ops noise if the cache self-corrects.
      void import("../modules/video-serve/video-serve.routes.js")
        .then(({ trimHlsSegmentCache }) => {
          const hlsCacheMb = env.HLS_SEGMENT_CACHE_MB;
          const freed = trimHlsSegmentCache(hlsCacheMb / 2);
          if (freed > 0) {
            logger.info(
              { freedBytes: freed, targetMb: hlsCacheMb / 2 },
              "[memory-watchdog] trimmed HLS segment cache under ArrayBuffers pressure",
            );
          }
        })
        .catch(() => {/* non-fatal — video-serve may not be initialised yet */});
      logger.warn(
        { growthMbPerMin: Math.round(abGrowthRate * 10) / 10, threshold: ARRAY_BUFFERS_GROWTH_ALERT_MB_PER_MIN },
        "[memory-watchdog] ArrayBuffers growth rate exceeded threshold — possible HLS segment cache pressure",
      );
      void import("./sentry.js").then(({ captureEvent }) =>
        captureEvent(
          `[memory-watchdog] ArrayBuffers growing at ${Math.round(abGrowthRate * 10) / 10} MB/min — possible Buffer/HLS segment or media-proxy leak`,
          "warning",
          { growthMbPerMin: Math.round(abGrowthRate * 10) / 10, threshold: ARRAY_BUFFERS_GROWTH_ALERT_MB_PER_MIN },
        ),
      ).catch(() => {});
      adminEventBus.push("ops-alert", {
        level: "warn",
        code: "memory-arraybuffers-growth",
        message: `ArrayBuffers growing at ${Math.round(abGrowthRate * 10) / 10} MB/min (threshold: ${ARRAY_BUFFERS_GROWTH_ALERT_MB_PER_MIN} MB/min) — HLS cache auto-trimmed; check segment cache or upload pipeline`,
        growthMbPerMin: Math.round(abGrowthRate * 10) / 10,
        threshold: ARRAY_BUFFERS_GROWTH_ALERT_MB_PER_MIN,
      });
    } else if (arrayBuffersAlertActive && consecutiveArrayBuffersOver % 18 === 0) {
      // Re-trim every 18 samples (= 3 min at 10 s interval) while the alert
      // remains active. The first trim fires at alert activation; subsequent
      // trims prevent a sustained leak from re-filling the cache between
      // operator intervention cycles and keep the GC nudge meaningful.
      void import("../modules/video-serve/video-serve.routes.js")
        .then(({ trimHlsSegmentCache }) => {
          const hlsCacheMb = env.HLS_SEGMENT_CACHE_MB;
          const freed = trimHlsSegmentCache(hlsCacheMb / 2);
          if (freed > 0) {
            logger.info(
              { freedBytes: freed, targetMb: hlsCacheMb / 2, consecutiveOver: consecutiveArrayBuffersOver },
              "[memory-watchdog] periodic re-trim: HLS cache trimmed while ArrayBuffers alert still active",
            );
          }
        })
        .catch(() => {/* non-fatal */});
    }
  } else if (arrayBuffersAlertActive && (abGrowthRate === null || abGrowthRate < ARRAY_BUFFERS_GROWTH_RECOVERY_MB_PER_MIN)) {
    arrayBuffersAlertActive = false;
    consecutiveArrayBuffersOver = 0;
    logger.info(
      { growthMbPerMin: lastArrayBuffersMbPerMin },
      "[memory-watchdog] ArrayBuffers growth rate recovered",
    );
    adminEventBus.push("ops-alert", {
      level: "info",
      code: "memory-arraybuffers-recovered",
      message: `ArrayBuffers growth rate recovered (${lastArrayBuffersMbPerMin ?? 0} MB/min)`,
      growthMbPerMin: lastArrayBuffersMbPerMin ?? 0,
    });
  } else if (!arrayBuffersAlertActive) {
    consecutiveArrayBuffersOver = 0;
  }

  // ── V8 heap-limit guard (Exit Code 134 / SIGABRT prevention) ────────────
  // V8 aborts with SIGABRT (exit code 134) when heapUsed approaches the hard
  // --max-old-space-size limit — this can happen BEFORE RSS crosses the RSS
  // restart threshold, leaving the watchdog unable to SIGTERM in time.
  //
  // This block reads the real V8 heap statistics on every sample tick and:
  //   ≥ 88 %: proactive GC + cache purge  (warn zone)
  //   ≥ 93 % for V8_HEAP_CRITICAL_SAMPLES consecutive ticks: graceful SIGTERM
  //     before V8 can abort — ensuring a clean restart over a hard crash.
  const heapStats = v8.getHeapStatistics();
  const heapUsedPct = heapStats.used_heap_size / Math.max(heapStats.heap_size_limit, 1);
  const gcFn = (global as { gc?: () => void }).gc;

  if (heapUsedPct >= V8_HEAP_WARN_PCT && !criticalExitInFlight) {
    const heapUsedMbNow  = Math.round(heapStats.used_heap_size / (1024 * 1024));
    const heapLimitMbNow = Math.round(heapStats.heap_size_limit / (1024 * 1024));
    // Flush caches + run GC immediately to try to reclaim heap space.
    const purgedV8 = purgeExpiredCacheEntries();
    void import("../modules/video-serve/video-serve.routes.js")
      .then(({ trimHlsSegmentCache }) => {
        const hlsCacheMb = env.HLS_SEGMENT_CACHE_MB;
        trimHlsSegmentCache(heapUsedPct >= V8_HEAP_CRITICAL_PCT ? 0 : hlsCacheMb / 2);
      })
      .catch(() => {});
    if (gcFn) gcFn();

    if (heapUsedPct >= V8_HEAP_CRITICAL_PCT) {
      consecutiveV8HeapCritical++;
      if (!v8HeapAlertActive) {
        v8HeapAlertActive = true;
        logger.error(
          { heapUsedMb: heapUsedMbNow, heapLimitMb: heapLimitMbNow, heapUsedPct: Math.round(heapUsedPct * 100) },
          "[memory-watchdog] V8 heap CRITICAL — approaching abort threshold (Exit Code 134 risk)",
        );
        adminEventBus.push("ops-alert", {
          level: "critical",
          code: "v8-heap-critical",
          message: `V8 heap at ${Math.round(heapUsedPct * 100)}% of limit (${heapUsedMbNow}/${heapLimitMbNow} MB) — Exit Code 134 risk. Auto-restart in ${V8_HEAP_CRITICAL_SAMPLES - consecutiveV8HeapCritical} ticks if heap does not recover.`,
          heapUsedMb: heapUsedMbNow,
          heapLimitMb: heapLimitMbNow,
          heapUsedPct: Math.round(heapUsedPct * 100),
        });
      }
      if (consecutiveV8HeapCritical >= V8_HEAP_CRITICAL_SAMPLES && !criticalExitInFlight) {
        criticalExitInFlight = true;
        logger.error(
          { heapUsedMb: heapUsedMbNow, heapLimitMb: heapLimitMbNow, consecutiveV8HeapCritical },
          "[memory-watchdog] V8 heap sustained critical — emergency relief (log-only mode, no auto-restart)",
        );
        void import("./sentry.js").then(({ captureEvent }) =>
          captureEvent(
            `[memory-watchdog] V8 heap at ${Math.round(heapUsedPct * 100)}% for ${consecutiveV8HeapCritical} ticks — emergency GC+relief, no auto-restart`,
            "error",
            { heapUsedMb: heapUsedMbNow, heapLimitMb: heapLimitMbNow },
          ),
        ).catch(() => {});
        adminEventBus.push("ops-alert", {
          level: "critical",
          code: "v8-heap-emergency-relief",
          message: `V8 heap at ${Math.round(heapUsedPct * 100)}% for ${consecutiveV8HeapCritical} ticks — emergency relief applied (process is NOT restarting; monitor manually)`,
          heapUsedMb: heapUsedMbNow,
          heapLimitMb: heapLimitMbNow,
        });
        // Cancel all faststart jobs (each holds 80–150 MiB) + drain HLS cache.
        void import("../modules/transcoder/faststart.service.js")
          .then(({ cancelAllFaststartJobs }) => { cancelAllFaststartJobs(); })
          .catch(() => {});
        void import("../modules/video-serve/video-serve.routes.js")
          .then(({ trimHlsSegmentCache }) => { trimHlsSegmentCache(0); })
          .catch(() => {});
        purgeExpiredCacheEntries();
        if (gcFn) gcFn();
        // Reset after cooldown so the relief can fire again if heap stays critical.
        setTimeout(() => {
          criticalExitInFlight = false;
          consecutiveV8HeapCritical = 0;
        }, RELIEF_COOLDOWN_MS).unref();
      }
    } else {
      // Heap is in warn zone (88–93%) but not critical — log periodically.
      if (!v8HeapAlertActive) {
        v8HeapAlertActive = true;
        logger.warn(
          { heapUsedMb: heapUsedMbNow, heapLimitMb: heapLimitMbNow, heapUsedPct: Math.round(heapUsedPct * 100), purgedCacheEntries: purgedV8 },
          "[memory-watchdog] V8 heap warn threshold exceeded — proactive GC + cache purge applied",
        );
      }
      consecutiveV8HeapCritical = 0;
    }
  } else {
    // Heap has recovered
    if (v8HeapAlertActive) {
      v8HeapAlertActive = false;
      consecutiveV8HeapCritical = 0;
      logger.info(
        { heapUsedPct: Math.round(heapUsedPct * 100) },
        "[memory-watchdog] V8 heap pressure recovered",
      );
    }
  }

  // ── Proactive GC nudge ───────────────────────────────────────────────────
  // When RSS is in the warn zone, nudge V8's garbage collector to free
  // unreferenced Buffer memory (e.g. completed HLS segment responses waiting
  // for collection). gcFn is already defined above (after the V8 heap guard).
  if (rssAlertActive || heapUsedAlertActive || arrayBuffersAlertActive) {
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
  if ((rssAlertActive || heapUsedAlertActive || arrayBuffersAlertActive) && gcFn) {
    gcFn();
  }

  // ── Pre-exit emergency cache drain ───────────────────────────────────────
  // Three samples before CRITICAL_SAMPLES_FOR_EXIT is reached, attempt an
  // aggressive multi-cache drain + GC to give the process a final opportunity
  // to recover without a restart.  If RSS falls back below restartThresholdMb
  // before the critical threshold is hit, the consecutive counter resets and
  // the exit is avoided entirely.
  if (
    env.NODE_ENV === "production" &&
    consecutiveRssOverRestart === CRITICAL_SAMPLES_FOR_EXIT - 3 &&
    !criticalExitInFlight
  ) {
    const purgedEmergency = purgeExpiredCacheEntries();
    // Trim HLS segment cache to zero — maximum reclaim under critical pressure.
    void import("../modules/video-serve/video-serve.routes.js")
      .then(({ trimHlsSegmentCache }) => trimHlsSegmentCache(0))
      .catch(() => {/* non-fatal — module may not be initialised */});
    if (gcFn) gcFn();
    logger.warn(
      {
        rssMb,
        restartThresholdMb,
        consecutiveRssOverRestart,
        purgedCacheEntries: purgedEmergency,
        samplesUntilExit: 3,
      },
      "[memory-watchdog] pre-exit emergency drain: flushed all expired cache entries + trimmed HLS segment cache — 3 samples until restart if RSS does not recover",
    );
  }

  // ── Hard ceiling emergency relief (no consecutive count needed) ──────────
  // If RSS reaches MEMORY_ABSOLUTE_MAX_RSS_MB (default 0 = disabled) we run
  // an immediate relief pass (cancel faststart + drain HLS cache + GC),
  // skipping the CRITICAL_SAMPLES_FOR_EXIT countdown.  The process does NOT
  // restart — log-only mode.  Set a realistic ceiling (e.g. 2000 MiB on a
  // 2 GiB host) so the relief fires before the OS OOM killer.
  const absoluteMaxMb = env.MEMORY_ABSOLUTE_MAX_RSS_MB;
  if (
    env.NODE_ENV === "production" &&
    absoluteMaxMb > 0 &&
    rssMb >= absoluteMaxMb &&
    !criticalExitInFlight
  ) {
    criticalExitInFlight = true;
    const heapUsedMbHC  = Math.round(mem.heapUsed  / (1024 * 1024));
    const heapTotalMbHC = Math.round(mem.heapTotal  / (1024 * 1024));
    const externalMbHC  = Math.round(mem.external   / (1024 * 1024));
    logger.error(
      {
        rssMb,
        heapUsedMb: heapUsedMbHC,
        heapTotalMb: heapTotalMbHC,
        externalMb: externalMbHC,
        arrayBuffersMb: Math.round(mem.arrayBuffers / (1024 * 1024)),
        absoluteMaxMb,
      },
      "[memory-watchdog] HARD CEILING exceeded — emergency relief (log-only mode, no auto-restart)",
    );
    void import("./sentry.js").then(({ captureEvent }) =>
      captureEvent(
        `[memory-watchdog] HARD CEILING: RSS ${rssMb} MiB ≥ absolute max ${absoluteMaxMb} MiB — emergency relief, no restart`,
        "error",
        { rssMb, absoluteMaxMb },
      ),
    ).catch(() => {});
    adminEventBus.push("ops-alert", {
      level: "fatal",
      code: "memory-hard-ceiling",
      message: `RSS ${rssMb} MiB hit hard ceiling ${absoluteMaxMb} MiB — emergency relief applied (process is NOT restarting; monitor immediately)`,
      rssMb,
      absoluteMaxMb,
    });
    void import("../modules/transcoder/faststart.service.js")
      .then(({ cancelAllFaststartJobs }) => { cancelAllFaststartJobs(); })
      .catch(() => {});
    void import("../modules/video-serve/video-serve.routes.js")
      .then(({ trimHlsSegmentCache }) => { trimHlsSegmentCache(0); })
      .catch(() => {});
    purgeExpiredCacheEntries();
    if (gcFn) gcFn();
    // Reset after cooldown so the relief can re-fire if pressure persists.
    setTimeout(() => { criticalExitInFlight = false; }, RELIEF_COOLDOWN_MS).unref();
  }

  // ── Critical escalation with self-healing relief pass (production only) ──
  // Uses consecutiveRssOverRestart (RSS ≥ MEMORY_RESTART_RSS_MB) rather than
  // consecutiveRssOver (RSS ≥ MEMORY_WARN_RSS_MB) so a low warn threshold
  // does NOT trigger ops-alerts above.
  //
  // Relief pass (log-only mode — no auto-restart):
  //   1. Cancel all in-flight faststart FFmpeg processes (each holds 80–150 MiB).
  //   2. Trim the HLS segment cache to zero and run a full GC.
  //   3. Wait RELIEF_WAIT_MS for allocations to drain.
  //   4. Re-measure RSS. Log recovery or escalation.
  //   5. Reset reliefInFlight after RELIEF_COOLDOWN_MS so the next pass can run.
  //      The process NEVER auto-restarts; operators must act on the alert.
  //
  // This avoids restart loops where one large upload + concurrent HLS pushes
  // RSS briefly over the threshold but self-corrects within 15 seconds.
  const RELIEF_WAIT_MS = 15_000;
  if (
    env.NODE_ENV === "production" &&
    consecutiveRssOverRestart >= CRITICAL_SAMPLES_FOR_EXIT &&
    !criticalExitInFlight &&
    (Date.now() - lastReliefAttemptMs) >= RELIEF_COOLDOWN_MS
  ) {
    criticalExitInFlight = true;
    lastReliefAttemptMs = Date.now();
    const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
    const externalMb  = Math.round(mem.external  / (1024 * 1024));
    logger.warn(
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
        reliefWaitMs: RELIEF_WAIT_MS,
      },
      "[memory-watchdog] CRITICAL RSS — attempting self-healing relief (log-only mode, no auto-restart)",
    );
    adminEventBus.push("ops-alert", {
      level: "warn",
      code: "memory-relief-attempt",
      message: `RSS ${rssMb} MB sustained above ${restartThresholdMb} MB — cancelling heavy jobs, waiting ${RELIEF_WAIT_MS / 1000}s for self-heal (process will NOT restart)`,
      rssMb,
      restartThresholdMb,
    });
    void (async () => {
      // Step 1: cancel faststart jobs (80–150 MiB each)
      try {
        const { cancelAllFaststartJobs } = await import("../modules/transcoder/faststart.service.js");
        cancelAllFaststartJobs();
      } catch { /* non-fatal — module may not be loaded */ }
      // Step 2: aggressive cache drain + GC
      try {
        const { trimHlsSegmentCache } = await import("../modules/video-serve/video-serve.routes.js");
        trimHlsSegmentCache(0);
      } catch { /* non-fatal */ }
      purgeExpiredCacheEntries();
      if (gcFn) gcFn();
      // Step 3: wait for memory to release
      await new Promise<void>((r) => setTimeout(r, RELIEF_WAIT_MS));
      // Step 4: re-measure
      const recoveredMem = process.memoryUsage();
      const recoveredRssMb = Math.round(recoveredMem.rss / (1024 * 1024));
      if (recoveredRssMb < restartThresholdMb) {
        criticalExitInFlight = false;
        consecutiveRssOverRestart = 0;
        logger.info(
          { recoveredRssMb, restartThresholdMb },
          "[memory-watchdog] RSS recovered after self-healing relief — pressure resolved",
        );
        adminEventBus.push("ops-alert", {
          level: "info",
          code: "memory-relief-recovered",
          message: `RSS recovered to ${recoveredRssMb} MB after relief (threshold: ${restartThresholdMb} MB)`,
          recoveredRssMb,
          restartThresholdMb,
        });
        return;
      }
      // Step 5: still critical — send alert (no restart in log-only mode)
      logger.error(
        {
          rssMb: recoveredRssMb,
          restartThresholdMb,
          consecutiveRssOverRestart,
          criticalThreshold: CRITICAL_SAMPLES_FOR_EXIT,
          nextReliefInMs: RELIEF_COOLDOWN_MS,
        },
        "[memory-watchdog] CRITICAL: RSS did not recover after relief — process staying up (log-only mode). Next relief in ~90s.",
      );
      void import("./sentry.js").then(({ captureEvent }) =>
        captureEvent(
          `[memory-watchdog] CRITICAL: RSS ${recoveredRssMb} MB still above ${restartThresholdMb} MB after relief — sustained pressure, no auto-restart`,
          "error",
          { rssMb: recoveredRssMb, restartThresholdMb, consecutiveRssOverRestart },
        ),
      ).catch(() => {});
      adminEventBus.push("ops-alert", {
        level: "fatal",
        code: "memory-sustained-above-threshold",
        message: `RSS ${recoveredRssMb} MB still above ${restartThresholdMb} MB after ${RELIEF_WAIT_MS / 1000}s relief — process is NOT restarting. Reduce load or increase MEMORY_RESTART_RSS_MB.`,
        rssMb: recoveredRssMb,
        restartThresholdMb,
      });
      void import("../modules/mail/mail.service.js")
        .then(({ sendAdminAlert }) =>
          sendAdminAlert({
            subject: "API memory pressure — manual intervention may be needed",
            severity: "critical",
            body: [
              `RSS stayed above the restart threshold (${restartThresholdMb} MB) even after ${RELIEF_WAIT_MS / 1000}s relief.`,
              `Current: ${recoveredRssMb} MB  |  heap: ${heapUsedMb}/${heapTotalMb} MB  |  external: ${externalMb} MB`,
              "",
              "The process is NOT restarting (log-only mode). Relief will re-run in ~90s.",
              "",
              "Actions: reduce active uploads, lower HLS_MAX_CONCURRENT, or raise MEMORY_RESTART_RSS_MB.",
            ].join("\n"),
          }),
        )
        .catch(() => {});
      // Reset so the next relief attempt can run after RELIEF_COOLDOWN_MS.
      criticalExitInFlight = false;
    })();
  }
}

/**
 * Returns the rolling memory sample window as MB-valued objects for sparkline
 * rendering.  The window holds up to SLOPE_WINDOW_SAMPLES entries at
 * SAMPLE_INTERVAL_MS cadence (180 × 10 s = last 30 minutes).
 */
export function getMemoryHistory(): Array<{ ts: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number }> {
  const MiB = 1024 * 1024;
  return memWindow.map(({ ts, heapUsed, external, arrayBuffers }) => ({
    ts,
    heapUsedMb: Math.round((heapUsed / MiB) * 10) / 10,
    externalMb: Math.round((external / MiB) * 10) / 10,
    arrayBuffersMb: Math.round((arrayBuffers / MiB) * 10) / 10,
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
      alerts: { rssAlertActive, slopeAlertActive, heapUsedAlertActive, arrayBuffersAlertActive },
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
  interval = setInterval(() => {
    try { sample(); } catch { /* non-fatal */ }
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
      rssAbsoluteMaxMb: env.MEMORY_ABSOLUTE_MAX_RSS_MB,
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
      arrayBuffersAlertActive,
      eventLoopLagAlertActive: isEventLoopLagAlertActive(),
    },
  };
}
