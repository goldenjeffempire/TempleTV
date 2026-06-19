import { pgTable, text, timestamp, boolean, integer, bigint, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  viewCount: integer("view_count").notNull().default(0),
  featured: boolean("featured").notNull().default(false),
  videoSource: text("video_source").notNull().default("youtube"),
  localVideoUrl: text("local_video_url"),
  hlsMasterUrl: text("hls_master_url"),
  transcodingStatus: text("transcoding_status").notNull().default("none"),
  // Human-readable reason for the most recent failure (truncated to 2000 chars).
  // Set when transcodingStatus transitions to 'failed' — cleared on re-transcode.
  // Shown in the admin video library so operators know whether to re-upload or
  // just retry (e.g. "moov atom missing — re-upload required" vs. "disk full").
  transcodingErrorMessage: text("transcoding_error_message"),
  // Machine-readable error code for the most recent terminal transcoding failure.
  // Allows downstream logic to branch on failure type without regex-matching
  // the human-readable error message.
  //   'CORRUPT_SOURCE' — moov atom absent or unrecoverable; re-upload required.
  //   'DISK_FULL'      — ENOSPC/EDQUOT at encode time; free space and retry.
  //   null             — not failed, failure has no specific code, or cleared on re-transcode.
  transcodingErrorCode: text("transcoding_error_code"),
  // Subtype of transcodingErrorCode that narrows the exact container failure kind.
  // Only populated when transcodingErrorCode is 'CORRUPT_SOURCE'.
  //   'structure_invalid' — moov not confirmed absent; stream-copy remux repair
  //                         can be attempted via the retry-repair route.
  //   'moov_absent'       — mdat present but moov permanently lost (interrupted
  //                         recording); re-upload required, no repair possible.
  //   'preflight_failed'  — file failed early container validity gate.
  //   null                — not set (assembly failure, size mismatch, or old
  //                         item created before this column existed).
  transcodingErrorKind: text("transcoding_error_kind"),
  // Number of times the transcoding-auto-retry worker has automatically
  // re-enqueued this video after a non-terminal failure. Capped at
  // TRANSCODING_AUTO_RETRY_MAX (default 3) to prevent infinite retry loops.
  // Reset to 0 when the operator manually triggers a retry.
  // null = never auto-retried (column added June 2026).
  autoRetryCount: integer("auto_retry_count").default(0),
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
  // Number of times the faststart job has been attempted for this video.
  // Written by faststart.service.ts on each attempt. Used by the orchestrator
  // to rate-limit automatic re-queuing of faststart jobs for repeatedly-failing
  // sources (e.g. corrupt containers that pass the validity gate but always
  // fail the moov-relocation step). Resets to 0 on a new upload (new objectPath).
  faststartAttempts: integer("faststart_attempts").notNull().default(0),
  // When true, this video was uploaded for internal broadcast use only and
  // will NOT appear in the public library (TV, mobile, web catalogue).
  // Set automatically to true for all new uploads. Admin can set to false
  // to publish the video to the public library.
  broadcastOnly: boolean("broadcast_only").notNull().default(false),
  // ── YouTube Live Status ───────────────────────────────────────────────────
  // Tracks whether a YouTube-sourced Live Service video is currently airing
  // live on YouTube or has ended and is in rebroadcast state.
  //   'live'         — actively streaming on YouTube right now.
  //   'rebroadcast'  — stream has ended; video is a VOD/replay.
  //   null           — not applicable (non-YouTube video, or never went live).
  // Written by live-status.service.ts which subscribes to ytPoller events.
  // A background sweep every 2 min heals stale 'live' rows whose stream has ended.
  youtubeLiveStatus: text("youtube_live_status"),
  // UTC timestamp when youtube_live_status was last updated.
  // Enables the background sweep to detect stale 'live' rows and heal them.
  youtubeLiveStatusUpdatedAt: timestamp("youtube_live_status_updated_at", { withTimezone: true }),
  // ── Media technical metadata (populated by ffprobe after upload assembly) ──
  // Extracted in a single ffprobe pass right after the upload blob is confirmed
  // assembled in storage. Available immediately — no transcoding required.
  // codec names follow ffprobe codec_name convention (e.g. "h264", "hevc", "aac", "opus").
  videoCodec: text("video_codec"),
  audioCodec: text("audio_codec"),
  // Bitrate in kilobits per second (kbps) from format.bit_rate.
  videoBitrate: integer("video_bitrate"),
  // Frame dimensions in pixels from the first video stream.
  videoWidth: integer("video_width"),
  videoHeight: integer("video_height"),
  // When true the operator has explicitly uploaded a custom thumbnail for this
  // video via POST /upload/:sessionId/thumbnail. Prevents auto-generated poster
  // frames (generateQuickThumbnail, scheduleEarlyThumbnail) from overwriting
  // the custom image on subsequent re-processing or assembly retries.
  hasCustomThumbnail: boolean("has_custom_thumbnail").notNull().default(false),
  // ── Content scheduling ────────────────────────────────────────────────────
  // When set, a background worker will auto-publish this video (set
  // broadcastOnly=false) at or after this UTC timestamp.
  // null = no scheduled publish.
  scheduledPublishAt: timestamp("scheduled_publish_at", { withTimezone: true }),
  // When set, a background worker will auto-unpublish this video (set
  // broadcastOnly=true) at or after this UTC timestamp.
  // null = no scheduled unpublish.
  scheduledUnpublishAt: timestamp("scheduled_unpublish_at", { withTimezone: true }),
  // ── Video chapter markers ─────────────────────────────────────────────────
  // JSON array of { startSecs: number, title: string } objects, sorted ascending
  // by startSecs. Used by the player to render a chapter timeline.
  // null = no chapters defined.
  chapters: jsonb("chapters"),
  // ── Video tags ────────────────────────────────────────────────────────────
  // Free-form string labels attached by admins (e.g. "easter", "youth", "series-3").
  // Used for filtering in the admin library. Stored as a Postgres text[] array.
  // null = no tags.
  tags: text("tags").array(),
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
  // youtube_live_status: live-status.service.ts runs a background sweep every
  // 2 minutes to heal stale 'live' rows (WHERE youtube_live_status = 'live').
  // Without this index every sweep is a full table scan — critical at scale.
  index("idx_managed_videos_youtube_live_status").on(table.youtubeLiveStatus),
  // metadata_locked: YouTube sync filters on this boolean to decide whether to
  // preserve existing category/preacher. Without an index every sync pass scans
  // the full table before the transcoding_status filter is applied.
  index("idx_managed_videos_metadata_locked").on(table.metadataLocked),
  // Composite broadcast-admission index: mirrors the primary admission predicate
  // in loadActive() — (video_source, transcoding_status, faststart_applied).
  // faststart_applied is still used for the 'failed' state guard
  // (faststartApplied=true required to broadcast a failed-transcode file).
  // All other states (none/queued/encoding/ready/hls_ready) are admitted by
  // transcoding_status alone — see idx_managed_videos_source_transcoding above.
  index("idx_managed_videos_broadcast_admission").on(table.videoSource, table.transcodingStatus, table.faststartApplied),
  // uploaded_by: admin "filter by uploader" queries and audit trail lookups.
  // Also enables JOIN/WHERE patterns for upload attribution without a full table scan.
  index("idx_managed_videos_uploaded_by").on(table.uploadedBy),
  // Enforce the closed enum at the database level. Any code path that writes
  // an unrecognised status (typo, bad migration, rogue SQL) will get a
  // CHECK violation rather than silently corrupting the state machine.
  check(
    "managed_videos_transcoding_status_check",
    sql`${table.transcodingStatus} IN ('none','queued','encoding','processing','ready','hls_ready','failed')`,
  ),
  // Prevent duplicate video rows when the same file is uploaded multiple times.
  // A partial unique index (WHERE object_path IS NOT NULL) lets YouTube-synced
  // rows (where object_path is NULL) co-exist without a constraint violation.
  // If Drizzle Kit cannot apply this as a partial index it falls back to a
  // plain unique index; the startup guard in infrastructure/db.ts also ensures
  // this index exists regardless of what drizzle-kit push manages to apply.
  uniqueIndex("uq_managed_videos_object_path")
    .on(table.objectPath)
    .where(sql`"object_path" IS NOT NULL`),
  // NOTE: The GIN full-text search index (idx_managed_videos_fts) is created via
  // raw SQL at API startup in infrastructure/db.ts using CREATE INDEX IF NOT EXISTS.
  // Drizzle Kit does not support expression GIN indexes in the schema DSL,
  // so we manage this index outside the push pipeline.
]);

export const insertVideoSchema = createInsertSchema(videosTable).omit({ importedAt: true });
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type ManagedVideo = typeof videosTable.$inferSelect;
