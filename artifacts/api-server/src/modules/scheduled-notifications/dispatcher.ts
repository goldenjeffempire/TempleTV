import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema, withDbRetry } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { notificationsService } from "../notifications/notifications.service.js";
import { workerSupervisor } from "../broadcast-v2/engine/worker-supervisor.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import {
  scheduledNotifBacklogGauge,
  scheduledNotifDeadLetterTotal,
  scheduledNotifDispatchedTotal,
  SERVICE_LABELS,
} from "../../infrastructure/metrics.js";

/**
 * Push an ops-alert to the admin console via the existing admin event bus
 * (same channel the worker-supervisor's `onCircuitOpen` callback uses below)
 * so a permanently dead-lettered notification surfaces as an immediate
 * banner rather than silently sitting in the table until someone checks.
 */
function emitNotifExhaustedAlert(title: string, id: string, errorMsg: string): void {
  try {
    adminEventBus.push("ops-alert", {
      level: "warn",
      title: "Scheduled Notification Dead-Lettered",
      message: `Scheduled notification "${title}" (id: ${id}) exhausted max attempts and will no longer be retried.`,
      detail: errorMsg.slice(0, 300),
      timestamp: new Date().toISOString(),
      source: "notification-dispatcher",
    });
  } catch {
    // Non-critical — failure to emit the alert must not affect the dispatcher loop
  }
}

const scheduled = schema.scheduledNotificationsTable;

type ScheduledRow = typeof scheduled.$inferSelect;

const VALID_TYPES = new Set(["live", "new_video", "announcement", "test", "app_update"]);

/**
 * Validate a claimed row before attempting dispatch. These are *permanent*
 * data problems (bad row shape, dangling reference) that no amount of
 * retrying will fix — retrying them would just burn the attempt budget and
 * delay the eventual dead-letter by minutes for no benefit. Caught here they
 * are dead-lettered on the first pass with a clear error message instead.
 */
