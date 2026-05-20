import { pgTable, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const scheduleTable = pgTable("schedule_entries", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time"),
  contentType: text("content_type").notNull(),
  contentId: text("content_id"),
  isRecurring: boolean("is_recurring").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // The `WHERE is_active = true` count runs from at least four hot paths
  // (admin stats x3, broadcast cold-build, /healthz). Even on a small table
  // a sequence scan inside a parallel-three-read p95 budget is wasteful.
  index("idx_schedule_entries_active").on(table.isActive),
  // Admin schedule list orders by `(dayOfWeek, startTime)`. A composite
  // index makes the sort an index scan rather than a sort node.
  index("idx_schedule_entries_day_time").on(table.dayOfWeek, table.startTime),
]);

export const insertScheduleSchema = createInsertSchema(scheduleTable).omit({ createdAt: true });
export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
export type ScheduleEntry = typeof scheduleTable.$inferSelect;
