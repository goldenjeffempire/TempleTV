import { pgTable, text, timestamp, boolean, integer, bigint, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod/v4";

export const videosTable = pgTable("managed_videos", {
  id: text("id").primaryKey(),
  youtubeId: text("youtube_id").unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  thumbnailUrl: text("thumbnail_url").notNull().default(""),
  duration: text("duration").notNull().default(""),
  category: text("category").notNull().default("sermon"),
  preacher: text("preacher").notNull().default(""),
  publishedAt: text("published_at"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  viewCount: integer("view_count").notNull().default(0),
  featured: boolean("featured").notNull().default(false),
  videoSource: text("video_source").notNull().default("youtube"),
  localVideoUrl: text("local_video_url"),
  hlsMasterUrl: text("hls_master_url"),
  transcodingStatus: text("transcoding_status").notNull().default("none"),
  // ── Upload metadata (Postgres = source of truth, bucket = bytes) ─────────
  originalFilename: text("original_filename"),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  checksumSha256: text("checksum_sha256"),
  objectPath: text("object_path"),
  uploadedBy: text("uploaded_by"),
  s3MirroredAt: timestamp("s3_mirrored_at", { withTimezone: true }),
  // ── Post-transcode source cleanup tracking ────────────────────────────────
  // After HLS transcoding succeeds the original raw source blob (objectPath)
  // is eligible for deletion. A configurable retention window (default 1 h)
  // prevents premature deletion in case the HLS validation is wrong.
  //
  // Values for sourceCleanupStatus:
  //   'none'      — not applicable (YouTube video, no objectPath, or not yet transcoded)
  //   'scheduled' — cleanup scheduled; waiting for retention window to expire
  //   'deleted'   — source blob successfully deleted from storage_blobs
  //   'failed'    — cleanup attempted ≥1 time but the deletion failed (retryable)
  //   'skipped'   — source was never in storage or was already cleaned up externally
  sourceCleanupStatus: text("source_cleanup_status").notNull().default("none"),
  // UTC timestamp after which the source blob is eligible for deletion.
  // Set to NOW() + CLEANUP_RETENTION_HOURS when cleanup is scheduled.
  sourceCleanupAfter: timestamp("source_cleanup_after", { withTimezone: true }),
  // UTC timestamp when the source blob was successfully deleted.
  sourceDeletedAt: timestamp("source_deleted_at", { withTimezone: true }),
  // Number of failed cleanup attempts (for exponential backoff).
  sourceCleanupAttempts: integer("source_cleanup_attempts").notNull().default(0),
  // When true, YouTube sync will never overwrite category or preacher with
  // auto-detected values. Set by the admin when they have manually curated
  // the metadata for a video. Defaults to false so fresh sync works normally.
  metadataLocked: boolean("metadata_locked").notNull().default(false),
  // Set to true by faststart.service.ts once `ffmpeg -movflags +faststart`
  // has successfully relocated the moov atom to byte 0 and re-uploaded the
  // file. This flag is written regardless of skipStatusUpdate so the
  // broadcast-v2 queue can distinguish two otherwise-identical 'failed'
  // scenarios:
  //   • transcodingStatus='failed' AND faststart_applied=true  →
  //       HLS transcoder failed AFTER faststart succeeded → localVideoUrl
  //       IS seekable → safe to broadcast.
  //   • transcodingStatus='failed' AND faststart_applied=false →
  //       faststart itself failed → raw upload, moov at EOF → NOT seekable
  //       → must NOT enter the live broadcast rotation.
  faststartApplied: boolean("faststart_applied").notNull().default(false),
  // When true, this video was uploaded for internal broadcast use only and
  // will NOT appear in the public library (TV, mobile, web catalogue).
  // Set automatically to true for all new uploads. Admin can set to false
  // to publish the video to the public library.
  broadcastOnly: boolean("broadcast_only").notNull().default(false),
}, (table) => [
  index("idx_managed_videos_imported_at").on(table.importedAt),
  index("idx_managed_videos_category").on(table.category),
  index("idx_managed_videos_video_source").on(table.videoSource),
  index("idx_managed_videos_transcoding_status").on(table.transcodingStatus),
  index("idx_managed_videos_title").on(table.title),
  index("idx_managed_videos_preacher").on(table.preacher),
  index("idx_managed_videos_featured").on(table.featured),
  index("idx_managed_videos_view_count").on(table.viewCount),
  index("idx_managed_videos_s3_mirrored_at").on(table.s3MirroredAt),
  // Partial index for the cleanup sweep — only rows that need processing.
  index("idx_managed_videos_source_cleanup_status").on(table.sourceCleanupStatus),
  // ── Performance indexes added May 2026 ──────────────────────────────────
  // hls_master_url: IS NULL filter in bulk-transcode + broadcast queue join.
  // IS NULL/IS NOT NULL predicate filters hit this directly.
  index("idx_managed_videos_hls_master_url").on(table.hlsMasterUrl),
  // local_video_url: broadcast v2 join fallback resolver reads this column.
  index("idx_managed_videos_local_video_url").on(table.localVideoUrl),
  // published_at: admin listing ORDER BY published_at DESC sort path.
  index("idx_managed_videos_published_at").on(table.publishedAt),
  // (video_source, transcoding_status): composite serves the bulk-transcode
  // WHERE video_source='local' AND hls_master_url IS NULL query with a
  // tighter scan than two individual indexes.
  index("idx_managed_videos_source_transcoding").on(table.videoSource, table.transcodingStatus),
  // faststart_applied: broadcast-v2 loadActive() filters on this boolean on
  // every orchestrator reload (10-30 s cadence). Without an index the query
  // full-scans managed_videos via the JOIN; with it Postgres can use a bitmap
  // index scan to narrow rows before evaluating the heavier OR conditions.
  index("idx_managed_videos_faststart_applied").on(table.faststartApplied),
  // Composite broadcast-admission index: mirrors the primary admission predicate
  // in loadActive() — (video_source, transcoding_status, faststart_applied).
  // faststart_applied is still used for the 'failed' state guard
  // (faststartApplied=true required to broadcast a failed-transcode file).
  // All other states (none/queued/encoding/ready/hls_ready) are admitted by
  // transcoding_status alone — see idx_managed_videos_source_transcoding above.
  index("idx_managed_videos_broadcast_admission").on(table.videoSource, table.transcodingStatus, table.faststartApplied),
  // NOTE: The GIN full-text search index (idx_managed_videos_fts) is created via
  // raw SQL at API startup in infrastructure/db.ts using CREATE INDEX IF NOT EXISTS.
  // Drizzle Kit does not support expression GIN indexes in the schema DSL,
  // so we manage this index outside the push pipeline.
]);

export const insertVideoSchema = createInsertSchema(videosTable).omit({ importedAt: true });
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type ManagedVideo = typeof videosTable.$inferSelect;
