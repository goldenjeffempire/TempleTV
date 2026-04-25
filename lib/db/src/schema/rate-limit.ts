import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const rateLimitTable = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

export type RateLimitBucket = typeof rateLimitTable.$inferSelect;
