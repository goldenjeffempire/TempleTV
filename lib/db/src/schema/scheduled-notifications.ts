import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { videosTable } from "./videos";

export const scheduledNotificationsTable = pgTable("scheduled_notifications", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  type: text("type").notNull(),
  // Nullable FK: when the referenced video is deleted, this is set to NULL so
  // the notification record is preserved for audit rather than cascade-deleted.
  videoId: text("video_id").references(() => videosTable.id, { onDelete: "set null" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"),
  // Actual recipient count from a *completed* delivery (Expo + Web Push
  // fan-out). Never overloaded for retry counting — see `attempts` below.
  sentCount: integer("sent_count").default(0),
  // Dedicated failed-attempt counter, decoupled from `sentCount`. Previously
  // the dispatcher reused `sentCount` (a delivery-count column) to track
  // retry attempts, which corrupted both the "how many attempts" and "how
  // many recipients" signals. Always increment this on a failed dispatch;
  // never touch it on success.
  attempts: integer("attempts").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  // Wall-clock time the row was atomically claimed into 'sending'. Used by
  // resetStuckSending() to detect a worker crash between claim and
  // completion. Deliberately NOT derived from `scheduledAt` (the row's
  // original due time), which is fixed at creation and would cause an
  // actively-being-processed row to be reclaimed mid-flight — a real
  // double-send race that existed before this column was added.
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  // Set the moment a row exhausts SCHEDULED_NOTIF_MAX_ATTEMPTS and is
  // permanently abandoned (status flips to 'failed'). Distinguishes a
  // genuine dead-letter from a row that failed once and is still retrying.
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
}, (table) => [
  // Hot-path dispatcher query: WHERE status = 'pending' AND scheduled_at <= now()
  // Without this composite index the dispatcher does a full table scan every 30 s.
  index("idx_scheduled_notifications_status_at").on(table.status, table.scheduledAt),
  // Lookup by videoId: used by the "notify when ready" flow to find pending
  // notifications tied to a specific video (e.g. after transcoding completes).
  index("idx_scheduled_notifications_video_id").on(table.videoId),
  // Stuck-'sending' sweep: WHERE status = 'sending' AND claimed_at <= cutoff.
  index("idx_scheduled_notifications_status_claimed").on(table.status, table.claimedAt),
]);

export type ScheduledNotification = typeof scheduledNotificationsTable.$inferSelect;
