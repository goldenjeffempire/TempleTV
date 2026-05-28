/**
 * viewer-slope-monitor — slope-based stream-health detector.
 *
 * Samples `broadcastEngine.getViewerCount()` every minute and keeps a rolling
 * ring buffer of the last MAX_SAMPLES data points.  When the viewer count drops
 * by more than DROP_THRESHOLD viewers/minute for CONSECUTIVE_THRESHOLD
 * consecutive intervals the monitor emits a `stream-health-degraded` admin
 * event and sets the `degraded` flag.  The flag clears automatically once the
 * slope becomes non-negative (recovery).
 *
 * Thread safety: Node.js is single-threaded — no locking needed.
 */

import { broadcastEngine } from "../broadcast/queue.engine.js";
import { adminEventBus } from "./admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";

const MAX_SAMPLES = 10;
const SAMPLE_INTERVAL_MS = 60_000;
const DROP_THRESHOLD = 30;        // viewers per minute
const CONSECUTIVE_THRESHOLD = 3;  // samples below threshold before alerting

export interface ViewerSample {
  ts: number;
  count: number;
}

export interface ViewerSlopeStatus {
  degraded: boolean;
  degradedSince: number | null;
  consecutiveDrops: number;
  samples: ViewerSample[];
  viewerDeltaPerMin: number | null;
  checkedAt: string;
}

let samples: ViewerSample[] = [];
let consecutiveDrops = 0;
let degradedSince: number | null = null;
let monitorTimer: NodeJS.Timeout | null = null;

function recordSample(): void {
  const now = Date.now();
  const count = broadcastEngine.getViewerCount();
  samples.push({ ts: now, count });
  if (samples.length > MAX_SAMPLES) samples.shift();

  if (samples.length < 2) return;

  const prev = samples[samples.length - 2]!;
  const cur = samples[samples.length - 1]!;
  const dtMin = Math.max((cur.ts - prev.ts) / 60_000, 0.001);
  const viewerDeltaPerMin = (cur.count - prev.count) / dtMin;

  if (viewerDeltaPerMin < -DROP_THRESHOLD) {
    consecutiveDrops++;
    if (consecutiveDrops >= CONSECUTIVE_THRESHOLD && degradedSince === null) {
      degradedSince = now;
      const status = getViewerSlopeStatus();
      adminEventBus.push("stream-health-degraded", status);
      logger.warn(
        { consecutiveDrops, viewerDeltaPerMin: Math.round(viewerDeltaPerMin * 10) / 10, count },
        "viewer-slope: sustained viewer-count drop — stream-health-degraded emitted",
      );
    }
  } else {
    if (degradedSince !== null) {
      degradedSince = null;
      adminEventBus.push("stream-health-recovered", { ts: now, count, checkedAt: new Date(now).toISOString() });
      logger.info({ consecutiveDrops, count }, "viewer-slope: viewer count recovering — degraded flag cleared");
    }
    consecutiveDrops = 0;
  }
}

export function getViewerSlopeStatus(): ViewerSlopeStatus {
  const last = samples.length >= 2 ? samples[samples.length - 1] : null;
  const prev = samples.length >= 2 ? samples[samples.length - 2] : null;
  let viewerDeltaPerMin: number | null = null;
  if (last && prev) {
    const dtMin = Math.max((last.ts - prev.ts) / 60_000, 0.001);
    viewerDeltaPerMin = Math.round(((last.count - prev.count) / dtMin) * 10) / 10;
  }
  return {
    degraded: degradedSince !== null,
    degradedSince,
    consecutiveDrops,
    samples: [...samples],
    viewerDeltaPerMin,
    checkedAt: new Date().toISOString(),
  };
}

export function startViewerSlopeMonitor(): void {
  if (monitorTimer) return;
  recordSample(); // immediate baseline sample
  monitorTimer = setInterval(recordSample, SAMPLE_INTERVAL_MS);
  monitorTimer.unref?.();
  logger.info({ intervalMs: SAMPLE_INTERVAL_MS }, "viewer-slope monitor started");
}

export function stopViewerSlopeMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
