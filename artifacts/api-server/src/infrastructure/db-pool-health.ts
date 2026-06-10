/**
 * Database connection pool health monitor.
 *
 * Periodically samples the pg pool's utilization (active connections,
 * idle connections, waiting queue depth) and emits an "ops-alert" SSE event
 * when the pool exceeds the configured warning threshold.  This gives operators
 * early warning of connection exhaustion before queries start timing out or
 * piling up behind a blocked pool.
 *
 * Follows the same pattern as memory-watchdog.ts and event-loop-lag.ts:
 *   • installDbPoolHealthMonitor() / uninstallDbPoolHealthMonitor() for lifecycle
 *   • getDbPoolHealthStatus() exposes live state for /health / /diagnostics
 *
 * Alert tiers
 * ───────────
 *   1. HIGH utilization (active/max > DB_POOL_WARN_UTILIZATION, default 80%):
 *      emits ops-alert with level="warn" when sustained for SUSTAIN_SAMPLES
 *      consecutive readings.  Clears when utilization drops below 60%.
 *
 *   2. WAITING connections (pool.waitingCount > 0):
 *      emits ops-alert with level="critical" immediately (no sustain buffer)
 *      because waiting queries mean callers are already stalling.
 *
 * No DB queries are made by this monitor — it reads synchronous counters
 * directly from the pg Pool instance.
 */

import { logger } from "./logger.js";
import { env } from "../config/env.js";
import { pgPool } from "./db.js";

// ── Configuration ─────────────────────────────────────────────────────────────

/** How often to sample the pool. 30 s is the same cadence as memory-watchdog. */
const SAMPLE_INTERVAL_MS = 30_000;
/** Consecutive over-threshold samples before emitting a warn-level alert. */
const SUSTAIN_SAMPLES = 3;
/** Utilization fraction below which a WARN alert is cleared (hysteresis). */
const RECOVERY_UTILIZATION = 0.6;

// ── Module-level state ────────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let consecutiveHighUtil = 0;
let highUtilAlertActive = false;
let waitingAlertActive = false;
let lastSampleAtMs = 0;
let lastActiveConnections = 0;
let lastIdleConnections = 0;
let lastWaitingConnections = 0;
let lastUtilizationRatio = 0;
let highUtilAlertCount = 0;
let waitingAlertCount = 0;

// ── Sample + alert logic ──────────────────────────────────────────────────────

function sample(): void {
  const now = Date.now();
  const active = pgPool.totalCount - pgPool.idleCount;
  const idle = pgPool.idleCount;
  const waiting = pgPool.waitingCount;
  const max = env.DB_POOL_MAX;
  const utilization = max > 0 ? active / max : 0;

  lastSampleAtMs = now;
  lastActiveConnections = active;
  lastIdleConnections = idle;
  lastWaitingConnections = waiting;
  lastUtilizationRatio = utilization;

  const warnThreshold = env.DB_POOL_WARN_UTILIZATION;

  // ── Tier 2: Waiting connections (immediate critical alert) ────────────────
  if (waiting > 0 && !waitingAlertActive) {
    waitingAlertActive = true;
    waitingAlertCount++;
    logger.error(
      { active, idle, waiting, max, utilization: utilization.toFixed(2) },
      "[db-pool-health] CRITICAL — connection pool has waiting queries. Callers are stalling. " +
      "Consider raising DB_POOL_MAX or reducing concurrent DB access.",
    );
    // Lazy-import to avoid circular deps at module load time.
    void import("../modules/admin-ops/admin-event-bus.js").then(({ adminEventBus }) => {
      adminEventBus.push("ops-alert", {
        level: "critical",
        title: "DB Pool Saturation",
        message: `${waiting} connection(s) waiting — DB pool fully saturated (${active}/${max} active). Queries are stalling.`,
        detail: `active=${active} idle=${idle} waiting=${waiting} max=${max} utilization=${Math.round(utilization * 100)}%`,
        timestamp: new Date().toISOString(),
        source: "db-pool-health",
      });
    }).catch(() => {});
  } else if (waiting === 0 && waitingAlertActive) {
    waitingAlertActive = false;
    logger.info({ active, idle, max }, "[db-pool-health] connection pool waiting queue cleared");
  }

  // ── Tier 1: High utilization (sustained warn alert) ───────────────────────
  if (utilization >= warnThreshold) {
    consecutiveHighUtil++;
    if (consecutiveHighUtil >= SUSTAIN_SAMPLES && !highUtilAlertActive) {
      highUtilAlertActive = true;
      highUtilAlertCount++;
      logger.warn(
        { active, idle, waiting, max, utilization: utilization.toFixed(2), warnThreshold, consecutiveHighUtil },
        "[db-pool-health] WARN — DB connection pool utilization exceeds threshold for " +
        `${consecutiveHighUtil} consecutive samples. Consider raising DB_POOL_MAX.`,
      );
      void import("../modules/admin-ops/admin-event-bus.js").then(({ adminEventBus }) => {
        adminEventBus.push("ops-alert", {
          level: "warn",
          title: "DB Pool High Utilization",
          message: `DB pool at ${Math.round(utilization * 100)}% capacity (${active}/${max} active connections).`,
          detail: `active=${active} idle=${idle} waiting=${waiting} threshold=${Math.round(warnThreshold * 100)}%`,
          timestamp: new Date().toISOString(),
          source: "db-pool-health",
        });
      }).catch(() => {});
    }
  } else {
    consecutiveHighUtil = 0;
    if (highUtilAlertActive && utilization < RECOVERY_UTILIZATION) {
      highUtilAlertActive = false;
      logger.info(
        { active, idle, max, utilization: utilization.toFixed(2) },
        "[db-pool-health] connection pool utilization recovered below threshold",
      );
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function installDbPoolHealthMonitor(): void {
  if (monitorInterval) return; // already running
  // Run one sample immediately so the very first /health call has data.
  sample();
  monitorInterval = setInterval(sample, SAMPLE_INTERVAL_MS);
  monitorInterval.unref?.();
  logger.info(
    { intervalMs: SAMPLE_INTERVAL_MS, warnThreshold: env.DB_POOL_WARN_UTILIZATION },
    "[db-pool-health] DB pool health monitor started",
  );
}

export function uninstallDbPoolHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

// ── Status accessor ───────────────────────────────────────────────────────────

export interface DbPoolHealthStatus {
  active: number;
  idle: number;
  waiting: number;
  max: number;
  utilizationRatio: number;
  utilizationPct: number;
  highUtilAlertActive: boolean;
  waitingAlertActive: boolean;
  highUtilAlertCount: number;
  waitingAlertCount: number;
  lastSampleAtMs: number;
  warnThreshold: number;
}

export function getDbPoolHealthStatus(): DbPoolHealthStatus {
  return {
    active: lastActiveConnections,
    idle: lastIdleConnections,
    waiting: lastWaitingConnections,
    max: env.DB_POOL_MAX,
    utilizationRatio: lastUtilizationRatio,
    utilizationPct: Math.round(lastUtilizationRatio * 100),
    highUtilAlertActive,
    waitingAlertActive,
    highUtilAlertCount,
    waitingAlertCount,
    lastSampleAtMs,
    warnThreshold: env.DB_POOL_WARN_UTILIZATION,
  };
}
