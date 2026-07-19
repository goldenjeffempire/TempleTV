/**
 * Auto-Heal Monitor — 5-second broadcast operations watchdog.
 *
 * Continuously scans all broadcasting subsystems and takes immediate
 * remediation actions for acute failures that the longer-interval workers
 * (broadcast-health-monitor @ 60 s, queue-health-guard @ 3 min, etc.) would
 * miss in the first critical window.
 *
 * WHAT THIS DOES
 * ──────────────
 * Every SCAN_INTERVAL_MS (5 s) it evaluates seven health signals:
 *
 *   1. BROADCAST_STUCK      — sequence not advancing > STUCK_THRESHOLD_MS (90 s)
 *                             while queue has items → triggers orchestrator.reload()
 *   2. DEAD_AIR             — dead-air incident open > DEAD_AIR_THRESHOLD_MS (30 s)
 *                             → triggers orchestrator.reload()
 *   3. QUEUE_EMPTY          — active item count = 0 → triggers library scan
 *   4. ALL_ITEMS_BLOCKED    — all queue items suspended/blocked
 *                             → triggers reEnableAllSuspended()
 *   5. WORKER_CIRCUIT_OPEN  — any critical worker circuit transitions to open
 *                             → pushes ops-alert SSE event immediately
 *   6. MEMORY_PRESSURE      — RSS > rssWarnMb → pushes alert (GC handled by watchdog)
 *   7. ORCHESTRATOR_DOWN    — orchestrator not started > BOOT_GRACE_MS after process boot
 *                             → logs critical alert
 *
 * Each signal has an independent cooldown so rapid successive incidents don't
 * fire repeated remediations. Cooldowns survive process restarts via
 * in-memory timestamps (reset on restart, which is acceptable — a restart
 * itself is a recovery event).
 *
 * All actions are logged to a ring buffer (MAX_LOG_ENTRIES = 500) that is
 * exposed via getAutoHealStatus() and consumed by the /autoheal/status
 * REST endpoint. Each action is also pushed to the admin SSE bus as an
 * `autoheal-action` event so the monitoring page updates in real-time.
 */

import { randomUUID } from "node:crypto";
import { broadcastOrchestrator } from "./broadcast-orchestrator.js";
import { workerSupervisor } from "./worker-supervisor.js";
import { getDeadAirStats } from "./dead-air-tracker.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { reEnableAllSuspended } from "../repository/queue.repo.js";
import { scanLibraryAndEnqueue } from "../../broadcast/auto-enqueue.service.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../infrastructure/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 5_000;
const MAX_LOG_ENTRIES = 500;
const PROCESS_START_MS = Date.now();

/** Sequence advance age above which we consider broadcast stuck. */
const STUCK_THRESHOLD_MS = 90_000;
/** Dead-air incident duration above which we take action. */
const DEAD_AIR_THRESHOLD_MS = 30_000;
/** Grace period after process boot before ORCHESTRATOR_DOWN fires. */
const BOOT_GRACE_MS = 120_000;

/** Per-signal cooldowns to prevent rapid-fire remediations. */
const COOLDOWNS: Record<string, number> = {
  BROADCAST_STUCK: 120_000,
  DEAD_AIR: 120_000,
  QUEUE_EMPTY: 60_000,
  ALL_ITEMS_BLOCKED: 300_000,
  MEMORY_PRESSURE: 30_000,
  ORCHESTRATOR_DOWN: 60_000,
};

const CRITICAL_WORKERS = [
  "broadcast-health-monitor",
  "queue-integrity-validator",
  "media-integrity-scanner",
  "faststart-recovery",
  "content-rotation",
  "queue-health-guard",
  "queue-self-healing",
  "schedule-bridge",
];

// ── Types ─────────────────────────────────────────────────────────────────

export interface AutoHealAction {
  id: string;
  timestamp: number;
  service: string;
  action: string;
  severity: "info" | "warn" | "error" | "critical";
  result: "triggered" | "skipped" | "failed" | "noop";
  details: string;
}

