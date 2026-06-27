import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userWatchLaterTable = pgTable(
  "user_watch_later",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    videoTitle: text("video_title").notNull(),
    videoThumbnail: text("video_thumbnail").notNull().default(""),
    videoCategory: text("video_category").notNull().default(""),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("user_watch_later_user_id_idx").on(t.userId),
    userVideoUniqueIdx: uniqueIndex("user_watch_later_user_video_uniq_idx").on(t.userId, t.videoId),
  }),
);

export type UserWatchLater = typeof userWatchLaterTable.$inferSelect;
