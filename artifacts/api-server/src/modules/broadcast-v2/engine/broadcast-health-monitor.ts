/**
 * Broadcast Health Monitor.
 *
 * An independent supervised worker that observes the broadcast-v2 orchestrator
 * from the outside.  Unlike the orchestrator's own self-heal timers (which
 * live inside the same EventEmitter), this monitor can detect and recover a
 * stuck orchestrator whose internal tick/reload loop has silently stopped
 * advancing the sequence.
 *
 * Recovery tiers
 * ──────────────
 *   1. Stale-reload (STALE_MS, default 5 min):
 *      If started=true, items>0, and the sequence has not advanced for
 *      STALE_MS (while not within the normal playback window of the current
 *      item), call orchestrator.reload() to nudge it back into motion.
 *
 *   2. Full-recovery escalation (RECOVERY_MS, default 10 min):
 *      If the previous reload did not unstick the orchestrator within
 *      another monitor cycle, escalate to orchestrator.initiateFullRecovery():
 *      stop → clear bad-URL cache → re-enable suspended items → start.
 *      Also emits an "ops-alert" SSE event and fires the broadcast webhook
 *      so external monitors (Slack, PagerDuty) are notified.
 *
 * Design principles
 * ─────────────────
 *   • Pure observer — this module does NOT modify the orchestrator's internal
 *     state directly; it only calls the orchestrator's public API.
 *   • Non-fatal — every DB or network call is wrapped in try/catch so a
 *     watchdog failure never crashes the API process.
 *   • No false positives — withinPlaybackWindow guard ensures long sermons
 *     (whose sequence legitimately doesn't advance until end-of-item) are
 *     never flagged as stuck.
 */

import { broadcastOrchestrator } from "./broadcast-orchestrator.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { sendBroadcastWebhookSync } from "../webhook/webhook.service.js";
import { sendAdminAlert } from "../../mail/mail.service.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";

// ── Module-level state ────────────────────────────────────────────────────────

/** Wall-clock ms when the last stale-reload was attempted. 0 = never. */
let lastStaleReloadAtMs = 0;
/** Wall-clock ms when the last full-recovery was attempted. 0 = never. */
let lastFullRecoveryAtMs = 0;
/** How many stale-reload actions have been taken since process boot. */
let staleReloadCount = 0;
/** How many full-recovery actions have been taken since process boot. */
let fullRecoveryCount = 0;
/** True while a full-recovery is in progress (prevents re-entrant triggers). */
let recoveryInFlight = false;
/** Last reason text recorded for the most recent stale/recovery event. */
let lastAlertReason: string | null = null;

// ── Main scan function ────────────────────────────────────────────────────────

/**
 * Called every BROADCAST_HEALTH_MONITOR_POLL_MS (default 60 s) by the worker
 * supervisor.  Never throws.
 */
