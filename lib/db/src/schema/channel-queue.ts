import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

/**
 * Channel Queue — broadcast queue for non-primary Temple TV channels.
 *
 * The primary channel continues to use the legacy `broadcast_queue` table
 * (so zero changes to the existing engine). All additional channels
 * (Worship, Sermons, etc.) store their items here, keyed by `channel_id`.
 *
 * Schema mirrors `broadcast_queue` so the same engine logic applies.
 */
export const channelQueueTable = pgTable(
  "channel_queue",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    videoId: text("video_id"),
    youtubeId: text("youtube_id").notNull(),
    title: text("title").notNull(),
    thumbnailUrl: text("thumbnail_url").notNull().default(""),
    durationSecs: integer("duration_secs").notNull().default(1800),
    localVideoUrl: text("local_video_url"),
    hlsMasterUrl: text("hls_master_url"),
    videoSource: text("video_source").notNull().default("youtube"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_channel_queue_channel_active_sort").on(t.channelId, t.isActive, t.sortOrder),
    index("idx_channel_queue_video_id").on(t.videoId),
  ],
);

export type ChannelQueueItem = typeof channelQueueTable.$inferSelect;
export type NewChannelQueueItem = typeof channelQueueTable.$inferInsert;
