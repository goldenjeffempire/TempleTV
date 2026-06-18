/**
 * Event-loop lag monitor.
 *
 * Uses setImmediate to measure how long the event loop is blocked between
 * ticks. A healthy Node process sees lag <10 ms; anything sustained above
 * 100 ms indicates a blocking operation (synchronous crypto, large
 * JSON.parse, DNS resolution, or CPU starvation on constrained hosts).
 *
 * On Render free tier (0.1 vCPU), CPU starvation under concurrent broadcast
 * load can push lag to 100–500 ms, causing health-check timeouts that Render
 * interprets as an unhealthy instance → SIGTERM cycles.
 *
 * State is exposed via getEventLoopLagMs() and isEventLoopLagAlertActive()
 * for the GET /admin/diagnostics/memory endpoint (merged into watchdog state).
 */

import { logger } from "./logger.js";

/** How often to fire a lag probe. Cheap: one setImmediate + Date.now(). */
const SAMPLE_INTERVAL_MS = 1_000;
/** Alert threshold: lag above this for ALERT_SUSTAIN_SAMPLES = elevated risk. */
const ALERT_THRESHOLD_MS = 500;
/** Alert clears when lag falls below this. Hysteresis prevents flapping. */
const RECOVERY_THRESHOLD_MS = 100;
/** Consecutive over-threshold samples required before alerting. */
const ALERT_SUSTAIN_SAMPLES = 3;
/** Rolling history window for sparkline rendering (60 s). */
const LAG_HISTORY_SIZE = 60;

let lagInterval: ReturnType<typeof setInterval> | null = null;
let lastLagMs = 0;
let consecutiveOver = 0;
let lagAlertActive = false;

export interface LagSample {
  ts: number;
  lagMs: number;
}

const lagHistory: LagSample[] = [];

function probeLag(): void {
  const start = Date.now();
  setImmediate(() => {
    const lagMs = Date.now() - start;
    lastLagMs = lagMs;

    lagHistory.push({ ts: Date.now(), lagMs });
    if (lagHistory.length > LAG_HISTORY_SIZE) lagHistory.shift();

    if (lagMs >= ALERT_THRESHOLD_MS) {
      consecutiveOver++;
      if (consecutiveOver >= ALERT_SUSTAIN_SAMPLES && !lagAlertActive) {
        lagAlertActive = true;
        logger.warn(
          { lagMs, threshold: ALERT_THRESHOLD_MS, consecutiveOver },
          "[event-loop-lag] WARN: event loop sustained above threshold — CPU starvation or blocking I/O",
        );
        // Lazy-import adminEventBus to avoid circular-import init-order races.
        // Previous code used broadcastEngine.emit() (v1 bus) which is not
        // consumed by the unacked-alert sweeper — alerts were silently lost.
        void import("../modules/admin-ops/admin-event-bus.js")
          .then(({ adminEventBus }) =>
            adminEventBus.push("ops-alert", {
              level: "warn",
              code: "event-loop-lag",
              message: `Event loop lag sustained at ${lagMs} ms (threshold: ${ALERT_THRESHOLD_MS} ms) — CPU starvation risk`,
              lagMs,
              threshold: ALERT_THRESHOLD_MS,
            }),
          )
          .catch(() => {});
      }
    } else {
      if (lagAlertActive && lagMs < RECOVERY_THRESHOLD_MS) {
        lagAlertActive = false;
        consecutiveOver = 0;
        logger.info({ lagMs }, "[event-loop-lag] event loop lag recovered");
      } else if (!lagAlertActive) {
        consecutiveOver = 0;
      }
    }
  });
}

/**
 * Start the event-loop lag monitor.  Idempotent — second call is a no-op.
 * The setInterval is `.unref()`-ed so it never prevents clean process exit.
 */
export function startEventLoopLagMonitor(): void {
  if (lagInterval) return;
  lagInterval = setInterval(probeLag, SAMPLE_INTERVAL_MS);
  lagInterval.unref();
  logger.info(
    { alertThresholdMs: ALERT_THRESHOLD_MS, sampleIntervalMs: SAMPLE_INTERVAL_MS },
    "[event-loop-lag] started",
  );
}

/**
 * Stop the event-loop lag monitor (called during graceful shutdown so the
 * interval does not hold the event loop open after all other subsystems
 * have stopped).
 */
export function stopEventLoopLagMonitor(): void {
  if (lagInterval) {
    clearInterval(lagInterval);
    lagInterval = null;
  }
}

/** Most-recently measured event-loop lag in milliseconds. */
export function getEventLoopLagMs(): number {
  return lastLagMs;
}

/** Whether the sustained-lag alert is currently active. */
export function isEventLoopLagAlertActive(): boolean {
  return lagAlertActive;
}

/** Rolling 60-sample history for sparkline rendering. */
export function getEventLoopLagHistory(): LagSample[] {
  return [...lagHistory];
}
