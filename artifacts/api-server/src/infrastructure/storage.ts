import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { env } from "../config/env.js";

/**
 * MinIO (self-hosted S3-compatible) object storage.
 *
 * All video assets — source uploads, HLS segments, playlists, thumbnails —
 * are stored in a local MinIO bucket.  The storage layer is a thin wrapper
 * around the AWS SDK v3, which is fully compatible with MinIO via the
 * `AWS_ENDPOINT_URL` + `forcePathStyle: true` settings.
 *
 * Key design notes:
 *   - No presigned URL uploads — browser-direct uploads are not supported. All
 *     video data flows through the server-relay chunked upload path.
 *   - Multipart maps directly to MinIO's native multipart API (no temp rows
 *     in PostgreSQL for parts).
 *   - publicUrl returns a CDN URL when CDN_BASE_URL is set, otherwise the
 *     API proxy path (/api/v1/uploads/…) so callers always get a valid URL.
 *   - getObject / getObjectRange return AWS SDK body streams (Node.js Readable).
 *   - deleteByPrefix lists + batches DeleteObjects (max 1 000 per call).
 *   - _activeStreamCount tracks open streams for graceful shutdown.
 *
 * Metadata index:
 *   Every completed putObject / completeMultipartUpload call also upserts a
 *   lightweight row into the `storage_blobs` PostgreSQL table (key + metadata,
 *   no binary data).  This index enables batch SQL presence checks in the
 *   storage-reconciliation and orphan-cleanup workers without issuing per-key
 *   MinIO HeadObject calls during large sweeps.  All index writes are
 *   fire-and-forget (non-fatal) so a transient DB hiccup never blocks the
 *   actual MinIO operation.
 *
 * Storage key conventions:
 *   uploads/{yyyy}/{mm}/{dd}/{sessionId}.{ext}  — assembled source video
 *   transcoded/{videoId}/master.m3u8            — HLS master playlist
 *   transcoded/{videoId}/v0/playlist.m3u8       — rendition playlist
 *   transcoded/{videoId}/v0/seg_00001.ts        — MPEG-TS segment
 *   transcoded/{videoId}/thumbnail.jpg          — auto-generated thumbnail
 *   thumbnails/{sessionId}.{ext}                — custom uploaded thumbnail
 */

// ── Active-stream tracking for graceful shutdown ──────────────────────────────
//
// `getObject` and `getObjectRange` increment this counter when they return a
// streaming Readable, and decrement it when that stream emits "close".
//
// The shutdown handler must call `signalStorageShutdown()` BEFORE closing the
// DB pool.  See shutdown sequence in main.ts.
let _activeStreamCount = 0;
let _shuttingDown = false;

/** How many storage read streams are currently open. */
export function getActiveStorageStreamCount(): number { return _activeStreamCount; }

/**
 * Signal the storage layer that the process is shutting down.
 * After this call new stream reads will fail fast instead of blocking.
 */
export function signalStorageShutdown(): void { _shuttingDown = true; }

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface ObjectStorage {
  readonly enabled: boolean;
  readonly bucket: string | null;
  readonly region: string | null;
  putObject(args: { key: string; body: Buffer | Uint8Array; contentType?: string }): Promise<{ key: string; url: string }>;
  getObject(key: string): Promise<{ body: Readable; contentType?: string; contentLength?: number }>;
  signedDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;
  signedUploadUrl(args: { key: string; contentType?: string; ttlSeconds?: number }): Promise<{ url: string; key: string }>;
  deleteObject(key: string): Promise<void>;
  /**
   * Deletes every blob whose key starts with `prefix`.
   * Returns the number of objects deleted.
   * Used to purge an entire HLS tree (`transcoded/{videoId}/`) or thumbnail
   * group in a single round-trip.
   */
  deleteByPrefix(prefix: string): Promise<number>;
  headObject(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }>;
  /**
   * Fetch a byte-range slice of a stored blob.
   * `start` and `end` are 0-indexed, inclusive (matching HTTP Range semantics).
   * Returns null when the key does not exist.
   */
  getObjectRange(key: string, start: number, end: number): Promise<{ body: Readable; contentType?: string; contentLength: number } | null>;
  publicUrl(key: string): string | null;
  createMultipartUpload(args: { key: string; contentType?: string }): Promise<{ uploadId: string }>;
  signUploadPart(args: { key: string; uploadId: string; partNumber: number; ttlSeconds?: number }): Promise<string>;
  uploadPart(args: { key: string; uploadId: string; partNumber: number; body: Buffer }): Promise<{ etag: string }>;
  completeMultipartUpload(args: { key: string; uploadId: string; parts: MultipartPart[] }): Promise<{ key: string; etag: string | null; location: string | null }>;
  abortMultipartUpload(args: { key: string; uploadId: string }): Promise<void>;
}

