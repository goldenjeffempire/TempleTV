import { pgTable, integer, boolean, timestamp, text } from "drizzle-orm/pg-core";

/**
 * Singleton configuration row (id = 1 always) for the Midnight Prayers
 * automatic broadcast window.  Defaults to 12:00 AM – 3:00 AM in the
 * configured timezone.  The schedule is enforced client-side: each device
 * reads its own local clock, compares against startHour/endHour, and
 * switches from the main channel to the midnight-prayers channel
 * automatically.
 */
export const midnightPrayersConfig = pgTable("midnight_prayers_config", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(true),
  startHour: integer("start_hour").notNull().default(0),
  endHour: integer("end_hour").notNull().default(3),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
