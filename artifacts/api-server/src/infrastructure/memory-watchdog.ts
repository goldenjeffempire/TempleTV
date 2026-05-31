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
 *   3. Critical escalation — in production only, voluntarily exits after
 *      CRITICAL_SAMPLES_FOR_EXIT consecutive over-threshold RSS samples so
 *      the supervisor (Replit, k8s) can restart cleanly.
 *
 * State is exposed via getWatchdogState() for the
 * GET /admin/diagnostics/memory endpoint.
 */

import { logger } from "./logger.js";
import { env } from "../config/env.js";
import { processRssGauge, SERVICE_LABELS } from "./metrics.js";

const SAMPLE_INTERVAL_MS = 30_000;
const SUSTAIN_SAMPLES = 3;
const CRITICAL_SAMPLES_FOR_EXIT = 10;
const FORCE_EXIT_GRACE_MS = 30_000;

/** Rolling window size (samples) for external memory slope calculation. */
const SLOPE_WINDOW_SAMPLES = 6;
/** Alert when external memory is growing faster than this (MB / min). */
const EXTERNAL_GROWTH_ALERT_MB_PER_MIN = 50;
/** Recovery threshold (MB / min) — slope must fall below this to clear alert. */
const EXTERNAL_GROWTH_RECOVERY_MB_PER_MIN = 10;
/** How many consecutive over-slope samples before the alert fires. */
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
  };
  alerts: {
    rssAlertActive: boolean;
    slopeAlertActive: boolean;
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
let rssAlertActive = false;
let slopeAlertActive = false;
let lastRssMb = 0;
let lastExternalGrowthMbPerMin: number | null = null;

/** Rolling window of { external bytes, timestamp ms } pairs. */
const externalWindow: Array<{ external: number; ts: number }> = [];

type BroadcastEngineEvent = { type: string; data: unknown };
let _emit: ((e: BroadcastEngineEvent) => void) | null = null;

async function loadEmitter() {
  if (_emit) return;
  const { broadcastEngine } = await import("../modules/broadcast/queue.engine.js");
  _emit = (e) => broadcastEngine.emit("event", e);
}

/** Calculate external memory growth rate (MB/min) from the rolling window. */
function calcExternalGrowthMbPerMin(): number | null {
  if (externalWindow.length < 2) return null;
  const oldest = externalWindow[0];
  const newest = externalWindow[externalWindow.length - 1];
  const dtMs = newest.ts - oldest.ts;
  if (dtMs < 1_000) return null;
  const deltaBytes = newest.external - oldest.external;
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
  } else if (rssAlertActive && consecutiveRssOver % 10 === 0) {
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

  // ── External memory slope tracking ────────────────────────────────────────
  externalWindow.push({ external: mem.external, ts: Date.now() });
  if (externalWindow.length > SLOPE_WINDOW_SAMPLES) externalWindow.shift();

  const growthRate = calcExternalGrowthMbPerMin();
  lastExternalGrowthMbPerMin = growthRate !== null ? Math.round(growthRate * 10) / 10 : null;

  if (growthRate !== null && growthRate > EXTERNAL_GROWTH_ALERT_MB_PER_MIN) {
    consecutiveSlopeOver++;
    if (consecutiveSlopeOver >= CONSECUTIVE_SLOPE_FOR_ALERT && !slopeAlertActive) {
      slopeAlertActive = true;
      logger.warn(
        { growthMbPerMin: Math.round(growthRate * 10) / 10, threshold: EXTERNAL_GROWTH_ALERT_MB_PER_MIN },
        "[memory-watchdog] external memory growth rate exceeded threshold",
      );
      _emit?.({
        type: "ops-alert",
        data: {
          level: "warn",
          code: "memory-external-growth",
          message: `External memory growing at ${Math.round(growthRate * 10) / 10} MB/min (threshold: ${EXTERNAL_GROWTH_ALERT_MB_PER_MIN} MB/min) — possible native memory leak`,
          growthMbPerMin: Math.round(growthRate * 10) / 10,
          threshold: EXTERNAL_GROWTH_ALERT_MB_PER_MIN,
        },
      });
    }
  } else if (slopeAlertActive && (growthRate === null || growthRate < EXTERNAL_GROWTH_RECOVERY_MB_PER_MIN)) {
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
    logger.fatal(
      {
        rssMb,
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

export function startMemoryWatchdog(): void {
  if (interval) return;
  loadEmitter().catch(() => { /* non-fatal */ });
  interval = setInterval(() => {
    loadEmitter().then(() => sample()).catch(() => { /* non-fatal */ });
  }, SAMPLE_INTERVAL_MS);
  interval.unref();
  logger.info(
    { thresholdMb: env.MEMORY_WARN_RSS_MB, intervalMs: SAMPLE_INTERVAL_MS },
    "[memory-watchdog] started",
  );
}

export function stopMemoryWatchdog(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
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
    },
    alerts: {
      rssAlertActive,
      slopeAlertActive,
    },
  };
}
