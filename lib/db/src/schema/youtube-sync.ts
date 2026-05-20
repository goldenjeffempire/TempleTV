import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const youtubeSyncLogTable = pgTable("youtube_sync_log", {
  id: text("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  videosFound: integer("videos_found"),
  videosInserted: integer("videos_inserted"),
  videosUpdated: integer("videos_updated"),
  /** How many channel videos were skipped because they predate the 2-year cutoff. */
  videosSkipped: integer("videos_skipped"),
  /** How many previously-synced rows were deleted because they aged out. */
  videosDeleted: integer("videos_deleted"),
  errorMessage: text("error_message"),
  triggeredBy: text("triggered_by").notNull().default("scheduler"),
  source: text("source"),
}, (table) => [
  index("idx_youtube_sync_log_started_at").on(table.startedAt),
  index("idx_youtube_sync_log_status").on(table.status),
]);

export type YoutubeSyncLog = typeof youtubeSyncLogTable.$inferSelect;
