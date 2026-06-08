import { and, eq, lte, sql } from "drizzle-orm";
import { db, schema, withDbRetry } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { notificationsService } from "../notifications/notifications.service.js";

/**
 * F43: emit an ops-alert SSE event via the broadcast engine so the admin
 * console surfaces an immediate banner when a notification is exhausted.
 * Dynamic import avoids a static circular-dependency between the
 * scheduled-notifications and broadcast modules.
 */
async function emitNotifExhaustedAlert(title: string, id: string, errorMsg: string): Promise<void> {
  try {
    const { broadcastEngine } = await import("../broadcast/queue.engine.js");
    (broadcastEngine as unknown as { emit: (ev: string, data: unknown) => void }).emit("event", {
      type: "ops-alert",
      data: {
        level: "warn",
        code: "notification-exhausted",
        message: `Scheduled notification "${title}" (id: ${id}) exhausted max attempts and will no longer be retried. Last error: ${errorMsg.slice(0, 300)}`,
      },
    });
  } catch {
    // Non-critical — failure to emit the alert must not affect the dispatcher loop
  }
}

const scheduled = schema.scheduledNotificationsTable;

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
class ScheduledNotificationDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private stuckInterval: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  /**
   * Reset rows that were claimed into `sending` status but never completed
   * (e.g. process crash or SIGKILL between claim and status update). Rows
   * older than 5 minutes in `sending` are safe to reclaim because the
   * idempotency key on the audit row (`scheduled:{id}`) ensures the actual
   * push is a no-op even if sendPush is called a second time.
   */
  private async resetStuckSending(): Promise<void> {
    const cutoff = new Date(Date.now() - 5 * 60_000);
    try {
      const result = await db
        .update(scheduled)
        .set({ status: "pending" })
        .where(
          and(
            eq(scheduled.status, "sending"),
            lte(scheduled.scheduledAt, cutoff),
          ),
        )
        .returning({ id: scheduled.id });
      if (result.length > 0) {
        logger.warn(
          { count: result.length },
          "scheduled-notification dispatcher: reset stuck 'sending' rows to 'pending' on startup",
        );
      }
    } catch (err) {
      // Non-fatal — the dispatcher will still function; stuck rows may remain
      // until manual intervention but won't block normal dispatch.
      logger.warn({ err }, "scheduled-notification dispatcher: resetStuckSending failed (non-fatal)");
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // Run stuck-sending recovery once at startup before the first tick.
    void this.resetStuckSending();
    // Also run it periodically so rows that get stuck during a long-lived
    // process (e.g., an unhandled rejection that bypassed the finally block)
    // are reclaimed without waiting for a process restart.
    this.stuckInterval = setInterval(() => {
      void this.resetStuckSending();
    }, 10 * 60_000); // every 10 minutes
    this.stuckInterval.unref?.();

    const tick = () => {
      if (this.stopped) return;
      void this.runOnce().finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(tick, env.SCHEDULED_NOTIF_POLL_MS);
        this.timer.unref?.();
      });
    };
    // First tick fires after one interval, not immediately on boot —
    // gives the rest of the process (DB pool, broadcast engine, etc.)
    // a chance to warm up before we start hitting the DB.
    this.timer = setTimeout(tick, env.SCHEDULED_NOTIF_POLL_MS);
    this.timer.unref?.();
    logger.info(
      { pollMs: env.SCHEDULED_NOTIF_POLL_MS },
      "scheduled-notification dispatcher started",
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stuckInterval) {
      clearInterval(this.stuckInterval);
      this.stuckInterval = null;
    }
    logger.info("scheduled-notification dispatcher stopped");
  }

  /**
   * Single dispatch pass. Public so tests / on-demand admin tools can
   * trigger a tick without waiting for the timer.
   */
  async runOnce(): Promise<{ dispatched: number; failed: number }> {
    if (this.running) return { dispatched: 0, failed: 0 };
    this.running = true;
    let dispatched = 0;
    let failed = 0;
    try {
      // Atomic claim. UPDATE...WHERE status='pending' AND scheduled_at<=now()
      // RETURNING * is race-free across replicas: the row-level lock
      // taken by the UPDATE serialises concurrent claimers, and only
      // the winner gets the row in the RETURNING set.
      const due = await withDbRetry(
        () =>
          db
            .update(scheduled)
            .set({ status: "sending" })
            .where(
              and(
                eq(scheduled.status, "pending"),
                lte(scheduled.scheduledAt, sql`now()`),
              ),
            )
            .returning(),
        { label: "dispatcher.claim" },
      );

      for (const row of due) {
        try {
          const pushResult = await notificationsService.sendPush({
            title: row.title,
            body: row.body,
            // The sendPush service narrows `type` to a known enum;
            // an arbitrary scheduled-row type maps to "announcement"
            // when it's not one of the recognised values.
            type:
              row.type === "live" ||
              row.type === "new_video" ||
              row.type === "announcement" ||
              row.type === "test"
                ? row.type
                : "announcement",
            videoId: row.videoId,
            // Reuse the scheduled-row id as the idempotency key on
            // the audit row. If the worker crashes between sendPush
            // and the status update below, the next tick re-claims
            // the row but the duplicate sendPush is a no-op (the
            // unique partial index on idempotency_key catches it).
            idempotencyKey: `scheduled:${row.id}`,
          });
          await db
            .update(scheduled)
            .set({
              status: "sent",
              sentAt: new Date(),
              // Use the actual delivery count from sendPush instead of the
              // previous hardcoded 1 — covers multi-platform fan-out correctly.
              sentCount: pushResult.sentCount ?? pushResult.delivered ?? 1,
              errorMessage: null,
            })
            .where(eq(scheduled.id, row.id));
          dispatched += 1;
          logger.info(
            { scheduledId: row.id, type: row.type },
            "scheduled notification dispatched",
          );
        } catch (err) {
          failed += 1;
          const attempts = (row.sentCount ?? 0) + 1;
          const exhausted = attempts >= env.SCHEDULED_NOTIF_MAX_ATTEMPTS;
          const errMsg = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
          await db
            .update(scheduled)
            .set({
              status: exhausted ? "failed" : "pending",
              sentCount: attempts,
              errorMessage: errMsg,
              // Backoff: push the next attempt out 2^attempts minutes
              // (capped at 30 min) so a transient downstream failure
              // doesn't get hammered every poll interval.
              scheduledAt: exhausted
                ? row.scheduledAt
                : new Date(Date.now() + Math.min(30, 2 ** attempts) * 60_000),
            })
            .where(eq(scheduled.id, row.id));
          logger.error(
            { err, scheduledId: row.id, attempts, exhausted },
            "scheduled notification dispatch failed",
          );
          // F43: notify the admin console immediately when a notification is permanently failed
          if (exhausted) {
            void emitNotifExhaustedAlert(row.title, row.id, errMsg);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "dispatcher tick failed (will retry next interval)");
    } finally {
      this.running = false;
    }
    return { dispatched, failed };
  }
}

export const scheduledNotificationDispatcher = new ScheduledNotificationDispatcher();
