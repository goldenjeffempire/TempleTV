import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const scheduledNotificationsTable = pgTable("scheduled_notifications", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  type: text("type").notNull(),
  videoId: text("video_id"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"),
  sentCount: integer("sent_count"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export type ScheduledNotification = typeof scheduledNotificationsTable.$inferSelect;
