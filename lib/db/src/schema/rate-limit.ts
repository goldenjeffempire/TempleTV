import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const rateLimitTable = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
}, (table) => [
  // Cleanup query scans for expired buckets: DELETE WHERE reset_at < NOW().
  // Without this index the full table is scanned on every cleanup tick.
  index("idx_rate_limit_buckets_reset_at").on(table.resetAt),
]);

export type RateLimitBucket = typeof rateLimitTable.$inferSelect;
