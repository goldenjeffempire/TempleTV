/**
 * Resumable chunked upload gateway (server-relay path).
 *
 * All video data flows through the server — no browser-direct or presigned
 * URL uploads. Every byte is stored in the PostgreSQL `storage_blobs` table
 * via DatabaseObjectStorage. No S3, Replit Object Storage, or any cloud
 * provider is involved.
 *
 * Wire:
 *   POST /admin/videos/upload/init
 *     → create DB session; initialise DatabaseObjectStorage multipart slot
 *   POST /admin/videos/upload/:sessionId/chunk
 *     → receive raw binary chunk (application/octet-stream), verify SHA-256,
 *       store as a multipart part in storage_blobs (db mode) OR as raw BYTEA
 *       in upload_chunks.fallback_data (db_fallback mode)
 *   GET  /admin/videos/upload/:sessionId/status
 *     → return { uploadedChunkIndices } so the client can resume mid-flight
 *   POST /admin/videos/upload/:sessionId/thumbnail
 *     → accept optional custom thumbnail; store in storage_blobs
 *   POST /admin/videos/upload/:sessionId/finalize
 *     → assemble multipart parts (db mode) or BYTEA chunks (db_fallback mode)
 *       into the final storage_blobs row, insert managed_videos row, and
 *       enqueue HLS transcoding
 *
 * DB-fallback rescue layer:
 *   If DatabaseObjectStorage.createMultipartUpload fails at init time the
 *   session falls back to 'db_fallback' mode. Every chunk is stored as BYTEA
 *   in upload_chunks.fallback_data. On finalize the server reassembles them
 *   via a fresh multipart session entirely inside PostgreSQL. No video data
 *   is ever lost.
 */
import type { FastifyInstance } from "fastify";
export declare function chunkedUploadRoutes(app: FastifyInstance): Promise<void>;
