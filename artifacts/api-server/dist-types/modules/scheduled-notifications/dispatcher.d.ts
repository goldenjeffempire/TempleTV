/**
 * In-process scheduled-notification dispatcher.
 *
 * Polls `scheduled_notifications` for rows where status='pending' and
 * scheduled_at <= now(), claims a bounded batch atomically with
 * `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE ... WHERE id IN (...)`
 * (so multiple replicas don't double-fire and don't block on each other's
 * row locks), then hands each payload to the same
 * `notificationsService.sendPush` that the synchronous send endpoint uses
 * — with `awaitDelivery: true` so the scheduled row's final status/sentCount
 * reflect the *real* delivery outcome, not just "audit row created". The
 * audit row written by sendPush carries the idempotency key we set here, so
 * even if the worker is restarted mid-claim and the row is somehow
 * re-claimed, the second send is a no-op.
 *
 * Failure handling:
 *   - On error, increment the dedicated `attempts` column (never `sentCount`
 *     — that column holds real delivery counts and must never be reused
 *     for retry bookkeeping) and store the message.
 *   - When `attempts >= SCHEDULED_NOTIF_MAX_ATTEMPTS` flip status to
 *     `failed` and stamp `deadLetteredAt` so the worker stops retrying and
 *     the row is unambiguously a dead letter, not a transient failure. The
 *     row remains in the table as an audit record.
 *   - Otherwise leave status='pending' so the next tick retries with
 *     exponential backoff applied at the row level via `scheduled_at`
 *     pushed forward.
 *
 * Single-process activation: only runs when RUN_MODE is `worker` or
 * `all`. In multi-replica deploys you should run RUN_MODE=worker on
 * exactly one instance (or use the out-of-process push-worker).
 */
declare class ScheduledNotificationDispatcher {
    private running;
    /**
     * Reset rows that were claimed into `sending` status but never completed
     * (e.g. process crash or SIGKILL between claim and status update). Rows
     * whose `claimed_at` is older than 5 minutes are safe to reclaim because
     * the idempotency key on the audit row (`scheduled:{id}`) ensures the
     * actual push is a no-op even if sendPush is called a second time.
     *
     * IMPORTANT: staleness is measured from `claimed_at` (when the row
     * actually entered 'sending'), NOT `scheduled_at` (the row's original due
     * time, fixed at creation). Using `scheduled_at` here previously caused a
     * genuine race: any row whose original due time was >5 min in the past —
     * which is common, since a row only needs `scheduled_at <= now()` to be
     * claimed at all — would be immediately reset back to 'pending' even
     * while it was still actively mid-flight in another tick, so the next
     * poll could claim and dispatch it a second time concurrently.
     */
    resetStuckSending(): Promise<void>;
    /**
     * Atomically claim up to `batchSize` due rows using the standard
     * job-queue idiom: `SELECT ... FOR UPDATE SKIP LOCKED` to pick winners
     * without blocking on rows another replica/tick already holds, then a
     * follow-up `UPDATE ... WHERE id IN (...)` to flip them to 'sending' and
     * stamp `claimed_at`. Bounding the batch keeps a single tick's lock
     * footprint small even when the backlog is large (e.g. after downtime).
     */
    private claimBatch;
    /**
     * Single dispatch pass. Public so tests / on-demand admin tools can
     * trigger a tick without waiting for the timer.
     */
    runOnce(): Promise<{
        dispatched: number;
        failed: number;
        deadLettered: number;
    }>;
    private refreshBacklogGauge;
}
export declare const scheduledNotificationDispatcher: ScheduledNotificationDispatcher;
/**
 * Register the notification dispatcher with WorkerSupervisor.
 *
 * Called from startSupervisedWorkers() in broadcast-v2/index.ts. The
 * supervisor provides circuit breaking (5 consecutive failures → 10-min
 * open), deadman timeouts, and health metrics — replacing the old manual
 * setInterval/setTimeout approach.
 *
 * Two workers are spawned:
 *  1. "notification-dispatcher"        — the main polling loop (runOnce)
 *  2. "notification-stuck-sending"     — periodic reset of stuck 'sending' rows
 */
export declare function startNotificationDispatcher(): void;
export {};
