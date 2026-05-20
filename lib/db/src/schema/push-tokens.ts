import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const pushTokensTable = pgTable("push_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  platform: text("platform").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("push_tokens_last_seen_at_idx").on(t.lastSeenAt),
]);

export type PushToken = typeof pushTokensTable.$inferSelect;
