/**
 * Resumable chunked upload gateway (server-relay path).
 *
 * All video data flows through the server — no browser-direct or presigned
 * URL uploads. Every chunk is stored as a BYTEA row in the PostgreSQL
 * `storage_upload_parts` table. PostgreSQL is the sole storage backend.
 *
 * Wire:
 *   POST /admin/videos/upload/init
 *     → create DB session row; allocate upload slot
 *   POST /admin/videos/upload/:sessionId/chunk
 *     → receive raw binary chunk (application/octet-stream), verify SHA-256,
 *       store part as BYTEA in storage_upload_parts
 *   GET  /admin/videos/upload/:sessionId/status
 *     → return { uploadedChunkIndices } so the client can resume mid-flight
 *   POST /admin/videos/upload/:sessionId/thumbnail
 *     → accept optional custom thumbnail; store in storage_blobs
 *   POST /admin/videos/upload/:sessionId/finalize
 *     → completeMultipartUpload promotes all parts into row-per-chunk
 *       permanent storage (storage_blob_chunks) in one DB
 *       transaction, inserts managed_videos row, and enqueues for broadcast
 */
import type { FastifyInstance } from "fastify";
export declare function chunkedUploadRoutes(app: FastifyInstance): Promise<void>;