function validateRow(row: ScheduledRow): string | null {
  if (!row.title || !row.title.trim()) return "validation: title is empty";
  if (!row.body || !row.body.trim()) return "validation: body is empty";
  if (!row.type || !row.type.trim()) return "validation: type is empty";
  if (!row.scheduledAt || Number.isNaN(row.scheduledAt.getTime())) {
    return "validation: scheduledAt is null/invalid";
  }
  return null;
}

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
class ScheduledNotificationDispatcher {
  private running = false;

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
  async resetStuckSending(): Promise<void> {
    const cutoff = new Date(Date.now() - 5 * 60_000);
    try {
      const result = await withDbRetry(
        () =>
          db
            .update(scheduled)
            .set({ status: "pending", claimedAt: null })
            .where(
              and(
                eq(scheduled.status, "sending"),
                lte(scheduled.claimedAt, cutoff),
              ),
            )
            .returning({ id: scheduled.id }),
        { label: "dispatcher.resetStuckSending" },
      );
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
   * Atomically claim up to `batchSize` due rows using the standard
   * job-queue idiom: `SELECT ... FOR UPDATE SKIP LOCKED` to pick winners
   * without blocking on rows another replica/tick already holds, then a
   * follow-up `UPDATE ... WHERE id IN (...)` to flip them to 'sending' and
   * stamp `claimed_at`. Bounding the batch keeps a single tick's lock
   * footprint small even when the backlog is large (e.g. after downtime).
   */
  private async claimBatch(batchSize: number): Promise<ScheduledRow[]> {
    return withDbRetry(
      // Both statements MUST run inside the same transaction. Without this,
      // the row lock acquired by `FOR UPDATE SKIP LOCKED` is released the
      // instant the SELECT's implicit auto-commit transaction ends — before
      // the follow-up UPDATE runs — so a second concurrent tick could claim
      // (and dispatch) the very same rows this tick believes it just locked.
      // Running both inside one `db.transaction()` holds the lock from the
      // SELECT through the UPDATE, which is the entire point of using
      // FOR UPDATE SKIP LOCKED as a claim mechanism.
      () =>
        db.transaction(async (tx) => {
          const { rows: claimedIds } = await tx.execute<{ id: string }>(sql`
            SELECT id FROM ${scheduled}
            WHERE ${scheduled.status} = 'pending'
              AND ${scheduled.scheduledAt} <= now()
            ORDER BY ${scheduled.scheduledAt} ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          `);
          const ids = claimedIds.map((r) => r.id);
          if (ids.length === 0) return [];
          return tx
            .update(scheduled)
            .set({ status: "sending", claimedAt: new Date() })
            .where(inArray(scheduled.id, ids))
            .returning();
        }),
      { label: "dispatcher.claim" },
    );
  }

  /**
   * Single dispatch pass. Public so tests / on-demand admin tools can
   * trigger a tick without waiting for the timer.
   */
  async runOnce(): Promise<{ dispatched: number; failed: number; deadLettered: number }> {
    if (this.running) return { dispatched: 0, failed: 0, deadLettered: 0 };
    this.running = true;
    const dispatchId = nanoid(8);
    let dispatched = 0;
    let failed = 0;
    let deadLettered = 0;
    const startedAtMs = Date.now();
    try {
      const due = await this.claimBatch(env.SCHEDULED_NOTIF_BATCH_SIZE);

      if (due.length > 0) {
        logger.info({ dispatchId, claimed: due.length }, "scheduled-notification dispatcher: batch claimed");
      }

      for (const row of due) {
        const validationError = validateRow(row);
        if (validationError) {
          // Permanent data problem — dead-letter immediately, don't burn
          // retry attempts on something that can never succeed.
          deadLettered += 1;
          await withDbRetry(
            () =>
              db
                .update(scheduled)
                .set({
                  status: "failed",
                  errorMessage: validationError,
                  deadLetteredAt: new Date(),
                })
                .where(eq(scheduled.id, row.id)),
            { label: "dispatcher.validationDeadLetter" },
          );
          logger.error(
            { dispatchId, scheduledId: row.id, reason: validationError },
            "scheduled notification dead-lettered on validation (permanent data problem)",
          );
          emitNotifExhaustedAlert(row.title, row.id, validationError);
          continue;
        }

        try {
          const pushResult = await notificationsService.sendPush(
            {
              title: row.title,
              body: row.body,
              // The sendPush service narrows `type` to a known enum;
              // an arbitrary scheduled-row type maps to "announcement"
              // when it's not one of the recognised values.
              type: VALID_TYPES.has(row.type) ? (row.type as "live" | "new_video" | "announcement" | "test" | "app_update") : "announcement",
              videoId: row.videoId,
              // Reuse the scheduled-row id as the idempotency key on
              // the audit row. If the worker crashes between sendPush
              // and the status update below, the next tick re-claims
              // the row but the duplicate sendPush is a no-op (the
              // unique partial index on idempotency_key catches it).
              idempotencyKey: `scheduled:${row.id}`,
            },
            // Await the *real* delivery outcome (Expo + Web Push fan-out)
            // rather than just the audit-row insert. Without this the
            // dispatcher would mark the scheduled row "sent" with an
            // estimated recipient count the instant sendPush returns,
            // before delivery even started — masking real delivery
            // failures and recording a bogus sentCount.
            { awaitDelivery: true },
          );

          if (pushResult.status === "failed") {
            // Delivery genuinely failed downstream (deliverPushNotification
            // threw) even though sendPush itself didn't throw — treat this
            // exactly like a thrown error so it goes through the same
            // attempts/backoff/dead-letter path.
            throw new Error(pushResult.errorMessage ?? "push delivery failed");
          }

          await withDbRetry(
            () =>
              db
                .update(scheduled)
                .set({
                  status: "sent",
                  sentAt: new Date(),
                  sentCount: pushResult.delivered,
                  errorMessage: null,
                })
                .where(eq(scheduled.id, row.id)),
            { label: "dispatcher.markSent" },
          );
          dispatched += 1;
          scheduledNotifDispatchedTotal.inc({ result: "sent", ...SERVICE_LABELS });
          logger.info(
            { dispatchId, scheduledId: row.id, type: row.type, delivered: pushResult.delivered },
            "scheduled notification dispatched",
          );
        } catch (err) {
          failed += 1;
          scheduledNotifDispatchedTotal.inc({ result: "failed", ...SERVICE_LABELS });
          const attempts = row.attempts + 1;
          const exhausted = attempts >= env.SCHEDULED_NOTIF_MAX_ATTEMPTS;
          const errMsg = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
          if (exhausted) deadLettered += 1;
          await withDbRetry(
            () =>
              db
                .update(scheduled)
                .set({
                  status: exhausted ? "failed" : "pending",
                  attempts,
                  errorMessage: errMsg,
                  deadLetteredAt: exhausted ? new Date() : null,
                  // Backoff: push the next attempt out 2^attempts minutes
                  // (capped at 30 min) so a transient downstream failure
                  // doesn't get hammered every poll interval.
                  scheduledAt: exhausted
                    ? row.scheduledAt
                    : new Date(Date.now() + Math.min(30, 2 ** attempts) * 60_000),
                })
                .where(eq(scheduled.id, row.id)),
            { label: "dispatcher.markFailed" },
          );
          logger.error(
            { dispatchId, err, scheduledId: row.id, attempts, exhausted },
            "scheduled notification dispatch failed",
          );
          if (exhausted) {
            scheduledNotifDeadLetterTotal.inc(SERVICE_LABELS);
            emitNotifExhaustedAlert(row.title, row.id, errMsg);
          }
        }
      }

      // Backlog gauge for health monitoring — cheap COUNT(*) against the
      // composite (status, scheduled_at) index, run after the batch so it
      // reflects the post-tick backlog.
      void this.refreshBacklogGauge();
    } catch (err) {
      logger.error({ dispatchId, err }, "dispatcher tick failed (will retry next interval)");
      throw err; // propagate so supervisor counts consecutive failures and opens circuit
    } finally {
      this.running = false;
      logger.info(
        { dispatchId, dispatched, failed, deadLettered, durationMs: Date.now() - startedAtMs },
        "scheduled-notification dispatcher tick complete",
      );
    }
    return { dispatched, failed, deadLettered };
  }

  private async refreshBacklogGauge(): Promise<void> {
    try {
      const [row] = await db.execute<{ pending_due: string; sending: string; dead_letter: string }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_at <= now()) AS pending_due,
          COUNT(*) FILTER (WHERE status = 'sending') AS sending,
          COUNT(*) FILTER (WHERE status = 'failed' AND dead_lettered_at IS NOT NULL) AS dead_letter
        FROM scheduled_notifications
      `).then((r) => r.rows);
      if (row) {
        scheduledNotifBacklogGauge.set({ state: "pending_due", ...SERVICE_LABELS }, Number(row.pending_due));
        scheduledNotifBacklogGauge.set({ state: "sending", ...SERVICE_LABELS }, Number(row.sending));
        scheduledNotifBacklogGauge.set({ state: "dead_letter", ...SERVICE_LABELS }, Number(row.dead_letter));
      }
    } catch (err) {
      logger.warn({ err }, "scheduled-notification dispatcher: backlog gauge refresh failed (non-fatal)");
    }
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
    { pollMs: env.SCHEDULED_NOTIF_POLL_MS, batchSize: env.SCHEDULED_NOTIF_BATCH_SIZE },
    "notification-dispatcher registered with supervisor",
  );
}