export async function broadcastHealthMonitorScan(): Promise<void> {
  if (recoveryInFlight) {
    logger.debug("[broadcast-health-monitor] skipping scan — full recovery in progress");
    return;
  }

  const now = Date.now();
  const started = broadcastOrchestrator.isStarted();
  if (!started) return; // Orchestrator not booted yet — nothing to monitor.

  const itemCount = broadcastOrchestrator.getItemCount();
  if (itemCount === 0) return; // Empty queue is valid OFF_AIR state, not a hang.

  const sequence = broadcastOrchestrator.getSequence();
  const lastAdvanceMs = broadcastOrchestrator.getLastSequenceAdvanceMs();
  const advanceAgeMs = now - lastAdvanceMs;

  // Playback-window guard: if the current item is still within its expected
  // duration + a grace buffer, the sequence legitimately hasn't advanced yet.
  const snap = broadcastOrchestrator.snapshot();
  const currentItemElapsedMs = snap.current != null
    ? Math.max(0, now - snap.current.startsAtMs)
    : 0;
  const currentItemDurationMs = snap.current != null
    ? snap.current.durationSecs * 1000
    : 0;
  const PLAYBACK_GRACE_MS = env.BROADCAST_HEALTH_MONITOR_STALE_MS;
  const withinPlaybackWindow =
    snap.current != null &&
    currentItemElapsedMs < currentItemDurationMs + PLAYBACK_GRACE_MS;

  if (withinPlaybackWindow) return; // Item still playing — not stuck.

  // ── Tier 1: Stale reload ────────────────────────────────────────────────────
  const STALE_MS = env.BROADCAST_HEALTH_MONITOR_STALE_MS;
  const RECOVERY_MS = env.BROADCAST_HEALTH_MONITOR_RECOVERY_MS;

  if (advanceAgeMs >= STALE_MS) {
    const reason = `sequence=${sequence} not advanced for ${Math.round(advanceAgeMs / 1000)}s with ${itemCount} items`;

    // Determine whether enough time has passed since the last stale-reload to
    // escalate to a full recovery — or just retry the cheaper reload.
    const sinceLastReload = now - lastStaleReloadAtMs;
    const sinceLastRecovery = now - lastFullRecoveryAtMs;

    if (
      lastStaleReloadAtMs > 0 &&           // a prior reload was attempted
      sinceLastReload > STALE_MS &&         // the cooldown has passed
      sinceLastRecovery > RECOVERY_MS &&    // full-recovery cooldown has passed
      advanceAgeMs >= RECOVERY_MS           // stuck for long enough to escalate
    ) {
      // ── Tier 2: Full recovery escalation ───────────────────────────────────
      logger.error(
        { reason, advanceAgeMs, itemCount, sequence, staleReloadCount },
        "[broadcast-health-monitor] ESCALATING to full recovery — reload did not unstick orchestrator",
      );
      lastAlertReason = reason;
      fullRecoveryCount++;
      lastFullRecoveryAtMs = now;
      recoveryInFlight = true;

      // Fire ops-alert SSE so the admin console surfaces a banner.
      adminEventBus.push("ops-alert", {
        level: "critical",
        title: "Broadcast Recovery",
        message: `Broadcast orchestrator was stuck for ${Math.round(advanceAgeMs / 60_000)} min. Initiating full recovery.`,
        detail: reason,
        timestamp: new Date().toISOString(),
        source: "broadcast-health-monitor",
      });

      // Email the admin inbox. Critical: if no one has the dashboard open
      // at the time of the incident (e.g. overnight), SSE alone is not enough
      // — email is the only out-of-band notification path.
      void sendAdminAlert({
        subject: "Broadcast orchestrator stuck — full recovery initiated",
        severity: "critical",
        body: [
          `The broadcast-v2 orchestrator was stuck for ${Math.round(advanceAgeMs / 60_000)} minutes`,
          `with ${itemCount} items in the queue (sequence: ${sequence}).`,
          "",
          `Reason: ${reason}`,
          "",
          "Full recovery has been initiated automatically.",
          "Check the admin dashboard → Broadcast for the current status.",
        ].join("\n"),
      }).catch((err: unknown) => {
        logger.warn({ err }, "[broadcast-health-monitor] admin alert email failed (non-fatal)");
      });

      // Fire webhook (non-blocking) so external monitors are notified.
      void sendBroadcastWebhookSync(
        "dead_air",
        broadcastOrchestrator.channelId,
        { sequence, detail: `Health monitor triggered full recovery: ${reason}` },
      ).catch((err: unknown) => {
        logger.warn({ err }, "[broadcast-health-monitor] webhook notification failed (non-fatal)");
      });

      try {
        await broadcastOrchestrator.initiateFullRecovery(
          `broadcast-health-monitor: ${reason}`,
        );
      } finally {
        recoveryInFlight = false;
      }
    } else if (sinceLastReload > STALE_MS || lastStaleReloadAtMs === 0) {
      // ── Tier 1: Stale reload ────────────────────────────────────────────────
      logger.warn(
        { reason, advanceAgeMs, itemCount, sequence },
        "[broadcast-health-monitor] stale sequence detected — triggering reload",
      );
      lastAlertReason = reason;
      staleReloadCount++;
      lastStaleReloadAtMs = now;

      await broadcastOrchestrator.reload().catch((err: unknown) => {
        logger.warn({ err }, "[broadcast-health-monitor] stale-reload failed (non-fatal)");
      });
    }
  }
}

// ── Status accessor ───────────────────────────────────────────────────────────

export interface BroadcastHealthMonitorStatus {
  staleReloadCount: number;
  fullRecoveryCount: number;
  lastStaleReloadAtMs: number;
  lastFullRecoveryAtMs: number;
  recoveryInFlight: boolean;
  lastAlertReason: string | null;
  staleThresholdMs: number;
  recoveryThresholdMs: number;
}

export function getBroadcastHealthMonitorStatus(): BroadcastHealthMonitorStatus {
  return {
    staleReloadCount,
    fullRecoveryCount,
    lastStaleReloadAtMs: lastStaleReloadAtMs || 0,
    lastFullRecoveryAtMs: lastFullRecoveryAtMs || 0,
    recoveryInFlight,
    lastAlertReason,
    staleThresholdMs: env.BROADCAST_HEALTH_MONITOR_STALE_MS,
    recoveryThresholdMs: env.BROADCAST_HEALTH_MONITOR_RECOVERY_MS,
  };
}
