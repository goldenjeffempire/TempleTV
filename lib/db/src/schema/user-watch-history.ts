import { pgTable, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userWatchHistoryTable = pgTable(
  "user_watch_history",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    videoTitle: text("video_title").notNull(),
    videoThumbnail: text("video_thumbnail").notNull().default(""),
    videoCategory: text("video_category").notNull().default(""),
    watchedAt: timestamp("watched_at", { withTimezone: true }).notNull().defaultNow(),
    progressSecs: integer("progress_secs").notNull().default(0),
  },
  (t) => ({
    userIdx: index("user_watch_history_user_id_idx").on(t.userId),
    userWatchedIdx: index("user_watch_history_user_watched_idx").on(t.userId, t.watchedAt),
    // Supports JOIN queries from the video detail page (e.g. "has user watched
    // this video before?" lookup) and batch history queries grouped by video.
    videoIdx: index("user_watch_history_video_id_idx").on(t.videoId),
    // Unique constraint on (userId, videoId) — each user has at most one history
    // entry per video. This is the target for onConflictDoUpdate upserts in
    // the POST /user/history route, replacing the racy SELECT + INSERT/UPDATE
    // two-step that could create duplicate rows under concurrent requests.
    userVideoIdx: uniqueIndex("user_watch_history_user_video_idx").on(t.userId, t.videoId),
  }),
);

export type UserWatchHistory = typeof userWatchHistoryTable.$inferSelect;
