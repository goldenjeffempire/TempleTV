import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

export const broadcastQueueTable = pgTable("broadcast_queue", {
  id: text("id").primaryKey(),
  videoId: text("video_id"),
  youtubeId: text("youtube_id").notNull(),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  durationSecs: integer("duration_secs").notNull().default(1800),
  localVideoUrl: text("local_video_url"),
  videoSource: text("video_source").notNull().default("youtube"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BroadcastQueueItem = typeof broadcastQueueTable.$inferSelect;
