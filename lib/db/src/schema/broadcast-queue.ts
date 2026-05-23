import { pgTable, text, timestamp, integer, boolean, index, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const broadcastQueueTable = pgTable("broadcast_queue", {
  id: text("id").primaryKey(),
  videoId: text("video_id"),
  youtubeId: text("youtube_id").notNull().default(""),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  durationSecs: integer("duration_secs").notNull().default(1800),
  localVideoUrl: text("local_video_url"),
  // Populated after HLS transcoding completes; takes precedence over
  // localVideoUrl in the v2 orchestrator source resolver.
  hlsMasterUrl: text("hls_master_url"),
  videoSource: text("video_source").notNull().default("local"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Hot path: `buildBroadcastCurrentPayload` and the admin queue list both
  // run `WHERE is_active = true ORDER BY sort_order ASC`. A composite index
  // serves both the filter and the sort with a single index scan, which
  // matters because this query is on the cold-rebuild critical path of
  // /api/broadcast/current — the latency the cold-build watchdog watches.
  index("idx_broadcast_queue_active_sort_order").on(table.isActive, table.sortOrder),
  // Admin upload-finalize and the transcoder both look up queue rows by
  // `videoId` to flip `localVideoUrl` and emit broadcast-state events.
  // Without this, every transcode completion did a sequence scan.
  index("idx_broadcast_queue_video_id").on(table.videoId),
  // YouTube content belongs in the Library only, never the broadcast queue.
  check("no_youtube_in_queue", sql`${table.videoSource} != 'youtube'`),
  check("no_youtube_urls_in_queue", sql`${table.localVideoUrl} NOT LIKE '%youtube.com/watch%' AND ${table.localVideoUrl} NOT LIKE '%youtu.be/%'`),
  // Dedupe at the DB layer for the 24/7-continuity guarantee. Multiple
  // auto-enqueue paths race naturally:
  //   • event-triggered enqueueIfMissing() from upload finalize, faststart
  //     completion, transcoder completion, YouTube sync
  //   • the orchestrator's empty-queue self-heal library scan (every ~60s
  //     of OFF_AIR), which fires a NOT-EXISTS anti-join then inserts
  //   • a future second API replica behind a load balancer
  // Each path does a read-then-insert dedupe in application code, but two
  // concurrent paths can both pass the read and both insert, producing
  // duplicate queue rows that air back-to-back. A partial unique index on
  // `video_id` (excluding NULL — prod-sync upserts use videoId=NULL with
  // youtube_id as the dedupe key) eliminates that race authoritatively:
  // the second insert raises a unique-violation that the app already
  // swallows in enqueueIfMissing's try/catch. Partial so existing rows
  // with NULL video_id (legacy prod-sync) stay untouched.
  uniqueIndex("uq_broadcast_queue_video_id_active")
    .on(table.videoId)
    .where(sql`${table.videoId} IS NOT NULL`),
]);

export type BroadcastQueueItem = typeof broadcastQueueTable.$inferSelect;
