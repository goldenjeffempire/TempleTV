import { pgTable, text, timestamp, bigint } from "drizzle-orm/pg-core";

export const cacheEntriesTable = pgTable("cache_entries", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CacheEntry = typeof cacheEntriesTable.$inferSelect;
