import {
  pgTable,
  text,
  bigint,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * MinIO object storage metadata index.
 *
 * Tracks every object stored in MinIO (the self-hosted S3-compatible backend).
 * The binary data lives in MinIO; this table is a lightweight metadata index
 * that allows batch SQL presence checks and prefix scans without issuing
 * per-key MinIO HeadObject calls during large sweeps.
 *
 * Storage key conventions (same as before — no path logic changes needed):
 *   uploads/{yyyy}/{mm}/{dd}/{sessionId}.{ext}   — assembled source video
 *   transcoded/{videoId}/master.m3u8             — HLS master playlist
 *   transcoded/{videoId}/v0/playlist.m3u8        — rendition playlist
 *   transcoded/{videoId}/v0/seg_00001.ts         — MPEG-TS segment
 *   transcoded/{videoId}/thumbnail.jpg           — auto-generated thumbnail
 *   thumbnails/{sessionId}.{ext}                 — custom uploaded thumbnail
 *
 * Rows are written by S3ObjectStorage.putObject / completeMultipartUpload
 * and deleted by S3ObjectStorage.deleteObject / deleteByPrefix.  All writes
 * are fire-and-forget (non-fatal) so a transient DB error never blocks
 * the actual MinIO operation.
 *
 * Indexes:
 *   - Primary key on `key` for O(1) exact-match lookups.
 *   - btree index for efficient prefix scans (used by deleteByPrefix and
 *     bulk-delete operations on `transcoded/{videoId}/*`).
 */
export const storageBlobsTable = pgTable(
  "storage_blobs",
  {
    key: text("key").primaryKey(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    /**
     * Set to true by faststart.service.ts just before it starts the multipart
     * re-upload that atomically replaces the raw upload blob with the
     * moov-at-byte-0 version. Cleared in a `finally` block once the swap
     * completes (or fails).
     *
     * With MinIO native multipart, the swap is atomic — the old blob remains
     * fully readable until completeMultipartUpload succeeds — so this flag is
     * informational only (no correctness impact).  It is retained for operator
     * visibility and monitoring tooling compatibility.
     */
    faststartLocked: boolean("faststart_locked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_storage_blobs_key_prefix").on(t.key),
    index("idx_storage_blobs_created_at").on(t.createdAt),
  ],
);

export type StorageBlob = typeof storageBlobsTable.$inferSelect;
