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
 * Staging table for in-progress multipart uploads (PostgreSQL BYTEA backend).
 *
 * Each row holds one uploaded chunk (part) while a multipart assembly
 * is in progress. On completeMultipartUpload(), all parts for an uploadId
 * are fetched in part_number order, concatenated in Node.js, and the
 * assembled blob is written to storage_blobs. The part rows are then
 * deleted.
 *
 * On abortMultipartUpload() or stale-session cleanup, all rows for the
 * uploadId are deleted without writing to storage_blobs.
 *
 * Lifecycle:
 *   uploadPart()             → INSERT (upload_id, part_number, etag, data)
 *   completeMultipartUpload() → SELECT + concat + INSERT storage_blobs + DELETE parts
 *   abortMultipartUpload()   → DELETE parts
 *
 * The (upload_id, part_number) primary key prevents duplicate part uploads.
 */
export const storageUploadPartsTable = pgTable(
  "storage_upload_parts",
  {
    uploadId: text("upload_id").notNull(),
    partNumber: integer("part_number").notNull(),
    /**
     * MD5 hex ETag of this part's bytes (matches S3 ETag semantics).
     * Computed locally by PostgresObjectStorage.uploadPart().
     */
    etag: text("etag").notNull(),
    /**
     * Raw chunk bytes as BYTEA.
     */
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.uploadId, t.partNumber] }),
    index("idx_storage_upload_parts_upload_id").on(t.uploadId),
  ],
);

export type StorageUploadPart = typeof storageUploadPartsTable.$inferSelect;
