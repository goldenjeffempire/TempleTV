import { pgTable, text, timestamp, boolean, integer, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const scheduleTable = pgTable("schedule_entries", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /**
   * 0 (Sun) – 6 (Sat) for recurring weekly entries.
   * null when `scheduledDate` is set (one-time events derive the day from the date).
   */
  dayOfWeek: integer("day_of_week"),
  startTime: text("start_time").notNull(),
  endTime: text("end_time"),
  contentType: text("content_type").notNull(),
  contentId: text("content_id"),
  isRecurring: boolean("is_recurring").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * ISO date string "YYYY-MM-DD" for one-time (non-recurring) scheduled events.
   * When set, `isRecurring` should be false and `dayOfWeek` may be null.
   * The schedule-bridge matches these by comparing scheduledDate to today's
   * local date string rather than by dayOfWeek.
   *
   * After a one-time event fires, the bridge sets `isActive=false` so the
   * entry does not re-fire even if the server restarts (clearing the in-memory
   * firedSlots map).
   */
  scheduledDate: text("scheduled_date"),
  /**
   * When true and contentType = "video", the bridge uses the broadcast
   * override mechanism (broadcastOrchestrator.startOverride) instead of
   * simply enqueuing the video. This guarantees the video plays at the
   * scheduled time, interrupting whatever is currently on-air.
   *
   * For live / external types this is always effectively true — overrides
   * are their only dispatch mode. For playlist type this flag is ignored.
   */
  priorityOverride: boolean("priority_override").notNull().default(false),
}, (table) => [
  index("idx_schedule_entries_active").on(table.isActive),
  index("idx_schedule_entries_day_time").on(table.dayOfWeek, table.startTime),
  index("idx_schedule_entries_scheduled_date").on(table.scheduledDate),
  /**
   * Enforce weekday range at the DB layer. day_of_week must be NULL (one-time
   * events that derive the day from scheduledDate) or a valid JS weekday
   * integer 0 (Sunday) through 6 (Saturday). This prevents the historical bug
   * where nowMinutes() (range 0-1439) was accidentally used in place of
   * getDay() (range 0-6), producing values like 313 (= 5*60+13 at 05:13).
   */
  check(
    "chk_schedule_day_of_week_valid",
    sql`${table.dayOfWeek} IS NULL OR (${table.dayOfWeek} >= 0 AND ${table.dayOfWeek} <= 6)`,
  ),
]);

export const insertScheduleSchema = createInsertSchema(scheduleTable).omit({ createdAt: true });
export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
export type ScheduleEntry = typeof scheduleTable.$inferSelect;
