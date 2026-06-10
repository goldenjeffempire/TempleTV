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
/**
 * Called every BROADCAST_HEALTH_MONITOR_POLL_MS (default 60 s) by the worker
 * supervisor.  Never throws.
 */
export declare function broadcastHealthMonitorScan(): Promise<void>;
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
export declare function getBroadcastHealthMonitorStatus(): BroadcastHealthMonitorStatus;
