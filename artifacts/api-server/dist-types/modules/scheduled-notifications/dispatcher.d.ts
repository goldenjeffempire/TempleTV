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
