import { and, eq, lte, sql } from "drizzle-orm";
import { db, schema, withDbRetry } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { notificationsService } from "../notifications/notifications.service.js";
import { workerSupervisor } from "../broadcast-v2/engine/worker-supervisor.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";

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
  private running = false;

  /**
   * Reset rows that were claimed into `sending` status but never completed
   * (e.g. process crash or SIGKILL between claim and status update). Rows
   * older than 5 minutes in `sending` are safe to reclaim because the
   * idempotency key on the audit row (`scheduled:{id}`) ensures the actual
   * push is a no-op even if sendPush is called a second time.
   */
  async resetStuckSending(): Promise<void> {
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
      throw err; // propagate so supervisor counts consecutive failures and opens circuit
    } finally {
      this.running = false;
    }
    return { dispatched, failed };
  }
}

export const scheduledNotificationDispatcher = new ScheduledNotificationDispatcher();

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
export function startNotificationDispatcher(): void {
  // Run stuck-sending recovery immediately on boot before the first poll tick.
  void scheduledNotificationDispatcher.resetStuckSending();

  // Periodic stuck-sending reset: reclaims rows that entered 'sending' status
  // but never completed (process crash, SIGKILL, etc.). Separate worker so
  // transient poll failures don't delay this safety-net.
  workerSupervisor.spawn({
    name: "notification-stuck-sending",
    fn: () => scheduledNotificationDispatcher.resetStuckSending(),
    intervalMs: 10 * 60_000,
    initialDelayMs: 10 * 60_000,
    backoffMs: [30_000, 60_000, 5 * 60_000],
  });

  // Main poll loop — supervisor provides concurrency guard (fn awaited before
  // next tick), circuit breaking, and deadman timeout.
  workerSupervisor.spawn({
    name: "notification-dispatcher",
    fn: () => scheduledNotificationDispatcher.runOnce().then(() => undefined),
    intervalMs: env.SCHEDULED_NOTIF_POLL_MS,
    initialDelayMs: env.SCHEDULED_NOTIF_POLL_MS,
    backoffMs: [5_000, 15_000, 30_000, 60_000],
    onCircuitOpen: (name, consecutiveFailures) => {
      try {
        adminEventBus.push("ops-alert", {
          level: "critical",
          title: "Notification Dispatcher Suspended",
          message: `Notification dispatcher circuit opened after ${consecutiveFailures} consecutive failures — scheduled notifications are paused. Auto-reset in 10 min.`,
          detail: "Check Diagnostics → Workers for recent error details.",
          timestamp: new Date().toISOString(),
          source: "notification-dispatcher",
          workerName: name,
        });
      } catch { /* non-fatal */ }
    },
  });

  logger.info(
    { pollMs: env.SCHEDULED_NOTIF_POLL_MS },
    "notification-dispatcher registered with supervisor",
  );
}
