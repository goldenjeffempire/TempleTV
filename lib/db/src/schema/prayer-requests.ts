import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const prayerRequestsTable = pgTable("prayer_requests", {
  id: text("id").primaryKey(),
  name: text("name"),
  message: text("message").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("prayer_requests_created_at_idx").on(t.createdAt),
  index("prayer_requests_is_read_idx").on(t.isRead),
]);

export type PrayerRequest = typeof prayerRequestsTable.$inferSelect;
