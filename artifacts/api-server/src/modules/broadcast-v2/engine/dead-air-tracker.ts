/**
 * Dead-Air Incident Tracker
 *
 * Monitors the broadcast orchestrator's frame stream and records every
 * period where the channel is off-air (no active queue item, no override).
 *
 * An incident opens when:
 *   - mode === "queue" AND current === null AND override === null
 * An incident closes (recovery) when:
 *   - current is non-null (item started) OR an override becomes active
 *
 * Incidents are kept in an in-memory ring buffer (last MAX_INCIDENTS).
 * A currently-open incident is tracked separately as `currentIncident`.
 *
 * Frame-liveness watchdog: if the orchestrator stops emitting frames for
 * FRAME_LIVENESS_TIMEOUT_MS (default 60 s) while the tracker is installed,
 * an ops-alert fires so operators know the orchestrator may be frozen. The
 * watchdog auto-clears when frames resume.
 *
 * Incident-duration alert: if a single dead-air incident exceeds
 * DEAD_AIR_ALERT_THRESHOLD_MS (default 120 s), a critical ops-alert fires.
 * The alert re-fires every DEAD_AIR_REFIRE_INTERVAL_MS (default 5 min)
 * while the incident remains open.
 *
 * Install once via installDeadAirTracker() after the orchestrator is imported.
 * Safe to call multiple times — idempotent via `installed` guard.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import type { V2ServerFrame } from "../domain/types.js";

export interface DeadAirIncident {
  id: string;
  /** Epoch-ms when the channel went off-air. */
  startedAtMs: number;
  /** Epoch-ms when the channel recovered. null = currently off-air. */
  endedAtMs: number | null;
  /** Duration in ms. null = still open. */
  durationMs: number | null;
  /** Why the channel was off-air. */
  reason: "empty" | "all_blocked" | "unknown";
  /** How the channel recovered. null = still open or in override mode. */
  recoveryMode: string | null;
}

