import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const webPushSubscriptionsTable = pgTable("web_push_subscriptions", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WebPushSubscription = typeof webPushSubscriptionsTable.$inferSelect;
