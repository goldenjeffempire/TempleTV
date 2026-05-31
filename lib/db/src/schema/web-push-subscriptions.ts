import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const webPushSubscriptionsTable = pgTable("web_push_subscriptions", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Mirrors push_tokens_last_seen_at_idx — used by OrphanCleanupWorker's
  // stale-subscription sweep (WHERE last_seen_at < cutoff LIMIT 5000).
  // Without this index the sweep is a full table scan on every 6-hour run.
  index("web_push_subscriptions_last_seen_at_idx").on(t.lastSeenAt),
]);

export type WebPushSubscription = typeof webPushSubscriptionsTable.$inferSelect;
