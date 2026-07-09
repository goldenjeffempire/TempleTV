import {
  pgTable,
  text,
  bigint,
  boolean,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";

/**
 * Custom bytea column type for Drizzle ORM (node-postgres driver).
 * The pg driver automatically decodes BYTEA values to Node.js Buffer objects.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
});

/**
 * PostgreSQL BYTEA object storage index.
 *
 * Stores every blob (source videos, HLS segments, playlists, thumbnails,
 * and custom thumbnails) as BYTEA in the `data` column.
 * This is the sole storage backend — no MinIO/S3 required.
 *
 * Storage key conventions:
 *   uploads/{yyyy}/{mm}/{dd}/{sessionId}.{ext}   — assembled source video
 *   transcoded/{videoId}/master.m3u8             — HLS master playlist
 *   transcoded/{videoId}/v0/playlist.m3u8        — rendition playlist
 *   transcoded/{videoId}/v0/seg_00001.ts         — MPEG-TS segment
 *   transcoded/{videoId}/thumbnail.jpg           — auto-generated thumbnail
 *   thumbnails/{sessionId}.{ext}                 — custom uploaded thumbnail
 *
 * Indexes:
 *   - Primary key on `key` for O(1) exact-match lookups.
 *   - btree index for efficient prefix scans (used by deleteByPrefix and
 *     bulk-delete operations on `transcoded/{videoId}/`).
 *
 * Memory note:
 *   The pg driver decodes BYTEA via hex representation internally before
 *   converting to Buffer. An 8 MiB HLS segment uses ~16 MiB RSS during the
 *   fetch + decode cycle. Budget accordingly for HLS_MAX_CONCURRENT.
 */
export const storageBlobsTable = pgTable(
  "storage_blobs",
  {
    key: text("key").primaryKey(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    /**
     * Binary blob data stored as PostgreSQL BYTEA.
     * NULL only for legacy rows inserted before the DB-BYTEA migration.
     * All new rows written by PostgresObjectStorage will have data set.
     */
    data: bytea("data"),
    /**
     * True when this blob's bytes live in storage_blob_chunks (row-per-chunk)
     * instead of the `data` column. Chunked storage removes the PostgreSQL
     * varlena/TOAST single-value ceiling (~1 GiB) that a bytea_agg-assembled
     * `data` column would hit — chunk rows stay small (one part per row,
     * typically ≤16 MiB) no matter how large the overall object is.
     * Small objects (HLS segments, thumbnails) still use `data` directly.
     */
    chunked: boolean("chunked").notNull().default(false),
    /** Number of rows in storage_blob_chunks for this key. NULL/0 when not chunked. */
    chunkCount: bigint("chunk_count", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_storage_blobs_key_prefix").on(t.key),
    index("idx_storage_blobs_created_at").on(t.createdAt),
  ],
);

export type StorageBlob = typeof storageBlobsTable.$inferSelect;
