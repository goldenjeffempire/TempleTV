/**
 * Content Rotation Worker.
 *
 * Shuffles the broadcast queue `sort_order` on a configurable interval
 * (BROADCAST_ROTATION_INTERVAL_MS, default 30 min) so 24/7 broadcasts
 * present content in a fresh order rather than cycling the same sequence
 * forever.
 *
 * Strategies (BROADCAST_ROTATION_STRATEGY):
 *   shuffle (default) — Fisher-Yates shuffle of all active queue item
 *                        sort_order values. Viewers see a new programme
 *                        order on the next reload boundary.
 *   fifo              — No-op. Preserves whatever order the operator set.
 *                        Use when a strict broadcast schedule is required.
 *
 * After a successful shuffle the worker emits `broadcast-queue-updated`
 * so the orchestrator reloads and applies the new order starting from the
 * next item advance. The currently-airing item is never interrupted; the
 * re-order takes effect at the next item boundary.
 *
 * Design principles
 * ─────────────────
 *   • Idempotent — shuffling the same set of sort_orders produces a
 *     different-but-valid order every time; no item is ever removed.
 *   • Atomic — all sort_order updates run inside a single DB transaction
 *     so the orchestrator never sees a partially-shuffled queue.
 *   • Non-fatal — any DB or lock error is logged and the worker retries on
 *     the next interval.  The existing order is always preserved on failure.
 *   • Low-overhead — only active items are touched; sort_orders are simple
 *     integers; the transaction is a single batch UPDATE per item.
 */
/**
 * Called by the worker supervisor on every interval tick.
 * Never throws — errors are caught, logged, and reflected in status.
 */
export declare function contentRotationScan(): Promise<void>;
export interface ContentRotationStatus {
    strategy: string;
    intervalMs: number;
    lastShuffleAtMs: number;
    shuffleCount: number;
    lastShuffleItemCount: number;
    lastShuffleError: string | null;
}
export declare function getContentRotationStatus(): ContentRotationStatus;
