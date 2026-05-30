import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userFavoritesTable = pgTable(
  "user_favorites",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    videoTitle: text("video_title").notNull(),
    videoThumbnail: text("video_thumbnail").notNull().default(""),
    videoCategory: text("video_category").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("user_favorites_user_id_idx").on(t.userId),
    // Unique constraint — required for the upsert (ON CONFLICT DO UPDATE) in
    // the POST /user/favorites route to work atomically and eliminate the
    // check-then-insert TOCTOU race.
    userVideoUniqueIdx: uniqueIndex("user_favorites_user_video_uniq_idx").on(t.userId, t.videoId),
  }),
);

export type UserFavorite = typeof userFavoritesTable.$inferSelect;
