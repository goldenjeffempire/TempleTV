import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const liveOverridesTable = pgTable("live_overrides", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLiveOverrideSchema = createInsertSchema(liveOverridesTable).omit({ createdAt: true });
export type InsertLiveOverride = z.infer<typeof insertLiveOverrideSchema>;
export type LiveOverride = typeof liveOverridesTable.$inferSelect;