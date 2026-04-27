import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const notificationsTable = pgTable("sent_notifications", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  type: text("type").notNull(),
  videoId: text("video_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  sentCount: integer("sent_count").notNull().default(0),
}, (table) => [
  // Admin stats run `WHERE sent_at > now() - interval '1 day'` and the
  // history list does `ORDER BY sent_at DESC LIMIT N`. A descending index
  // on `sent_at` serves both: the count is a range scan, the list is a
  // straight backward index walk with no sort node.
  index("idx_sent_notifications_sent_at").on(table.sentAt.desc()),
]);

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ sentAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type SentNotification = typeof notificationsTable.$inferSelect;
