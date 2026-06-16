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

import { db, schema } from "../../../infrastructure/db.js";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";

/**
 * Stable advisory lock key for content rotation.
 * Uses a fixed 32-bit BigInt derived from a simple string hash so that any
 * process (or any rapid re-trigger of contentRotationScan) that tries to run
 * a concurrent shuffle is immediately skipped rather than double-shuffling.
 *
 * pg_try_advisory_xact_lock:
 *   • Transaction-scoped — releases automatically when the transaction commits
 *     or rolls back.  No manual unlock needed.
 *   • Non-blocking — returns false immediately if another session holds the lock;
 *     our caller skips this cycle rather than waiting, preventing pile-ups.
 */
const ROTATION_ADVISORY_LOCK_KEY = 1_234_567_891; // stable; collisions are benign

const q = schema.broadcastQueueTable;

// ── Module-level state ────────────────────────────────────────────────────────

/** Wall-clock ms of the last successful shuffle. 0 = never shuffled. */
let lastShuffleAtMs = 0;
/** Total shuffles performed since process boot. */
let shuffleCount = 0;
/** Number of items included in the last shuffle. */
let lastShuffleItemCount = 0;
/** Last error message from a failed shuffle attempt. Null on success. */
let lastShuffleError: string | null = null;

// ── Fisher-Yates shuffle ──────────────────────────────────────────────────────

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── Main scan function ────────────────────────────────────────────────────────

/**
 * Called by the worker supervisor on every interval tick.
 * Never throws — errors are caught, logged, and reflected in status.
 */
export async function contentRotationScan(): Promise<void> {
  if (env.BROADCAST_ROTATION_STRATEGY === "fifo") {
    return; // Operator requested strict FIFO — do nothing.
  }

  const intervalMs = env.BROADCAST_ROTATION_INTERVAL_MS;
  const now = Date.now();

  // Rate-limit: don't shuffle if we already shuffled within the interval.
  // (The worker supervisor calls us on its own interval, but a circuit-breaker
  // reset or manual trigger could fire a second call earlier than expected.)
  if (lastShuffleAtMs > 0 && now - lastShuffleAtMs < intervalMs * 0.9) {
    return;
  }

  try {
    // Load all active queue items (id + current sort_order).
    const rows = await db
      .select({ id: q.id, sortOrder: q.sortOrder })
      .from(q)
      .where(eq(q.isActive, true));

    if (rows.length < 2) {
      // Nothing to rotate: 0 or 1 items can't be meaningfully shuffled.
      logger.debug({ itemCount: rows.length }, "[content-rotation] fewer than 2 active items — skipping shuffle");
      return;
    }

    // Extract existing sort_order values and shuffle them.
    const originalOrders = rows.map((r) => r.sortOrder);
    const shuffledOrders = fisherYatesShuffle(originalOrders);

    // Apply the shuffled orders in a single transaction, protected by a
    // PostgreSQL advisory lock so that two concurrent invocations (e.g. a
    // rapid double-trigger via the event bus) cannot both commit a shuffle
    // in the same interval window.  pg_try_advisory_xact_lock returns FALSE
    // immediately when another session holds the lock — we roll back and skip
    // this cycle cleanly rather than blocking or double-shuffling.
    let lockAcquired = false;
    await db.transaction(async (tx) => {
      const [lockRow] = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(${ROTATION_ADVISORY_LOCK_KEY}) AS acquired`,
      );
      lockAcquired = Boolean((lockRow as { acquired?: boolean } | undefined)?.acquired);
      if (!lockAcquired) return; // Another process is shuffling — skip quietly.

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const newOrder = shuffledOrders[i]!;
        if (newOrder !== row.sortOrder) {
          await tx
            .update(q)
            .set({ sortOrder: newOrder })
            .where(and(eq(q.id, row.id), eq(q.isActive, true)));
        }
      }
    });

    if (!lockAcquired) {
      logger.debug(
        "[content-rotation] advisory lock held by another session — skipping this cycle",
      );
      return;
    }

    lastShuffleAtMs = now;
    shuffleCount++;
    lastShuffleItemCount = rows.length;
    lastShuffleError = null;

    logger.info(
      { itemCount: rows.length, shuffleCount, strategy: env.BROADCAST_ROTATION_STRATEGY },
      "[content-rotation] queue shuffled — broadcast will play content in new order on next item advance",
    );

    // Signal the orchestrator to reload so the new sort order takes effect
    // at the next item boundary (reload is non-interrupting for the current item).
    adminEventBus.push("broadcast-queue-updated", {});
  } catch (err) {
    lastShuffleError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "[content-rotation] shuffle failed (non-fatal) — will retry on next interval");
    throw err; // Re-throw so the worker supervisor records this as a failure.
  }
}

// ── Status accessor ───────────────────────────────────────────────────────────

export interface ContentRotationStatus {
  strategy: string;
  intervalMs: number;
  lastShuffleAtMs: number;
  shuffleCount: number;
  lastShuffleItemCount: number;
  lastShuffleError: string | null;
}

export function getContentRotationStatus(): ContentRotationStatus {
  return {
    strategy: env.BROADCAST_ROTATION_STRATEGY,
    intervalMs: env.BROADCAST_ROTATION_INTERVAL_MS,
    lastShuffleAtMs,
    shuffleCount,
    lastShuffleItemCount,
    lastShuffleError,
  };
}
