import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
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
});

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ sentAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type SentNotification = typeof notificationsTable.$inferSelect;
