/**
 * F17: Memory pressure watchdog.
 *
 * Samples process.memoryUsage().rss on a fixed interval and emits a
 * structured "ops-alert" SSE event via the broadcastEngine when RSS
 * exceeds the MEMORY_WARN_RSS_MB threshold. The admin console receives
 * these events and can surface a warning banner so operators know about
 * impending OOM before the process is killed.
 *
 * The watchdog also maintains module-level state that the
 * GET /admin/diagnostics/memory endpoint reads to populate the
 * `watchdog` section of the response (replacing the previous
 * hardcoded `enabled: false`).
 */

import { logger } from "./logger.js";
import { env } from "../config/env.js";
import { processRssGauge, SERVICE_LABELS } from "./metrics.js";

const SAMPLE_INTERVAL_MS = 30_000;
const SUSTAIN_SAMPLES = 3;

export interface WatchdogState {
  enabled: boolean;
  sampleIntervalMs: number;
  thresholds: {
    rssAlertMb: number;
    rssRecoveryMb: number;
  };
  current: {
    rssMb: number;
    consecutiveRssOver: number;
  };
  alerts: {
    rssAlertActive: boolean;
  };
}

let interval: NodeJS.Timeout | null = null;
let consecutiveRssOver = 0;
let rssAlertActive = false;
let lastRssMb = 0;

// Lazy-imported to avoid a circular-dependency boot-order issue.
// broadcastEngine → queue.engine → this watchdog must not import
// broadcastEngine at module init time; we import it on first sample.
type BroadcastEngineEvent = { type: string; data: unknown };
let _emit: ((e: BroadcastEngineEvent) => void) | null = null;

async function loadEmitter() {
  if (_emit) return;
  const { broadcastEngine } = await import("../modules/broadcast/queue.engine.js");
  _emit = (e) => broadcastEngine.emit("event", e);
}

function sample() {
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / (1024 * 1024));
  lastRssMb = rssMb;
  processRssGauge.set(SERVICE_LABELS, mem.rss);
  const thresholdMb = env.MEMORY_WARN_RSS_MB;

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
    return;
  }

  if (consecutiveRssOver >= SUSTAIN_SAMPLES && !rssAlertActive) {
    rssAlertActive = true;
    logger.warn(
      { rssMb, thresholdMb, consecutiveRssOver },
      "[memory-watchdog] RSS threshold exceeded — emitting ops-alert",
    );
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
  } else if (rssAlertActive) {
    // Repeat alert every 5 minutes (10 samples × 30 s) while still high
    if (consecutiveRssOver % 10 === 0) {
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
  }
}

export function startMemoryWatchdog(): void {
  if (interval) return;
  // Pre-load the emitter reference asynchronously (fire-and-forget).
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
  return {
    enabled: interval !== null,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    thresholds: {
      rssAlertMb: env.MEMORY_WARN_RSS_MB,
      rssRecoveryMb: env.MEMORY_WARN_RSS_MB - 200,
    },
    current: {
      rssMb: lastRssMb,
      consecutiveRssOver,
    },
    alerts: {
      rssAlertActive,
    },
  };
}
