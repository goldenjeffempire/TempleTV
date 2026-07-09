import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";

/**
 * Custom bytea column type for Drizzle ORM (node-postgres driver).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
});

/**
 * Permanent chunked object storage — removes PostgreSQL's per-value
 * varlena/TOAST ceiling (~1 GiB) from the media pipeline.
 *
 * A large object (any multipart-assembled source video, regardless of size)
 * is stored as N rows here instead of one giant BYTEA value in
 * storage_blobs.data. Each row holds one chunk (typically the same bytes the
 * client uploaded as one part, ≤16 MiB) — no single column value ever
 * approaches the TOAST limit, so files of any size (multi-GB, multi-hundred-GB)
 * assemble and read successfully.
 *
 * Promotion from staging: completeMultipartUpload() in storage.ts promotes
 * storage_upload_parts rows into storage_blob_chunks via a server-side
 * INSERT ... SELECT (row-wise copy — Node.js never receives the bytes).
 * The corresponding storage_blobs row is written with chunked=true,
 * chunk_count=N, and data=NULL; size_bytes is the authoritative total size.
 *
 * Reads: getObject()/getObjectRange() in storage.ts stream chunk_index in
 * ascending order, fetching one row's `data` at a time — O(chunk size)
 * peak Node.js memory regardless of total object size.
 *
 * Deletes: deleteObject()/deleteByPrefix() must also delete matching
 * storage_blob_chunks rows so a removed video never leaves orphaned chunks.
 */
export const storageBlobChunksTable = pgTable(
  "storage_blob_chunks",
  {
    blobKey: text("blob_key").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    /** Raw chunk bytes as BYTEA. Always non-empty. */
    data: bytea("data").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blobKey, t.chunkIndex] }),
    index("idx_storage_blob_chunks_blob_key").on(t.blobKey),
  ],
);

export type StorageBlobChunk = typeof storageBlobChunksTable.$inferSelect;