export interface DeadAirStats {
  totalIncidents: number;
  openIncident: DeadAirIncident | null;
  recentIncidents: DeadAirIncident[];
  longestIncidentMs: number;
  totalDeadAirMs: number;
  /** Approximate on-air uptime percentage since tracker was installed. */
  onAirPct: number | null;
  /** Whether the orchestrator frame stream appears healthy. */
  frameLivenessOk: boolean;
  /** Epoch-ms of the most recent frame received. 0 = none yet. */
  lastFrameAtMs: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

const MAX_INCIDENTS = 50;

/** How long without a frame before the liveness alert fires. */
const FRAME_LIVENESS_TIMEOUT_MS  = parseInt(
  process.env.DEAD_AIR_FRAME_LIVENESS_TIMEOUT_MS ?? "60000", 10,
);

/** How long a single dead-air incident must last before ops-alert fires. */
const DEAD_AIR_ALERT_THRESHOLD_MS = parseInt(
  process.env.DEAD_AIR_ALERT_THRESHOLD_MS ?? "120000", 10,
);

/** How often the incident-duration alert re-fires while still open. */
const DEAD_AIR_REFIRE_INTERVAL_MS = parseInt(
  process.env.DEAD_AIR_REFIRE_INTERVAL_MS ?? "300000", 10,
);

/** How often the frame-liveness watchdog checks. */
const LIVENESS_CHECK_INTERVAL_MS = 30_000;

// ── State ─────────────────────────────────────────────────────────────────────

const closedIncidents: DeadAirIncident[] = [];
let currentIncident: DeadAirIncident | null = null;
let totalIncidents = 0;
let totalDeadAirMs = 0;
let longestIncidentMs = 0;
let trackerStartedAtMs = 0;
let lastFrameReceivedAtMs = 0;
/** True when the most recently received frame showed an off-air state. */
let lastSnapOffAir = false;
let livenessAlertActive = false;
let secondaryWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastIncidentAlertMs = 0;
let installed = false;
let livenessTimer: ReturnType<typeof setInterval> | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function getDeadAirStats(): DeadAirStats {
  const now      = Date.now();
  const uptimeMs = trackerStartedAtMs > 0 ? now - trackerStartedAtMs : 0;
  const liveDeadAirMs = currentIncident
    ? totalDeadAirMs + (now - currentIncident.startedAtMs)
    : totalDeadAirMs;

  const frameLivenessOk = !installed ||
    lastFrameReceivedAtMs === 0 ||               // nothing received yet — no alarm
    (now - lastFrameReceivedAtMs) < FRAME_LIVENESS_TIMEOUT_MS;

  return {
    totalIncidents,
    openIncident: currentIncident ? { ...currentIncident } : null,
    recentIncidents: [...closedIncidents].reverse(),
    longestIncidentMs,
    totalDeadAirMs: liveDeadAirMs,
    onAirPct: uptimeMs > 0 ? Math.round(((uptimeMs - liveDeadAirMs) / uptimeMs) * 100 * 10) / 10 : null,
    frameLivenessOk,
    lastFrameAtMs: lastFrameReceivedAtMs,
  };
}

// ── Frame-liveness watchdog ───────────────────────────────────────────────────

function checkFrameLiveness(): void {
  const now = Date.now();
  if (!installed || lastFrameReceivedAtMs === 0) return; // tracker just booted

  const gapMs = now - lastFrameReceivedAtMs;
  if (gapMs >= FRAME_LIVENESS_TIMEOUT_MS && !livenessAlertActive) {
    livenessAlertActive = true;
    logger.warn(
      { gapMs, thresholdMs: FRAME_LIVENESS_TIMEOUT_MS },
      "[dead-air-tracker] frame-liveness TIMEOUT — orchestrator may be frozen or crashed",
    );
    adminEventBus.push("ops-alert", {
      level:   "critical",
      code:    "dead-air-frame-liveness-timeout",
      message: `Broadcast orchestrator stopped emitting frames for ${Math.round(gapMs / 1000)}s — it may be frozen or crashed. No dead-air tracking until frames resume.`,
      gapMs,
    });
  } else if (gapMs < FRAME_LIVENESS_TIMEOUT_MS && livenessAlertActive) {
    livenessAlertActive = false;
    logger.info(
      { gapMs },
      "[dead-air-tracker] frame-liveness RECOVERED — orchestrator is emitting frames again",
    );
    adminEventBus.push("ops-alert", {
      level:   "info",
      code:    "dead-air-frame-liveness-recovered",
      message: `Broadcast orchestrator frame stream recovered after ${Math.round((now - trackerStartedAtMs) / 1000)}s.`,
    });
  }
}

// ── Open-incident duration alert ──────────────────────────────────────────────

function checkIncidentDuration(): void {
  if (!currentIncident) return;
  const now         = Date.now();
  const durationMs  = now - currentIncident.startedAtMs;

  if (
    durationMs >= DEAD_AIR_ALERT_THRESHOLD_MS &&
    (now - lastIncidentAlertMs) >= DEAD_AIR_REFIRE_INTERVAL_MS
  ) {
    lastIncidentAlertMs = now;
    logger.error(
      { durationMs: Math.round(durationMs), reason: currentIncident.reason },
      "[dead-air-tracker] DEAD-AIR ALERT — channel off-air beyond threshold",
    );
    adminEventBus.push("ops-alert", {
      level:   "critical",
      code:    "dead-air-sustained",
      message: `Channel has been off-air for ${Math.round(durationMs / 1000)}s (reason: ${currentIncident.reason}). ytShuffleFallback may not be active.`,
      durationMs:    Math.round(durationMs),
      reason:        currentIncident.reason,
      incidentId:    currentIncident.id,
      startedAtMs:   currentIncident.startedAtMs,
    });
  }
}

// ── Installer ─────────────────────────────────────────────────────────────────

export function installDeadAirTracker(): void {
  if (installed) return;
  installed = true;
  trackerStartedAtMs = Date.now();

  // Start the periodic liveness + incident-duration watchdog.
  livenessTimer = setInterval(() => {
    checkFrameLiveness();
    checkIncidentDuration();
  }, LIVENESS_CHECK_INTERVAL_MS);
  livenessTimer.unref?.();

  // Secondary watchdog: independently re-checks the last-known snap state
  // every 10 s. Catches the blind spot where the orchestrator sends a frame
  // showing dead-air but the incident-open logic inside the frame handler
  // misses it (e.g. a rapid burst of frames during state transition). Also
  // catches the case where the orchestrator enters dead-air and then freezes,
  // meaning no more frames arrive to drive the normal incident-close path.
  const SECONDARY_WATCHDOG_INTERVAL_MS = 10_000;
  secondaryWatchdogTimer = setInterval(() => {
    if (!installed || lastFrameReceivedAtMs === 0) return;
    if (lastSnapOffAir && !currentIncident) {
      currentIncident = {
        id:           randomUUID(),
        startedAtMs:  lastFrameReceivedAtMs, // best estimate: last frame showed dead-air
        endedAtMs:    null,
        durationMs:   null,
        reason:       "unknown",
        recoveryMode: null,
      };
      lastIncidentAlertMs = 0;
      logger.info(
        "[dead-air-tracker] secondary watchdog opened dead-air incident (missed by frame handler)",
      );
    }
  }, SECONDARY_WATCHDOG_INTERVAL_MS);
  secondaryWatchdogTimer.unref?.();

  void import("./broadcast-orchestrator.js").then(({ broadcastOrchestrator }) => {
    broadcastOrchestrator.on("frame", (frame: V2ServerFrame) => {
      if (frame.type !== "snapshot") return;
      lastFrameReceivedAtMs = Date.now();

      const snap = frame.state;
      lastSnapOffAir =
        snap.mode === "queue" &&
        snap.current === null &&
        snap.override === null;
      const isOffAir =
        snap.mode === "queue" &&
        snap.current === null &&
        snap.override === null;

      if (isOffAir && !currentIncident) {
        currentIncident = {
          id:           randomUUID(),
          startedAtMs:  Date.now(),
          endedAtMs:    null,
          durationMs:   null,
          reason:       (snap as { offAirReason?: "empty" | "all_blocked" | "unknown" }).offAirReason ?? "unknown",
          recoveryMode: null,
        };
        lastIncidentAlertMs = 0; // reset so threshold alert can fire on this new incident
        logger.info(
          { reason: currentIncident.reason },
          "[dead-air-tracker] channel went off-air — incident opened",
        );
      } else if (!isOffAir && currentIncident) {
        const now         = Date.now();
        const durationMs  = now - currentIncident.startedAtMs;
        const closed: DeadAirIncident = {
          ...currentIncident,
          endedAtMs:    now,
          durationMs,
          recoveryMode: snap.mode,
        };
        totalDeadAirMs  += durationMs;
        if (durationMs > longestIncidentMs) longestIncidentMs = durationMs;
        totalIncidents++;
        closedIncidents.push(closed);
        if (closedIncidents.length > MAX_INCIDENTS) closedIncidents.shift();
        currentIncident = null;
        lastIncidentAlertMs = 0;
        logger.info(
          { durationMs: Math.round(durationMs), recoveryMode: snap.mode },
          "[dead-air-tracker] channel recovered — incident closed",
        );
      }
    });
    logger.info("[dead-air-tracker] installed on orchestrator frame stream");
  }).catch((err) => {
    logger.warn({ err }, "[dead-air-tracker] install failed (non-fatal)");
  });
}

export function uninstallDeadAirTracker(): void {
  if (livenessTimer) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }
  if (secondaryWatchdogTimer) {
    clearInterval(secondaryWatchdogTimer);
    secondaryWatchdogTimer = null;
  }
  installed = false;
}
