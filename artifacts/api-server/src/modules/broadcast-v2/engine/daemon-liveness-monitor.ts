/**
 * Daemon Liveness Monitor
 *
 * When the API server runs in proxy mode (BROADCAST_DAEMON_URL is set), this
 * module periodically health-checks the broadcast daemon and emits an ops alert
 * when it is unreachable for an extended period. It also tracks downtime windows
 * so the admin panel can show when the daemon was last seen alive.
 *
 * The monitor is intentionally lightweight:
 *   - One HTTP GET to /health every POLL_INTERVAL_MS (default 30 s)
 *   - Alert fires after CONSECUTIVE_FAILURES_BEFORE_ALERT failures (default 3 = 90 s)
 *   - Recovery is logged when the daemon comes back
 *   - All state is in-memory (the restart log covers boot events)
 */

import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";

const POLL_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
const CONSECUTIVE_FAILURES_BEFORE_ALERT = 3;
const ALERT_COOLDOWN_MS = 10 * 60_000; // 10 minutes between repeat alerts

interface LivenessState {
  lastSeenAliveMs: number | null;
  consecutiveFailures: number;
  lastAlertAtMs: number | null;
  downSinceMs: number | null;
  lastCheckAtMs: number | null;
}

const state: LivenessState = {
  lastSeenAliveMs: null,
  consecutiveFailures: 0,
  lastAlertAtMs: null,
  downSinceMs: null,
  lastCheckAtMs: null,
};

let pollTimer: NodeJS.Timeout | null = null;
// Synchronous started flag — prevents double-start when onReady fires more
// than once (e.g. proxy routes registered under two prefixes in app.ts).
let _started = false;

function daemonHealthUrl(): string {
  const base = env.BROADCAST_DAEMON_URL!.replace(/\/$/, "");
  return `${base}/api/v1/broadcast-v2/health`;
}

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(daemonHealthUrl(), {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    // Any sub-500 response means the daemon is alive (200, 401, 429 all count)
    return res.status < 500;
  } catch {
    return false;
  }
}

async function poll(): Promise<void> {
  state.lastCheckAtMs = Date.now();
  const alive = await probe();

  if (alive) {
    if (state.downSinceMs !== null) {
      const downtimeMs = Date.now() - state.downSinceMs;
      logger.info(
        { downtimeMs: Math.round(downtimeMs / 1000) + "s" },
        "[daemon-liveness] broadcast daemon recovered",
      );
    }
    state.lastSeenAliveMs = Date.now();
    state.consecutiveFailures = 0;
    state.downSinceMs = null;
    return;
  }

  state.consecutiveFailures++;
  if (state.downSinceMs === null) {
    state.downSinceMs = Date.now();
  }

  logger.warn(
    { consecutiveFailures: state.consecutiveFailures, downSinceMs: state.downSinceMs },
    "[daemon-liveness] broadcast daemon health check failed",
  );

  // Fire alert once per ALERT_COOLDOWN_MS when threshold is crossed
  const shouldAlert =
    state.consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_ALERT &&
    (state.lastAlertAtMs === null || Date.now() - state.lastAlertAtMs >= ALERT_COOLDOWN_MS);

  if (shouldAlert) {
    state.lastAlertAtMs = Date.now();
    const downSec = Math.round((Date.now() - state.downSinceMs!) / 1000);
    try {
      adminEventBus.push("ops-alert", {
        level: "error",
        code: "DAEMON_UNREACHABLE",
        title: "Broadcast daemon unreachable",
        message: `Broadcast daemon has been unreachable for ~${downSec}s (${state.consecutiveFailures} consecutive failures). Viewers cannot receive live stream updates.`,
        detail: `Daemon URL: ${env.BROADCAST_DAEMON_URL}. Check the Broadcast Daemon workflow logs for crashes or OOM errors.`,
        timestamp: new Date().toISOString(),
        source: "daemon-liveness-monitor",
      });
    } catch {
      // non-fatal
    }
  }
}

/**
 * Start the daemon liveness monitor.  Safe to call multiple times.
 * Only active when BROADCAST_DAEMON_URL is configured (proxy mode).
 */
export function startDaemonLivenessMonitor(): void {
  if (!env.BROADCAST_DAEMON_URL) return;
  if (_started) return;
  _started = true;

  logger.info(
    { daemonUrl: env.BROADCAST_DAEMON_URL, pollIntervalMs: POLL_INTERVAL_MS },
    "[daemon-liveness] starting",
  );

  // First probe after 15 s so the daemon has time to boot before we check
  const firstTimer = setTimeout(() => {
    void poll();
    pollTimer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }, 15_000);
  firstTimer.unref?.();
}

/**
 * Stop the daemon liveness monitor.
 */
export function stopDaemonLivenessMonitor(): void {
  _started = false;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info("[daemon-liveness] stopped");
  }
}

/**
 * Return the current liveness state for the /health endpoint.
 */
export function getDaemonLivenessStatus(): {
  monitoring: boolean;
  lastSeenAliveMs: number | null;
  consecutiveFailures: number;
  alertFired: boolean;
  downSinceMs: number | null;
  lastCheckAtMs: number | null;
} {
  return {
    monitoring: pollTimer !== null,
    lastSeenAliveMs: state.lastSeenAliveMs,
    consecutiveFailures: state.consecutiveFailures,
    alertFired: state.lastAlertAtMs !== null,
    downSinceMs: state.downSinceMs,
    lastCheckAtMs: state.lastCheckAtMs,
  };
}
