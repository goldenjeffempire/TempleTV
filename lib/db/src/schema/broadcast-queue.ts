import { pgTable, text, timestamp, integer, boolean, index, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { videosTable } from "./videos";

export const broadcastQueueTable = pgTable("broadcast_queue", {
  id: text("id").primaryKey(),
  // onDelete:"cascade" — when a managed_videos row is hard-deleted, its queue
  // rows must go with it. A previous `set null` nulled video_id on delete,
  // which (a) defeated the delete route's WHERE video_id=:id cleanup and
  // (b) produced orphaned *active* rows with a stale local_video_url that no
  // integrity check catches (MISSING_VIDEO_JOIN requires video_id NOT NULL,
  // NO_PLAYABLE_URL passes because local_video_url is still set) — so the
  // orchestrator kept trying to air a deleted, blob-less video. Cascade makes
  // orphaning structurally impossible, including under a concurrent
  // enqueue-vs-delete race. NULL video_id (legacy prod-sync rows keyed by
  // youtube_id) is unaffected: cascade only fires on an actual parent delete.
  videoId: text("video_id").references(() => videosTable.id, { onDelete: "cascade" }),
  youtubeId: text("youtube_id").notNull().default(""),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  durationSecs: integer("duration_secs").notNull().default(1800),
  localVideoUrl: text("local_video_url"),
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
  /**
   * Set by the queue-integrity-validator when it auto-deactivates a row.
   * Values: "missing_video_join" (video row was hard-deleted).
   * Cleared (set to null) when the reverse auto-fix re-activates the row.
   * NULL for rows deactivated by operators or by other code paths — this
   * ensures the reverse pass never touches intentionally-disabled content.
   */
  validatorDeactivatedReason: text("validator_deactivated_reason"),
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
