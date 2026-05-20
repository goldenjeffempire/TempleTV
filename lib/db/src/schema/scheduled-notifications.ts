import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const scheduledNotificationsTable = pgTable("scheduled_notifications", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  type: text("type").notNull(),
  videoId: text("video_id"),
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
]);

export type ScheduledNotification = typeof scheduledNotificationsTable.$inferSelect;
