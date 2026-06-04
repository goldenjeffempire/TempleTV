import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const cacheEntriesTable = pgTable("cache_entries", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type CacheEntry = typeof cacheEntriesTable.$inferSelect;
