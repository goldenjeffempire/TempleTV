import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userWatchHistoryTable = pgTable("user_watch_history", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull(),
  videoTitle: text("video_title").notNull(),
  videoThumbnail: text("video_thumbnail").notNull().default(""),
  videoCategory: text("video_category").notNull().default(""),
  watchedAt: timestamp("watched_at", { withTimezone: true }).notNull().defaultNow(),
  progressSecs: integer("progress_secs").notNull().default(0),
});

export type UserWatchHistory = typeof userWatchHistoryTable.$inferSelect;
