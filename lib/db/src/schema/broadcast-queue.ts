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
  // ── Scheduled programming ──────────────────────────────────────────────────
  // When set, this item is pinned to a specific wall-clock air time. The
  // broadcast scheduler enforces this slot; items between two anchored rows
  // have their projected times computed from the previous anchor + cumulative
  // durations. Null means "floating" — play when the natural queue rotation
  // reaches this item.
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  // Human-readable block label shown in the schedule editor, e.g.
  // "Sunday Morning Service", "Wednesday Bible Study", "Daily Devotional".
  scheduleLabel: text("schedule_label"),
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
  // duplicate queue rows that air back-to-back.
  //
  // Partial unique index on (video_id) WHERE video_id IS NOT NULL AND is_active = true:
  //   • The `is_active = true` predicate is critical: without it, deactivating a
  //     video and re-adding it to the queue would fail with a unique violation
  //     because the old inactive row still holds the unique slot.
  //   • The `video_id IS NOT NULL` predicate preserves existing rows with NULL
  //     video_id (legacy prod-sync items that use youtube_id as the dedupe key).
  //   • The second insert raises a unique-violation that enqueueIfMissing's
  //     try/catch already swallows, so the race is handled without extra locking.
  uniqueIndex("uq_broadcast_queue_video_id_active")
    .on(table.videoId)
    .where(sql`${table.videoId} IS NOT NULL AND ${table.isActive} = true`),
  // Sort order must be non-negative. The default is 0 (first position); the
  // orchestrator loads items ORDER BY sort_order ASC, so negative values would
  // place items before the natural first position, which is semantically invalid
  // and an easy source of off-by-one bugs in admin tooling.
  check("chk_broadcast_queue_sort_order_nonneg", sql`${table.sortOrder} >= 0`),
]);

export type BroadcastQueueItem = typeof broadcastQueueTable.$inferSelect;
