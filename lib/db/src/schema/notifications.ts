import { pgTable, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const notificationsTable = pgTable("sent_notifications", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  type: text("type").notNull(),
  videoId: text("video_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  sentCount: integer("sent_count").notNull().default(0),
  // Delivery state machine. The API row is the audit/intent record;
  // the out-of-process push-worker (or the in-process dispatcher when
  // RUN_MODE=all) updates these as it fans out to FCM/APNs/web-push.
  //   pending  → queued, no attempts yet
  //   sending  → at least one attempt in flight
  //   sent     → all transports succeeded (or best-effort completed)
  //   failed   → exhausted retry budget
  status: text("status").notNull().default("sent"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  // Caller-supplied idempotency key. When present, repeated POSTs with
  // the same key return the original audit row instead of creating a
  // duplicate intent — protects against double-clicks in the admin UI
  // and against mobile retries on flaky networks. Enforced by a unique
  // partial index below.
  idempotencyKey: text("idempotency_key"),
}, (table) => [
  // Admin stats run `WHERE sent_at > now() - interval '1 day'` and the
  // history list does `ORDER BY sent_at DESC LIMIT N`. A descending index
  // on `sent_at` serves both: the count is a range scan, the list is a
  // straight backward index walk with no sort node.
  index("idx_sent_notifications_sent_at").on(table.sentAt.desc()),
  // Dedup index. Two POSTs with the same idempotencyKey resolve to the
  // same audit row. NULLs are allowed — keys are optional, and Postgres
  // treats NULLs as distinct in unique indexes by default.
  uniqueIndex("idx_sent_notifications_idem_key").on(table.idempotencyKey),
]);

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ sentAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type SentNotification = typeof notificationsTable.$inferSelect;
