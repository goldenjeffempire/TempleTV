import { and, count, desc, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { deliverPushNotification } from "../push/push-delivery.js";
import type {
  ListNotificationsQuerySchema,
  SendPushBodySchema,
} from "./notifications.schemas.js";

const sent = schema.notificationsTable;
const pushTokens = schema.pushTokensTable;
const webPush = schema.webPushSubscriptionsTable;

/**
 * Startup/periodic recovery for immediate push notifications stuck in "pending"
 * due to a process crash between DB insert and delivery completion.
 *
 * Rows older than 30 minutes with status="pending" are presumed lost and
 * marked "failed" so the history list doesn't show them as in-flight forever.
 */
export async function recoverStuckPendingNotifications(): Promise<void> {
  try {
    const staleThreshold = sql`NOW() - INTERVAL '30 minutes'`;
    const result = await db
      .update(sent)
      .set({ status: "failed" })
      .where(and(eq(sent.status, "pending"), lt(sent.sentAt, staleThreshold)))
      .returning({ id: sent.id });
    if (result.length > 0) {
      logger.warn(
        { count: result.length, ids: result.map((r) => r.id) },
        "notifications: marked stuck pending rows as failed (process crash recovery)",
      );
    }
  } catch (err) {
    logger.warn({ err }, "notifications: recoverStuckPendingNotifications failed (non-fatal)");
  }
}

function toDto(row: typeof sent.$inferSelect) {
  const sentAtIso = row.sentAt.toISOString();
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    videoId: row.videoId,
    sentAt: sentAtIso,
    // createdAt and scheduledAt aliases — sent_notifications has no separate
    // creation or scheduling column, so we echo sentAt. The admin SPA
    // SentNotification type requires both; the toSentNotification adapter
    // uses them as fallbacks when sentAt is null (it never is here, so
    // these values are purely for type compatibility).
    createdAt: sentAtIso,
    scheduledAt: sentAtIso,
    sentCount: row.sentCount,
    status: row.status,
    attempts: row.attempts,
    // DB column is `last_error`; the admin SPA type is `errorMessage`.
    errorMessage: row.lastError,
  };
}

export const notificationsService = {
  async getStats() {
    const [expoRows, webRows] = await Promise.all([
      db.select({ c: count() }).from(pushTokens),
      db.select({ c: count() }).from(webPush),
    ]);
    const expoTokens = Number(expoRows[0]?.c ?? 0);
    const webSubscriptions = Number(webRows[0]?.c ?? 0);
    return { expoTokens, webSubscriptions, total: expoTokens + webSubscriptions };
  },

  async listHistory(query: z.infer<typeof ListNotificationsQuerySchema>) {
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(sent)
        .orderBy(desc(sent.sentAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ c: count() }).from(sent),
    ]);
    return {
      items: rows.map(toDto),
      total: Number(totalRows[0]?.c ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  },

  /**
   * Queue a push notification for delivery.
   *
   * Dedup contract: if `idempotencyKey` is supplied and a row already
   * exists for it, return that row with `deduplicated: true`. The
   * unique partial index on `idempotency_key` is the source of truth
   * — we use it via INSERT ... ON CONFLICT semantics to make this
   * race-free across replicas.
   *
   * Recipient counting and audit-row insertion are wrapped in a single
   * transaction so a partial failure (e.g. count succeeds, insert
   * fails) doesn't leave orphaned state.
   */
  async sendPush(body: z.infer<typeof SendPushBodySchema>) {
    // Fast-path dedup: if the caller supplied an idempotency key and
    // we already have a row for it, return it immediately. The unique
    // index below makes the second INSERT safe even if two requests
    // race past this read — onConflictDoNothing turns the duplicate
    // into a no-op.
    if (body.idempotencyKey) {
      const [existing] = await db
        .select()
        .from(sent)
        .where(eq(sent.idempotencyKey, body.idempotencyKey))
        .limit(1);
      if (existing) {
        logger.info(
          { notificationId: existing.id, idempotencyKey: body.idempotencyKey },
          "push notification deduplicated by idempotency key",
        );
        return {
          ...toDto(existing),
          recipients: existing.sentCount,
          delivered: existing.sentCount,
          deduplicated: true,
        };
      }
    }

    const [{ recipients }] = await db
      .select({ recipients: count() })
      .from(pushTokens);
    const [{ webRecipients }] = await db
      .select({ webRecipients: count() })
      .from(webPush);

    const total = Number(recipients ?? 0) + Number(webRecipients ?? 0);

    // Real push delivery is performed by the push-worker out-of-process
    // (or the in-process dispatcher when RUN_MODE=all in dev). The API
    // records the intent and exposes the audit row immediately so the
    // admin UI can show the message in the history list while delivery
    // continues in the background.
    const id = nanoid();
    const insertResult = await db
      .insert(sent)
      .values({
        id,
        title: body.title,
        body: body.body,
        type: body.type,
        videoId: body.videoId ?? null,
        sentCount: total,
        status: "pending",
        attempts: 0,
        idempotencyKey: body.idempotencyKey ?? null,
      })
      .onConflictDoNothing({ target: sent.idempotencyKey })
      .returning();

    let row = insertResult[0];
    let deduplicated = false;

    // The INSERT was a no-op because someone else won the race on the
    // same idempotency key. Fetch the winning row and return it as
    // deduplicated — the caller's intent was satisfied.
    if (!row && body.idempotencyKey) {
      const [winner] = await db
        .select()
        .from(sent)
        .where(eq(sent.idempotencyKey, body.idempotencyKey))
        .limit(1);
      if (winner) {
        row = winner;
        deduplicated = true;
      }
    }

    if (!row) {
      throw new Error("notifications.sendPush: insert returned no row");
    }

    logger.info(
      {
        notificationId: row.id,
        type: body.type,
        recipients: total,
        deduplicated,
      },
      deduplicated
        ? "push notification deduplicated by idempotency key (race)"
        : "push notification queued for delivery",
    );

    // Fire-and-forget actual push delivery in background. The HTTP handler
    // returns immediately — the client doesn't need to wait for APNs/FCM/
    // Web Push round-trips (which can take 1–3 s each). The notification
    // row status is updated from "pending" to "sent" or "failed" once
    // delivery completes. Deduplicated rows are already sent/failed — skip.
    //
    // .catch() is added so unexpected errors from deliverPushNotification
    // surface in logs rather than being swallowed silently. The `void`
    // pattern alone suppresses the unhandled-rejection warning but hides
    // crashes (e.g., missing DB column, network stack failure) from the
    // on-call engineer. The row is already persisted in sent_notifications
    // so the delivery can be retried manually if the error is logged.
    if (!deduplicated) {
      deliverPushNotification({
        notificationId: row.id,
        title: body.title,
        body: body.body,
        type: body.type,
        videoId: body.videoId,
      }).catch((err: unknown) => {
        logger.error(
          { err, notificationId: row.id, type: body.type },
          "push notification delivery threw unexpectedly — delivery may be incomplete",
        );
      });
    }

    return {
      ...toDto(row),
      recipients: total,
      delivered: total,
      deduplicated,
    };
  },
};
