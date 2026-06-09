import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Persistent upload session — survives API-server restarts.
 * One row per chunked-upload session initiated by the admin VideoUploadModal.
 *
 * storageBackend:
 *   's3'         — chunks are being (or were) uploaded as S3 multipart parts
 *   'db_fallback'— S3 was unreachable at session-init time; chunks are stored
 *                  as BYTEA in upload_chunks.fallback_data and will be pushed
 *                  to S3 during finalization when S3 becomes available again.
 */
export const uploadSessionsTable = pgTable(
  "upload_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    uploadId: text("upload_id"),           // S3 multipart UploadId (null in db_fallback mode)
    objectKey: text("object_key"),         // S3 object key (null in db_fallback until finalize)
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("sermon"),
    preacher: text("preacher").notNull().default(""),
    featured: boolean("featured").notNull().default(false),
    contentType: text("content_type").notNull().default("video/mp4"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    totalChunks: integer("total_chunks").notNull(),
    chunkSize: integer("chunk_size").notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    durationSecs: integer("duration_secs"),
    uploadedBy: text("uploaded_by"),
    storageBackend: text("storage_backend").notNull().default("s3"),
    status: text("status").notNull().default("uploading"),
    completedVideoId: text("completed_video_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // $onUpdateFn ensures the column is refreshed on every Drizzle-driven UPDATE,
    // not just on INSERT (defaultNow() only fires at INSERT time).
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("idx_upload_sessions_status").on(t.status),
    index("idx_upload_sessions_created_at").on(t.createdAt),
  ],
);

/**
 * Per-chunk tracking record.
 *
 * storageBackend === 's3':         s3Etag is set, fallbackData is null
 * storageBackend === 'db_fallback': fallbackData holds the raw chunk bytes as BYTEA,
 *                                   s3Etag is null
 *
 * The BYTEA column is nullable so S3 sessions don't incur the storage overhead.
 * During rescue finalization the server streams fallbackData rows to S3 chunk-by-chunk
 * (combining them into ≥5 MiB parts to satisfy S3's multipart minimum-part-size rule).
 */
export const uploadChunksTable = pgTable(
  "upload_chunks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    checksum: text("checksum").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    s3Etag: text("s3_etag"),
    fallbackData: bytea("fallback_data"),
    storageBackend: text("storage_backend").notNull().default("s3"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_upload_chunks_session_id").on(t.sessionId),
    // Unique constraint prevents a TOCTOU race where two concurrent chunk
    // requests for the same (sessionId, chunkIndex) both pass the application-
    // level idempotency check and insert duplicate rows. Duplicate chunk rows
    // corrupt the assembly step: finalizeFromDbFallback expects exactly one
    // BYTEA row per index; completeMultipartUpload produces a double-sized blob.
    uniqueIndex("idx_upload_chunks_session_chunk").on(t.sessionId, t.chunkIndex),
  ],
);

export type UploadSession = typeof uploadSessionsTable.$inferSelect;
export type UploadChunk = typeof uploadChunksTable.$inferSelect;
