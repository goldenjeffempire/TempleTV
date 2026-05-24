import { pgTable, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const playlistsTable = pgTable("playlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  loopMode: text("loop_mode").notNull().default("sequential"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const playlistVideosTable = pgTable(
  "playlist_videos",
  {
    id: text("id").primaryKey(),
    playlistId: text("playlist_id").notNull().references(() => playlistsTable.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    youtubeId: text("youtube_id").notNull(),
    title: text("title").notNull(),
    thumbnailUrl: text("thumbnail_url").notNull().default(""),
    duration: text("duration").notNull().default(""),
    category: text("category").notNull().default("sermon"),
    sortOrder: integer("sort_order").notNull().default(0),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    playlistIdx: index("playlist_videos_playlist_id_idx").on(t.playlistId),
    playlistOrderIdx: index("playlist_videos_playlist_order_idx").on(t.playlistId, t.sortOrder),
    // Allows efficient reverse lookups: "which playlists contain this video?"
    videoIdx: index("playlist_videos_video_id_idx").on(t.videoId),
  }),
);

export const insertPlaylistSchema = createInsertSchema(playlistsTable).omit({ createdAt: true, updatedAt: true });
export type InsertPlaylist = z.infer<typeof insertPlaylistSchema>;
export type Playlist = typeof playlistsTable.$inferSelect;
export type PlaylistVideo = typeof playlistVideosTable.$inferSelect;
