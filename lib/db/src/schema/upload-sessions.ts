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
 *   'db'         — chunks are stored as multipart parts in storage_blobs (normal path).
 *                  This is the default; the init route always writes "db" explicitly.
 *   'db_fallback'— createMultipartUpload failed; chunks are stored as raw BYTEA rows
 *                  in upload_chunks.fallback_data and assembled directly at finalize.
 */
export const uploadSessionsTable = pgTable(
  "upload_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    uploadId: text("upload_id"),           // DB multipart UploadId (null in db_fallback mode)
    objectKey: text("object_key"),         // DB storage key (null in db_fallback until finalize)
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("sermon"),
    preacher: text("preacher").notNull().default(""),
    featured: boolean("featured").notNull().default(false),
    broadcastOnly: boolean("broadcast_only").notNull().default(true),
    contentType: text("content_type").notNull().default("video/mp4"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    totalChunks: integer("total_chunks").notNull(),
    chunkSize: integer("chunk_size").notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type"),
    durationSecs: integer("duration_secs"),
    uploadedBy: text("uploaded_by"),
    storageBackend: text("storage_backend").notNull().default("db"),
    status: text("status").notNull().default("uploading"),
    completedVideoId: text("completed_video_id"),
    /**
     * How many automatic re-assembly attempts have been made for this session.
     * Starts at 0 (never attempted). Incremented at the START of each
     * spawnAssemblyRetry call so the count reflects attempts in progress.
     * When this reaches MAX_AUTO_ASSEMBLY_ATTEMPTS the session is permanently
     * marked ASSEMBLY_FAILED and no further auto-retries are scheduled.
     */
    assemblyAttempts: integer("assembly_attempts").notNull().default(0),
    /**
     * Error message from the last failed auto-assembly attempt.
     * Used for diagnostics and surfaced in admin panel "Re-upload required" badge.
     */
    lastAssemblyError: text("last_assembly_error"),
    /**
     * Persisted assemblyUploadId for db_fallback re-assembly.
     * Written immediately after createMultipartUpload() succeeds inside
     * finalizeFromDbFallback so that if the server crashes mid-assembly the
     * onReady hook can abort the orphaned _parts/{assemblyUploadId}/... rows
     * before starting a fresh attempt.  Cleared after successful assembly.
     */
    assemblyUploadId: text("assembly_upload_id"),
    /**
     * Optional client-declared SHA-256 hash of the complete file (64-char hex).
     * When present, the finalize background task computes the SHA-256 of the
     * assembled blob via PostgreSQL sha256() and rejects any mismatch as
     * CORRUPT_SOURCE — providing a cryptographic end-to-end integrity guarantee
     * beyond the per-chunk SHA-256 + assembled-size checks.
     */
    expectedFileSha256: text("expected_file_sha256"),
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
 * storageBackend === 'db':          s3Etag holds the part ETag from storage().uploadPart();
 *                                   fallbackData is null (part data lives in storage_blobs).
 * storageBackend === 'db_fallback': fallbackData holds the raw chunk bytes as BYTEA;
 *                                   s3Etag is null.
 *
 * The BYTEA column is nullable so normal-path (db) sessions don't incur storage overhead.
 * During db_fallback finalization the server reads fallbackData rows in order and pipes
 * them through completeMultipartUpload via iterative PostgreSQL UPDATE concatenation.
 */
export const uploadChunksTable = pgTable(
  "upload_chunks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    checksum: text("checksum").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /**
     * Byte offset of this chunk within the complete file (0-based).
     * Populated from the X-Byte-Offset request header.
     * Null for sessions created before this column was added.
     * At finalize time, if all chunks have byteOffset set, contiguous
     * coverage is validated before assembly begins.
     */
    byteOffset: bigint("byte_offset", { mode: "number" }),
    /**
     * Real MD5 ETag of the chunk bytes — matches S3 ETag semantics.
     * Populated by DatabaseObjectStorage.uploadPart() since the real-ETag fix.
     * Legacy sessions (before the fix) hold the part number as a string (e.g. "1").
     */
    s3Etag: text("s3_etag"),
    fallbackData: bytea("fallback_data"),
    storageBackend: text("storage_backend").notNull().default("db"),
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
