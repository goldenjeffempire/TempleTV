import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appConfigTable = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppConfigEntry = typeof appConfigTable.$inferSelect;