// ── S3ObjectStorage ───────────────────────────────────────────────────────────
//
// AWS S3-compatible object storage backend (MinIO, AWS S3, Cloudflare R2, …).
//
// Credentials are auto-discovered from the standard AWS environment variables:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
// Set S3_BUCKET (and optionally S3_REGION, AWS_ENDPOINT_URL) in app config.
// For MinIO: set AWS_ENDPOINT_URL=http://localhost:9000 (or remote MinIO URL).
class S3ObjectStorage implements ObjectStorage {
  readonly enabled = true;
  readonly bucket: string;
  readonly region: string | null;
  private readonly client: S3Client;

  constructor(bucket: string, region?: string | null, endpoint?: string) {
    this.bucket = bucket;
    this.region = region ?? process.env.AWS_REGION ?? null;
    this.client = new S3Client({
      ...(this.region ? { region: this.region } : {}),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  // ── Metadata index helpers ───────────────────────────────────────────────────
  // Fire-and-forget DB operations that keep storage_blobs in sync with MinIO.
  // Failures are logged and never propagate to the caller.

  private syncMetadata(key: string, sizeBytes: number, contentType: string): void {
    void db.execute(sql`
      INSERT INTO storage_blobs (key, content_type, size_bytes, updated_at)
      VALUES (${key}, ${contentType}, ${sizeBytes}, NOW())
      ON CONFLICT (key) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        size_bytes   = EXCLUDED.size_bytes,
        updated_at   = NOW()
    `).catch((err) =>
      logger.warn({ err, key }, "[storage] metadata sync failed (non-fatal)"),
    );
  }

  private deleteMetadata(key: string): void {
    void db.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`)
      .catch((err) =>
        logger.warn({ err, key }, "[storage] metadata delete failed (non-fatal)"),
      );
  }

  private deleteMetadataByPrefix(prefix: string): void {
    void db.execute(sql`DELETE FROM storage_blobs WHERE starts_with(key, ${prefix})`)
      .catch((err) =>
        logger.warn({ err, prefix }, "[storage] metadata prefix delete failed (non-fatal)"),
      );
  }

  /** HeadObject after CompleteMultipartUpload to sync final size + content-type. */
  private syncMetadataAfterComplete(key: string): void {
    void this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      .then((head) =>
        this.syncMetadata(key, head.ContentLength ?? 0, head.ContentType ?? "application/octet-stream"),
      )
      .catch((err) =>
        logger.warn({ err, key }, "[storage] post-complete metadata sync failed (non-fatal)"),
      );
  }

  // ── URL helpers ─────────────────────────────────────────────────────────────

  publicUrl(key: string): string {
    const cdnBase = env.CDN_BASE_URL?.replace(/\/$/, "");
    if (cdnBase) {
      return `${cdnBase}/${key}`;
    }
    // Fall back to the API proxy path so callers always receive a valid URL.
    const suffix = key.startsWith("uploads/") ? key.slice("uploads/".length) : key;
    return `/api/v1/uploads/${suffix}`;
  }

  async signedDownloadUrl(key: string, ttlSeconds = 3600): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
  }

  async signedUploadUrl({ key, contentType, ttlSeconds = 3600 }: { key: string; contentType?: string; ttlSeconds?: number }): Promise<{ url: string; key: string }> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType ?? "application/octet-stream",
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
    return { url, key };
  }

  // ── Core CRUD ───────────────────────────────────────────────────────────────

  async putObject({ key, body, contentType }: { key: string; body: Buffer | Uint8Array; contentType?: string }): Promise<{ key: string; url: string }> {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const ct = contentType ?? "application/octet-stream";
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buf,
      ContentType: ct,
      ContentLength: buf.length,
    }));
    this.syncMetadata(key, buf.length, ct);
    return { key, url: this.publicUrl(key) };
  }

  async getObject(key: string): Promise<{ body: Readable; contentType?: string; contentLength?: number }> {
    try {
      const resp = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!resp.Body) {
        throw Object.assign(
          new Error(`Object not found in storage: ${key}`),
          { code: "SOURCE_MISSING", $metadata: { httpStatusCode: 404 } },
        );
      }
      if (_shuttingDown) {
        throw Object.assign(
          new Error("Storage shutting down"),
          { code: "STORAGE_SHUTDOWN" },
        );
      }
      const body = resp.Body as unknown as Readable;
      _activeStreamCount++;
      const dec = () => { _activeStreamCount = Math.max(0, _activeStreamCount - 1); };
      body.once("close", dec);
      body.once("error", dec);
      return { body, contentType: resp.ContentType, contentLength: resp.ContentLength };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
        throw Object.assign(
          new Error(`Object not found in storage: ${key}`),
          { code: "SOURCE_MISSING", $metadata: { httpStatusCode: 404 } },
        );
      }
      throw err;
    }
  }

  async getObjectRange(key: string, start: number, end: number): Promise<{ body: Readable; contentType?: string; contentLength: number } | null> {
    try {
      const resp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
      }));
      if (!resp.Body) return null;
      const body = resp.Body as unknown as Readable;
      _activeStreamCount++;
      const dec = () => { _activeStreamCount = Math.max(0, _activeStreamCount - 1); };
      body.once("close", dec);
      body.once("error", dec);
      const length = end - start + 1;
      return { body, contentType: resp.ContentType, contentLength: length };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async headObject(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
    try {
      const resp = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        exists: true,
        contentLength: resp.ContentLength,
        contentType: resp.ContentType,
      };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
        return { exists: false };
      }
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    this.deleteMetadata(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      const objects = (list.Contents ?? [])
        .filter((o): o is { Key: string } => typeof o.Key === "string")
        .map(o => ({ Key: o.Key }));
      if (objects.length > 0) {
        await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects, Quiet: true },
        }));
        deleted += objects.length;
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);

    // Sync metadata index — remove all rows under this prefix.
    if (deleted > 0) {
      this.deleteMetadataByPrefix(prefix);
    }
    return deleted;
  }

  // ── Multipart upload ────────────────────────────────────────────────────────
  // Maps directly to MinIO/S3's native multipart API.
  // No temp rows are created in PostgreSQL — parts live in MinIO.

  async createMultipartUpload({ key, contentType }: { key: string; contentType?: string }): Promise<{ uploadId: string }> {
    const resp = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType ?? "application/octet-stream",
    }));
    if (!resp.UploadId) throw new Error("MinIO/S3 did not return an UploadId");
    return { uploadId: resp.UploadId };
  }

  async signUploadPart({ key, uploadId, partNumber, ttlSeconds = 3600 }: { key: string; uploadId: string; partNumber: number; ttlSeconds?: number }): Promise<string> {
    const cmd = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
  }

  async uploadPart({ key, uploadId, partNumber, body }: { key: string; uploadId: string; partNumber: number; body: Buffer }): Promise<{ etag: string }> {
    const resp = await this.client.send(new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.length,
    }));
    return { etag: resp.ETag ?? "" };
  }

  async completeMultipartUpload({ key, uploadId, parts }: { key: string; uploadId: string; parts: MultipartPart[] }): Promise<{ key: string; etag: string | null; location: string | null }> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const resp = await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sorted.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }));
    logger.info({ key, uploadId, parts: sorted.length }, "[storage] completeMultipartUpload done");
    // Sync the final object size + content-type to the metadata index.
    // HeadObject is needed because CompleteMultipartUpload does not return
    // ContentLength; this is a single extra round-trip per video assembly.
    this.syncMetadataAfterComplete(key);
    return { key, etag: resp.ETag ?? null, location: resp.Location ?? this.publicUrl(key) };
  }

  async abortMultipartUpload({ key, uploadId }: { key: string; uploadId: string }): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
    }));
  }
}

// ── Disabled storage (S3_BUCKET not configured) ───────────────────────────────
// Returned by storage() when S3_BUCKET is not set. All mutations throw a
// clear configuration error; reads return "not found". Callers that check
// `s.enabled` before operating skip gracefully.
class DisabledObjectStorage implements ObjectStorage {
  readonly enabled = false;
  readonly bucket = null;
  readonly region = null;

  private _err(): never {
    throw Object.assign(
      new Error(
        "Object storage is not configured. Set S3_BUCKET (+ AWS_ENDPOINT_URL for MinIO) " +
        "in environment variables before uploading video assets.",
      ),
      { statusCode: 503, code: "STORAGE_NOT_CONFIGURED" },
    );
  }

  publicUrl(_key: string): null { return null; }
  async signedDownloadUrl(_key: string): Promise<string> { return this._err(); }
  async signedUploadUrl(_args: { key: string }): Promise<{ url: string; key: string }> { return this._err(); }
  async putObject(_args: { key: string; body: Buffer }): Promise<{ key: string; url: string }> { return this._err(); }
  async getObject(_key: string): Promise<{ body: Readable }> { return this._err(); }
  async getObjectRange(_key: string, _s: number, _e: number): Promise<null> { return null; }
  async headObject(_key: string): Promise<{ exists: boolean }> { return { exists: false }; }
  async deleteObject(_key: string): Promise<void> { /* no-op */ }
  async deleteByPrefix(_prefix: string): Promise<number> { return 0; }
  async createMultipartUpload(_args: { key: string }): Promise<{ uploadId: string }> { return this._err(); }
  async signUploadPart(_args: { key: string; uploadId: string; partNumber: number }): Promise<string> { return this._err(); }
  async uploadPart(_args: { key: string; uploadId: string; partNumber: number; body: Buffer }): Promise<{ etag: string }> { return this._err(); }
  async completeMultipartUpload(_args: { key: string; uploadId: string; parts: MultipartPart[] }): Promise<{ key: string; etag: string | null; location: string | null }> { return this._err(); }
  async abortMultipartUpload(_args: { key: string; uploadId: string }): Promise<void> { /* no-op */ }
}

// ── Storage capacity stats ────────────────────────────────────────────────────

export interface StorageStats {
  totalBytes: number;
  totalBlobCount: number;
  lastRefreshedAtMs: number | null;
}

let _storageStats: StorageStats = {
  totalBytes: 0,
  totalBlobCount: 0,
  lastRefreshedAtMs: null,
};

export function getStorageStats(): StorageStats {
  return { ..._storageStats };
}

/**
 * Refresh storage capacity stats from the storage_blobs DB index.
 * Fire-and-forget safe — failures are logged as warn only.
 * Call periodically (e.g. every 5 min) from a supervised background worker.
 */
export async function refreshStorageStats(): Promise<StorageStats> {
  try {
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute<{ total_bytes: string; blob_count: string }>(sql`
      SELECT
        COALESCE(SUM(size_bytes), 0)::text AS total_bytes,
        COUNT(*)::text AS blob_count
      FROM storage_blobs
    `);
    const row = rows.rows?.[0] ?? rows[0];
    const totalBytes = parseInt(String(row?.total_bytes ?? "0"), 10);
    const totalBlobCount = parseInt(String(row?.blob_count ?? "0"), 10);
    _storageStats = { totalBytes, totalBlobCount, lastRefreshedAtMs: Date.now() };
    return _storageStats;
  } catch (err) {
    const { logger } = await import("./logger.js");
    logger.warn({ err }, "[storage-stats] refresh failed (non-fatal)");
    return _storageStats;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _storage: ObjectStorage | null = null;

export function storage(): ObjectStorage {
  if (_storage) return _storage;
  const bucket = env.S3_BUCKET;
  if (bucket) {
    _storage = new S3ObjectStorage(
      bucket,
      env.S3_REGION ?? process.env.AWS_REGION,
      env.AWS_ENDPOINT_URL,
    );
    logger.info(
      {
        bucket,
        region: env.S3_REGION ?? process.env.AWS_REGION ?? "sdk-auto-discovery",
        endpoint: env.AWS_ENDPOINT_URL ?? "aws-default",
      },
      "[storage] MinIO/S3 object storage ready",
    );
    return _storage;
  }
  _storage = new DisabledObjectStorage();
  logger.warn(
    "[storage] S3_BUCKET is not configured — object storage disabled. " +
    "Set S3_BUCKET + AWS_ENDPOINT_URL to enable MinIO.",
  );
  return _storage;
}
