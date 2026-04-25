import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const prayerRequestsTable = pgTable("prayer_requests", {
  id: text("id").primaryKey(),
  name: text("name"),
  message: text("message").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PrayerRequest = typeof prayerRequestsTable.$inferSelect;
