/**
 * In-process scheduled-notification dispatcher.
 *
 * Polls `scheduled_notifications` for rows where status='pending' and
 * scheduled_at <= now(), claims them with an atomic UPDATE...RETURNING
 * (so multiple replicas don't double-fire), then hands the payload to
 * the same `notificationsService.sendPush` that the synchronous send
 * endpoint uses. The audit row written by sendPush carries the
 * idempotency key we set here, so even if the worker is restarted
 * mid-claim and the row is somehow re-claimed, the second send is a
 * no-op.
 *
 * Failure handling:
 *   - On error, increment `attempts` and store the message.
 *   - When `attempts >= SCHEDULED_NOTIF_MAX_ATTEMPTS` flip status to
 *     `failed` so the worker stops retrying. The row remains in the
 *     table as an audit record.
 *   - Otherwise leave status='pending' so the next tick retries with
 *     exponential backoff applied at the row level via `scheduled_at`
 *     pushed forward.
 *
 * Single-process activation: only runs when RUN_MODE is `worker` or
 * `all`. In multi-replica deploys you should run RUN_MODE=worker on
 * exactly one instance (or use the out-of-process push-worker).
 */
declare class ScheduledNotificationDispatcher {
    private timer;
    private running;
    private stopped;
    /**
     * Reset rows that were claimed into `sending` status but never completed
     * (e.g. process crash or SIGKILL between claim and status update). Rows
     * older than 5 minutes in `sending` are safe to reclaim because the
     * idempotency key on the audit row (`scheduled:{id}`) ensures the actual
     * push is a no-op even if sendPush is called a second time.
     */
    private resetStuckSending;
    start(): void;
    stop(): void;
    /**
     * Single dispatch pass. Public so tests / on-demand admin tools can
     * trigger a tick without waiting for the timer.
     */
    runOnce(): Promise<{
        dispatched: number;
        failed: number;
    }>;
}
export declare const scheduledNotificationDispatcher: ScheduledNotificationDispatcher;
export {};