export interface ActiveAlert {
  id: string;
  service: string;
  code: string;
  severity: "warn" | "error" | "critical";
  message: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

export interface ServiceStatus {
  name: string;
  label: string;
  status: "healthy" | "degraded" | "critical" | "unknown";
  detail: string;
  lastCheckedAt: number;
}

export interface AutoHealMetrics {
  broadcastSequence: number;
  broadcastItemCount: number;
  broadcastMode: string;
  sequenceAdvanceAgeMs: number;
  deadAirOpenMs: number | null;
  memoryRssMb: number;
  memoryWarnMb: number;
  memoryRestartMb: number;
  workerHealthyCount: number;
  workerTotalCount: number;
  autonomyScore: number;
}

export interface AutoHealStatus {
  monitorStartedAt: number;
  lastScanAt: number | null;
  scanCount: number;
  totalActionsTriggered: number;
  activeAlerts: ActiveAlert[];
  services: ServiceStatus[];
  recentActions: AutoHealAction[];
  metrics: AutoHealMetrics;
}

// ── State ─────────────────────────────────────────────────────────────────

let monitorTimer: NodeJS.Timeout | null = null;
let monitorStartedAt: number | null = null;
let lastScanAt: number | null = null;
let scanCount = 0;
let totalActionsTriggered = 0;
let scanning = false;

/** Ring buffer of recent automated actions (last MAX_LOG_ENTRIES). */
const actionLog: AutoHealAction[] = [];

/** Active alerts keyed by signal code. */
const activeAlerts = new Map<string, ActiveAlert>();

/** Last time each signal fired a remediation (for cooldown enforcement). */
const lastActionAt = new Map<string, number>();

/** Set of worker names whose circuit was open in the previous scan cycle. */
const prevOpenCircuits = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────

function onCooldown(signal: string): boolean {
  const last = lastActionAt.get(signal) ?? 0;
  return Date.now() - last < (COOLDOWNS[signal] ?? 60_000);
}

function touchCooldown(signal: string): void {
  lastActionAt.set(signal, Date.now());
}

function logAction(action: Omit<AutoHealAction, "id" | "timestamp">): AutoHealAction {
  const entry: AutoHealAction = { id: randomUUID(), timestamp: Date.now(), ...action };
  actionLog.unshift(entry);
  if (actionLog.length > MAX_LOG_ENTRIES) actionLog.length = MAX_LOG_ENTRIES;
  if (action.result === "triggered") totalActionsTriggered++;

  adminEventBus.push("autoheal-action", entry);

  logger.info(
    { service: entry.service, action: entry.action, result: entry.result, severity: entry.severity },
    `[auto-heal] ${entry.action} → ${entry.result}`,
  );
  return entry;
}

function raiseAlert(code: string, service: string, severity: ActiveAlert["severity"], message: string): void {
  const existing = activeAlerts.get(code);
  if (existing) {
    existing.lastSeenAt = Date.now();
    existing.count++;
  } else {
    activeAlerts.set(code, {
      id: randomUUID(),
      service,
      code,
      severity,
      message,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      count: 1,
    });
  }
}

function clearAlert(code: string): void {
  if (activeAlerts.has(code)) {
    activeAlerts.delete(code);
    adminEventBus.push("autoheal-alert-cleared", { code });
  }
}

// ── Core scan ─────────────────────────────────────────────────────────────

async function doScan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  const t0 = Date.now();
  scanCount++;
  lastScanAt = t0;

