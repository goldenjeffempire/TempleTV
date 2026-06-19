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
    /**
     * Total video duration in seconds — stored alongside progress so the
     * `GET /user/continue-watching` query can filter out completed videos
     * (progressSecs / durationSecs >= 0.95) without a JOIN to managed_videos.
     *
     * Null means the client did not supply duration at upsert time; these
     * entries are included in continue-watching results conservatively.
     */
    durationSecs: integer("duration_secs"),
  },
  (t) => ({
    userIdx: index("user_watch_history_user_id_idx").on(t.userId),
    userWatchedIdx: index("user_watch_history_user_watched_idx").on(t.userId, t.watchedAt),
    videoIdx: index("user_watch_history_video_id_idx").on(t.videoId),
    userVideoIdx: uniqueIndex("user_watch_history_user_video_idx").on(t.userId, t.videoId),
  }),
);

export type UserWatchHistory = typeof userWatchHistoryTable.$inferSelect;
