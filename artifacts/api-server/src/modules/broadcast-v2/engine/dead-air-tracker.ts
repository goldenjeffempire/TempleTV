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
 * Install once via installDeadAirTracker() after the orchestrator is imported.
 * Safe to call multiple times — idempotent via `installed` guard.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../../infrastructure/logger.js";
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
}

const MAX_INCIDENTS = 50;
const closedIncidents: DeadAirIncident[] = [];
let currentIncident: DeadAirIncident | null = null;
let totalIncidents = 0;
let totalDeadAirMs = 0;
let longestIncidentMs = 0;
let trackerStartedAtMs = 0;
let installed = false;

export function getDeadAirStats(): DeadAirStats {
  const uptimeMs = trackerStartedAtMs > 0 ? Date.now() - trackerStartedAtMs : 0;
  const liveDeadAirMs = currentIncident
    ? totalDeadAirMs + (Date.now() - currentIncident.startedAtMs)
    : totalDeadAirMs;

  return {
    totalIncidents,
    openIncident: currentIncident ? { ...currentIncident } : null,
    recentIncidents: [...closedIncidents].reverse(),
    longestIncidentMs,
    totalDeadAirMs: liveDeadAirMs,
    onAirPct: uptimeMs > 0 ? Math.round(((uptimeMs - liveDeadAirMs) / uptimeMs) * 100 * 10) / 10 : null,
  };
}

export function installDeadAirTracker(): void {
  if (installed) return;
  installed = true;
  trackerStartedAtMs = Date.now();

  void import("./broadcast-orchestrator.js").then(({ broadcastOrchestrator }) => {
    broadcastOrchestrator.on("frame", (frame: V2ServerFrame) => {
      if (frame.type !== "snapshot") return;
      const snap = frame.state;

      const isOffAir =
        snap.mode === "queue" &&
        snap.current === null &&
        snap.override === null;

      if (isOffAir && !currentIncident) {
        currentIncident = {
          id: randomUUID(),
          startedAtMs: Date.now(),
          endedAtMs: null,
          durationMs: null,
          reason: snap.offAirReason ?? "unknown",
          recoveryMode: null,
        };
        logger.info(
          { reason: currentIncident.reason },
          "[dead-air-tracker] channel went off-air — incident opened",
        );
      } else if (!isOffAir && currentIncident) {
        const now = Date.now();
        const durationMs = now - currentIncident.startedAtMs;
        const closed: DeadAirIncident = {
          ...currentIncident,
          endedAtMs: now,
          durationMs,
          recoveryMode: snap.mode,
        };
        totalDeadAirMs += durationMs;
        if (durationMs > longestIncidentMs) longestIncidentMs = durationMs;
        totalIncidents++;
        closedIncidents.push(closed);
        if (closedIncidents.length > MAX_INCIDENTS) closedIncidents.shift();
        currentIncident = null;
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
