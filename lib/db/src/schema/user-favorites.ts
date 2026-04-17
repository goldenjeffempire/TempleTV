import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userFavoritesTable = pgTable("user_favorites", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull(),
  videoTitle: text("video_title").notNull(),
  videoThumbnail: text("video_thumbnail").notNull().default(""),
  videoCategory: text("video_category").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserFavorite = typeof userFavoritesTable.$inferSelect;
