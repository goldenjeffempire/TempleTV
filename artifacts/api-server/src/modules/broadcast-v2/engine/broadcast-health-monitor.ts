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
import { getStorageHealthStatus } from "../../../infrastructure/storage-health-monitor.js";

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
  // Hard cap: the grace period during which the monitor is blind (item
  // still within its expected time slot) can never exceed 5 minutes,
  // regardless of the STALE_MS env-var value. Without this cap, setting
  // BROADCAST_HEALTH_MONITOR_STALE_MS=30min would give a 30-minute blind
  // period per item, and a 3-hour sermon could suppress the monitor for
  // 3h + 30min. The 5-minute cap is independent of item duration.
  const PLAYBACK_GRACE_MS = Math.min(env.BROADCAST_HEALTH_MONITOR_STALE_MS, 5 * 60_000);

  // Overrun detection: if the current item has been playing for MORE than
  // its expected duration PLUS 3× the grace period, the item has silently
  // overrun its slot — naturalItemEnd was never reported by any client
  // (e.g. no live clients, or all clients stalled before the natural end).
  // In this case we bypass the withinPlaybackWindow guard so the stale-
  // reload / full-recovery tiers can fire even while the elapsed time is
  // technically "within the window".  Without this, a 30-minute placeholder-
  // duration item whose video is only 20 minutes would suppress the health
  // monitor for up to 30 min + GRACE even though naturalItemEnd was missed.
  // "Massively overdue" threshold must account for actual item duration so
  // short-form content (<60 s clips) doesn't trigger a false stale-reload
  // at 3 × GRACE (which can be 9 min) when the item is only 10 s long.
  // Formula: at least 1× GRACE, or 1.5× the item's own duration — whichever
  // is larger — so both short items and long placeholder-duration items are
  // handled correctly.
  const itemMassivelyOverdue =
    snap.current != null &&
    currentItemElapsedMs >
      currentItemDurationMs + Math.max(PLAYBACK_GRACE_MS, currentItemDurationMs * 1.5);

  const withinPlaybackWindow =
    snap.current != null &&
    !itemMassivelyOverdue &&
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

      // Storage-aware recovery: if storage itself is unhealthy (write/head/delete
      // probe circuit open), use reloadPreservingBadUrlCache() instead of the
      // full recovery sequence. The full recovery path calls clearAllBadUrls()
      // and the per-item clearBadUrl() loop inside reloadInner(), which would
      // immediately re-serve recently-failed URLs — burning their exponential
      // backoff TTLs and triggering more RECOVERING→SKIP_PENDING cycles while
      // storage is still down. Preserving the blacklist lets the backoff timers
      // run out naturally while the storage probe circuit re-opens.
      const storageOk = getStorageHealthStatus().healthy;
      try {
        if (!storageOk) {
          logger.warn(
            { reason, storageOk },
            "[broadcast-health-monitor] storage probe unhealthy — downgrading full recovery to reloadPreservingBadUrlCache()",
          );
          await broadcastOrchestrator.reloadPreservingBadUrlCache().catch((err: unknown) => {
            logger.warn({ err }, "[broadcast-health-monitor] storage-degraded reload failed (non-fatal)");
          });
        } else {
          await broadcastOrchestrator.initiateFullRecovery(
            `broadcast-health-monitor: ${reason}`,
          );
        }
      } finally {
        recoveryInFlight = false;
      }
    } else if (sinceLastReload > STALE_MS || lastStaleReloadAtMs === 0) {
      // ── Tier 1: Stale reload ────────────────────────────────────────────────
      // Use the same recoveryInFlight flag as tier 2 so concurrent monitor
      // ticks (possible when the scan takes longer than the 60-second interval)
      // cannot stack up multiple simultaneous reload() calls.
      logger.warn(
        { reason, advanceAgeMs, itemCount, sequence },
        "[broadcast-health-monitor] stale sequence detected — triggering reload",
      );
      lastAlertReason = reason;
      staleReloadCount++;
      lastStaleReloadAtMs = now;
      recoveryInFlight = true;
      // Storage-aware tier-1: use the same cache-preserving variant when
      // storage is unhealthy so we don't re-serve dead URLs during a storage
      // outage. When storage is healthy use the standard reload() (which
      // re-enables recently-recovered items by clearing their bad-URL entries).
      const storageOkTier1 = getStorageHealthStatus().healthy;
      try {
        if (!storageOkTier1) {
          await broadcastOrchestrator.reloadPreservingBadUrlCache().catch((err: unknown) => {
            logger.warn({ err }, "[broadcast-health-monitor] storage-unhealthy stale-reload failed (non-fatal)");
          });
        } else {
          await broadcastOrchestrator.reload().catch((err: unknown) => {
            logger.warn({ err }, "[broadcast-health-monitor] stale-reload failed (non-fatal)");
          });
        }
      } finally {
        recoveryInFlight = false;
      }
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
