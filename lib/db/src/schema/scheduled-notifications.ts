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
  sentCount: integer("sent_count").default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (table) => [
  // Hot-path dispatcher query: WHERE status = 'pending' AND scheduled_at <= now()
  // Without this composite index the dispatcher does a full table scan every 30 s.
  index("idx_scheduled_notifications_status_at").on(table.status, table.scheduledAt),
  // Lookup by videoId: used by the "notify when ready" flow to find pending
  // notifications tied to a specific video (e.g. after transcoding completes).
  index("idx_scheduled_notifications_video_id").on(table.videoId),
]);

export type ScheduledNotification = typeof scheduledNotificationsTable.$inferSelect;
