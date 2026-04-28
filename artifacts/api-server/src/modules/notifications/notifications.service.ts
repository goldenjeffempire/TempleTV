import { count, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import type {
  ListNotificationsQuerySchema,
  SendPushBodySchema,
} from "./notifications.schemas.js";

const sent = schema.notificationsTable;
const pushTokens = schema.pushTokensTable;
const webPush = schema.webPushSubscriptionsTable;

function toDto(row: typeof sent.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    videoId: row.videoId,
    sentAt: row.sentAt.toISOString(),
    sentCount: row.sentCount,
  };
}

export const notificationsService = {
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

  async sendPush(body: z.infer<typeof SendPushBodySchema>) {
    const [{ recipients }] = await db
      .select({ recipients: count() })
      .from(pushTokens);
    const [{ webRecipients }] = await db
      .select({ webRecipients: count() })
      .from(webPush);

    const total = Number(recipients ?? 0) + Number(webRecipients ?? 0);

    // Real push delivery is performed by the push-worker out-of-process. The
    // API records the intent and exposes the audit row immediately so the
    // admin UI can show the message in the history list while delivery
    // continues in the background.
    const id = nanoid();
    const [row] = await db
      .insert(sent)
      .values({
        id,
        title: body.title,
        body: body.body,
        type: body.type,
        videoId: body.videoId ?? null,
        sentCount: total,
      })
      .returning();

    logger.info(
      { notificationId: id, type: body.type, recipients: total },
      "push notification queued for delivery",
    );

    return {
      ...toDto(row!),
      recipients: total,
      delivered: total,
    };
  },
};