  try {
    const now = Date.now();
    const uptimeMs = now - PROCESS_START_MS;

    // ── 1. Orchestrator liveness ──────────────────────────────────────────
    const started = broadcastOrchestrator.isStarted();
    if (!started && uptimeMs > BOOT_GRACE_MS) {
      raiseAlert("ORCHESTRATOR_DOWN", "broadcast", "critical",
        "Orchestrator has not started after boot grace period — broadcast is offline");
      if (!onCooldown("ORCHESTRATOR_DOWN")) {
        touchCooldown("ORCHESTRATOR_DOWN");
        logAction({
          service: "broadcast",
          action: "ORCHESTRATOR_DOWN detected",
          severity: "critical",
          result: "noop",
          details: `Orchestrator not started after ${Math.round(uptimeMs / 1000)}s uptime. Check boot errors in /api/broadcast-v2/health.`,
        });
        adminEventBus.push("ops-alert", {
          level: "critical",
          title: "Broadcast Orchestrator Down",
          message: `The broadcast orchestrator has not started after ${Math.round(uptimeMs / 1000)}s. Broadcast is offline.`,
          source: "auto-heal-monitor",
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      clearAlert("ORCHESTRATOR_DOWN");
    }

    const sequence = broadcastOrchestrator.getSequence();
    const itemCount = broadcastOrchestrator.getItemCount();
    const lastAdvanceMs = broadcastOrchestrator.getLastSequenceAdvanceMs();
    const advanceAgeMs = now - lastAdvanceMs;
    const snap = broadcastOrchestrator.snapshot();
    const mode = snap?.mode ?? "unknown";

    // ── 2. Broadcast stuck detection ──────────────────────────────────────
    if (started && itemCount > 0 && advanceAgeMs > STUCK_THRESHOLD_MS) {
      raiseAlert("BROADCAST_STUCK", "broadcast", "error",
        `Broadcast sequence has not advanced in ${Math.round(advanceAgeMs / 1000)}s`);
      if (!onCooldown("BROADCAST_STUCK")) {
        touchCooldown("BROADCAST_STUCK");
        try {
          await broadcastOrchestrator.reload();
          logAction({
            service: "broadcast",
            action: "Reload triggered (stuck sequence)",
            severity: "error",
            result: "triggered",
            details: `Sequence stuck at ${sequence} for ${Math.round(advanceAgeMs / 1000)}s with ${itemCount} items. Reloaded orchestrator.`,
          });
        } catch (err) {
          logAction({
            service: "broadcast",
            action: "Reload failed (stuck sequence)",
            severity: "error",
            result: "failed",
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (advanceAgeMs <= STUCK_THRESHOLD_MS || itemCount === 0) {
      clearAlert("BROADCAST_STUCK");
    }

    // ── 3. Dead-air detection ──────────────────────────────────────────────
    let deadAirOpenMs: number | null = null;
    try {
      const da = getDeadAirStats();
      if (da.openIncident) {
        deadAirOpenMs = now - da.openIncident.startedAtMs;
        if (deadAirOpenMs > DEAD_AIR_THRESHOLD_MS) {
          raiseAlert("DEAD_AIR", "broadcast", "critical",
            `Dead air detected — channel offline for ${Math.round(deadAirOpenMs / 1000)}s`);
          if (!onCooldown("DEAD_AIR") && started) {
            touchCooldown("DEAD_AIR");
            try {
              await broadcastOrchestrator.reload();
              logAction({
                service: "broadcast",
                action: "Reload triggered (dead air)",
                severity: "critical",
                result: "triggered",
                details: `Channel offline ${Math.round(deadAirOpenMs / 1000)}s. Forced orchestrator reload to restore broadcast.`,
              });
            } catch (err) {
              logAction({
                service: "broadcast",
                action: "Reload failed (dead air)",
                severity: "critical",
                result: "failed",
                details: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      } else {
        clearAlert("DEAD_AIR");
      }
    } catch {
      // dead-air stats unavailable — non-fatal
    }

    // ── 4. Empty queue ────────────────────────────────────────────────────
    if (started && itemCount === 0) {
      // Check whether ytShuffleFallback is active.  On YouTube-only deployments
      // the local queue is always empty by design — ytShuffleFallback IS the
      // broadcast driver.  Raising a QUEUE_EMPTY alert in that state floods the
      // admin inbox with false-positive errors and triggers pointless library
      // scans that always return 0.  Suppress both the alert and the scan when
      // the override is a YouTube shuffle fallback.
      let ytShuffleActive = false;
      try {
        const { ytShuffleFallback } = await import("./youtube-shuffle-fallback.js");
        ytShuffleActive = ytShuffleFallback.isActive;
      } catch { /* non-fatal */ }

      if (ytShuffleActive) {
        // Queue empty but YouTube shuffle is on-air — not an error.
        clearAlert("QUEUE_EMPTY");
      } else {
        raiseAlert("QUEUE_EMPTY", "queue", "error", "Active broadcast queue is empty — nothing to air");
        if (!onCooldown("QUEUE_EMPTY")) {
          touchCooldown("QUEUE_EMPTY");
          try {
            const result = await scanLibraryAndEnqueue({ reason: "self-heal-empty" });
            logAction({
              service: "queue",
              action: "Library scan triggered (empty queue)",
              severity: "error",
              result: result.enqueued > 0 ? "triggered" : "noop",
              details: `Queue empty. Scanned ${result.scanned} videos, enqueued ${result.enqueued}.`,
            });
          } catch (err) {
            logAction({
              service: "queue",
              action: "Library scan failed (empty queue)",
              severity: "error",
              result: "failed",
              details: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } else if (itemCount > 0) {
      clearAlert("QUEUE_EMPTY");
    }

    // ── 5. All items blocked ──────────────────────────────────────────────
    // Detected via orchestrator mode being "all-blocked" or similar
    if (started && (mode as string) === "all-blocked" && itemCount > 0) {
      raiseAlert("ALL_ITEMS_BLOCKED", "queue", "error",
        "All broadcast queue items are blocked or suspended");
      if (!onCooldown("ALL_ITEMS_BLOCKED")) {
        touchCooldown("ALL_ITEMS_BLOCKED");
        try {
          const count = await reEnableAllSuspended();
          logAction({
            service: "queue",
            action: "Re-enabled all suspended items",
            severity: "error",
            result: count > 0 ? "triggered" : "noop",
            details: `All ${itemCount} items blocked. Re-enabled ${count} suspended items and triggered reload.`,
          });
          if (count > 0) await broadcastOrchestrator.reload();
        } catch (err) {
          logAction({
            service: "queue",
            action: "Re-enable failed (all items blocked)",
            severity: "error",
            result: "failed",
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if ((mode as string) !== "all-blocked") {
      clearAlert("ALL_ITEMS_BLOCKED");
    }

    // ── 6. Worker circuit breaker transitions ─────────────────────────────
    const { workers } = workerSupervisor.getWorkerStatuses();
    const workerByName = new Map(workers.map((w: { name: string }) => [w.name, w]));
    const criticalWorkers = CRITICAL_WORKERS.map((n) => workerByName.get(n)).filter(Boolean) as Array<{
      name: string; running: boolean; circuitOpen: boolean; consecutiveFailures: number;
    }>;
    const openNow = new Set(criticalWorkers.filter((w) => w.circuitOpen).map((w) => w.name));

    for (const name of openNow) {
      if (!prevOpenCircuits.has(name)) {
        const code = `WORKER_CIRCUIT_${name.toUpperCase().replace(/-/g, "_")}`;
        raiseAlert(code, "workers", "critical",
          `Worker "${name}" circuit breaker opened — auto-recovery suspended`);
        logAction({
          service: "workers",
          action: `Circuit breaker opened: ${name}`,
          severity: "critical",
          result: "noop",
          details: `Worker "${name}" has opened its circuit breaker. Automated recovery for this subsystem is suspended. Check diagnostics.`,
        });
      }
    }
    for (const name of prevOpenCircuits) {
      if (!openNow.has(name)) {
        const code = `WORKER_CIRCUIT_${name.toUpperCase().replace(/-/g, "_")}`;
        clearAlert(code);
        logAction({
          service: "workers",
          action: `Circuit breaker closed: ${name}`,
          severity: "info",
          result: "noop",
          details: `Worker "${name}" circuit has closed — normal operation resumed.`,
        });
      }
    }
    prevOpenCircuits.clear();
    for (const n of openNow) prevOpenCircuits.add(n);

    // ── 7. Memory pressure ────────────────────────────────────────────────
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const rssWarnMb = env.MEMORY_WARN_RSS_MB ?? 1500;
    const rssRestartMb = env.MEMORY_RESTART_RSS_MB ?? 2200;

    if (rssMb > rssWarnMb) {
      raiseAlert("MEMORY_PRESSURE", "system", "warn",
        `RSS ${rssMb} MB exceeds warn threshold ${rssWarnMb} MB`);
      if (!onCooldown("MEMORY_PRESSURE")) {
        touchCooldown("MEMORY_PRESSURE");
        logAction({
          service: "system",
          action: "Memory pressure alert",
          severity: rssMb > rssRestartMb * 0.9 ? "critical" : "warn",
          result: "noop",
          details: `RSS ${rssMb} MB / warn ${rssWarnMb} MB / restart ${rssRestartMb} MB. Memory watchdog will trigger GC if growth continues.`,
        });
      }
    } else {
      clearAlert("MEMORY_PRESSURE");
    }

    // ── Build service status snapshot ─────────────────────────────────────
    const healthyWorkers = criticalWorkers.filter((w) => w.running && !w.circuitOpen).length;
    const autonomyScore = Math.round((healthyWorkers / CRITICAL_WORKERS.length) * 100);

    const services: ServiceStatus[] = [
      {
        name: "broadcast",
        label: "Broadcast Engine",
        status: !started ? "critical"
          : advanceAgeMs > STUCK_THRESHOLD_MS && itemCount > 0 ? "degraded"
          : "healthy",
        detail: !started ? "Orchestrator not started"
          : `seq ${sequence} · ${itemCount} items · mode ${mode}`,
        lastCheckedAt: t0,
      },
      {
        name: "queue",
        label: "Broadcast Queue",
        status: itemCount === 0 ? "critical"
          : (mode as string) === "all-blocked" ? "degraded"
          : "healthy",
        detail: `${itemCount} active items`,
        lastCheckedAt: t0,
      },
      {
        name: "workers",
        label: "Background Workers",
        status: openNow.size > 0 ? "critical"
          : healthyWorkers < CRITICAL_WORKERS.length ? "degraded"
          : "healthy",
        detail: `${healthyWorkers}/${CRITICAL_WORKERS.length} critical workers healthy`,
        lastCheckedAt: t0,
      },
      {
        name: "memory",
        label: "Memory",
        status: rssMb > rssRestartMb * 0.9 ? "critical"
          : rssMb > rssWarnMb ? "degraded"
          : "healthy",
        detail: `${rssMb} MB RSS (warn ${rssWarnMb} MB)`,
        lastCheckedAt: t0,
      },
      {
        name: "dead-air",
        label: "Dead Air",
        status: deadAirOpenMs != null && deadAirOpenMs > DEAD_AIR_THRESHOLD_MS ? "critical"
          : deadAirOpenMs != null ? "degraded"
          : "healthy",
        detail: deadAirOpenMs != null
          ? `Incident open ${Math.round(deadAirOpenMs / 1000)}s`
          : "No incident",
        lastCheckedAt: t0,
      },
      {
        name: "autonomy",
        label: "Autonomy Score",
        status: autonomyScore === 100 ? "healthy"
          : autonomyScore >= 75 ? "degraded"
          : "critical",
        detail: `${autonomyScore}% — ${healthyWorkers}/${CRITICAL_WORKERS.length} workers`,
        lastCheckedAt: t0,
      },
    ];

    // Push a lightweight health tick every scan so the admin panel can
    // refresh without waiting for the next HTTP poll cycle.
    adminEventBus.push("autoheal-status-tick", {
      scanCount,
      activeAlertCount: activeAlerts.size,
      autonomyScore,
      services: services.map((s) => ({ name: s.name, status: s.status })),
    });

    // Store service statuses for getAutoHealStatus().
    latestServices = services;
    latestMetrics = {
      broadcastSequence: sequence,
      broadcastItemCount: itemCount,
      broadcastMode: mode,
      sequenceAdvanceAgeMs: advanceAgeMs,
      deadAirOpenMs,
      memoryRssMb: rssMb,
      memoryWarnMb: rssWarnMb,
      memoryRestartMb: rssRestartMb,
      workerHealthyCount: healthyWorkers,
      workerTotalCount: CRITICAL_WORKERS.length,
      autonomyScore,
    };

  } catch (err) {
    logger.warn({ err }, "[auto-heal-monitor] scan threw unexpectedly (non-fatal)");
  } finally {
    scanning = false;
    logger.debug({ durationMs: Date.now() - t0 }, "[auto-heal-monitor] scan complete");
  }
}

// ── Cached snapshots for status endpoint ──────────────────────────────────

let latestServices: ServiceStatus[] = [];
let latestMetrics: AutoHealMetrics = {
  broadcastSequence: 0, broadcastItemCount: 0, broadcastMode: "unknown",
  sequenceAdvanceAgeMs: 0, deadAirOpenMs: null,
  memoryRssMb: 0, memoryWarnMb: 1500, memoryRestartMb: 2200,
  workerHealthyCount: 0, workerTotalCount: CRITICAL_WORKERS.length, autonomyScore: 0,
};

// ── Public API ────────────────────────────────────────────────────────────

export function getAutoHealStatus(): AutoHealStatus {
  return {
    monitorStartedAt: monitorStartedAt ?? Date.now(),
    lastScanAt,
    scanCount,
    totalActionsTriggered,
    activeAlerts: Array.from(activeAlerts.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    services: latestServices,
    recentActions: actionLog.slice(0, 200),
    metrics: latestMetrics,
  };
}

export async function triggerManualScan(): Promise<{ scanCount: number; actionsTriggered: number }> {
  await doScan();
  return { scanCount, actionsTriggered: totalActionsTriggered };
}

export const autoHealMonitor = {
  start(): void {
    if (monitorTimer) return;
    monitorStartedAt = Date.now();
    monitorTimer = setInterval(() => {
      void doScan().catch((err) =>
        logger.warn({ err }, "[auto-heal-monitor] scheduled scan error"),
      );
    }, SCAN_INTERVAL_MS);
    monitorTimer.unref?.();

    void doScan().catch((err) =>
      logger.warn({ err }, "[auto-heal-monitor] initial scan error"),
    );

    logger.info({ intervalMs: SCAN_INTERVAL_MS }, "[auto-heal-monitor] started");
  },

  stop(): void {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  },
};
