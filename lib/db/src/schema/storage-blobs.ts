import {
  pgTable,
  text,
  bigint,
  boolean,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Binary object store — database-backed replacement for external object storage.
 *
 * Every key follows the same naming conventions previously used with
 * Replit Object Storage, so no application-layer path logic changes:
 *
 *   uploads/{yyyy}/{mm}/{dd}/{sessionId}.{ext}   — assembled source video
 *   transcoded/{videoId}/master.m3u8             — HLS master playlist
 *   transcoded/{videoId}/v0/playlist.m3u8        — rendition playlist
 *   transcoded/{videoId}/v0/seg_00001.ts         — MPEG-TS segment
 *   transcoded/{videoId}/thumbnail.jpg           — auto-generated thumbnail
 *   thumbnails/{sessionId}.{ext}                 — custom uploaded thumbnail
 *   _parts/{uploadId}/{partNumber:06d}           — multipart upload temp parts
 *
 * PostgreSQL's TOAST mechanism transparently compresses and pages large values
 * (anything > ~2 KiB) without any application-layer intervention. A single
 * getObject call returns the full Buffer; Readable wrappers are applied by
 * the storage adapter layer (infrastructure/storage.ts).
 *
 * Indexes:
 *   - Primary key on `key` for O(1) exact-match lookups.
 *   - btree index using text_pattern_ops for efficient prefix scans
 *     (used by abortMultipartUpload to delete `_parts/{uploadId}/*`
 *     and by bulk-delete operations on `transcoded/{videoId}/*`).
 */
export const storageBlobsTable = pgTable(
  "storage_blobs",
  {
    key: text("key").primaryKey(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    data: bytea("data").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    /**
     * Set to true by faststart.service.ts just before it starts the multipart
     * re-upload that atomically replaces the raw upload blob with the moov-at-byte-0
     * version. Cleared in a `finally` block once the swap completes (or fails).
     *
     * During the swap window the blob is partially assembled — reading it would
     * produce a corrupt/truncated file. headObject() returns contentLength=0 while
     * this flag is true so the orchestrator, scanner, and any other reader treats
     * the blob as transiently unavailable and skips it rather than serving garbage.
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
