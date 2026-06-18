import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { env } from "../config/env.js";

/**
 * PostgreSQL BYTEA object storage.
 *
 * All video assets (source uploads, HLS segments, playlists, thumbnails) are
 * stored as BYTEA in the storage_blobs PostgreSQL table.  In-progress
 * multipart uploads are staged in storage_upload_parts and concatenated on
 * completion.  No MinIO/S3 dependency required.
 *
 * Memory notes:
 *   - The pg driver decodes BYTEA via hex: an 8 MiB HLS segment uses ~16 MiB
 *     RSS during fetch + decode.  Budget ~12 MiB per concurrent HLS request.
 *   - completeMultipartUpload() loads all parts into Node.js memory for
 *     concat: a 500 MB video (63 × 8 MiB parts) uses ~1 GB RSS during
 *     assembly.  ASSEMBLY_WATCHDOG_MS gates abnormally long assemblies.
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
// getObject and getObjectRange increment this counter when they return a
// streaming Readable, and decrement it when that stream emits "close".
//
// The shutdown handler must call signalStorageShutdown() BEFORE closing the
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize the value pg returns for a BYTEA column.
 *
 * With node-postgres (pg), BYTEA columns are decoded automatically to Buffer.
 * If for any reason the value arrives as a hex string (e.g. a \x-prefixed
 * Postgres text representation), convert it manually so callers always receive
 * a real Buffer.
 */
function toBuffer(val: unknown): Buffer {
  if (Buffer.isBuffer(val)) return val;
  if (typeof val === "string") {
    const s = val.startsWith("\\x") ? val.slice(2) : val;
    return Buffer.from(s, "hex");
  }
  if (val instanceof Uint8Array) return Buffer.from(val);
  throw new Error(`[storage] unexpected BYTEA value type: ${typeof val}`);
}

/**
 * Extract the first row from a drizzle db.execute() result.
 * Handles both { rows: T[] } shape (node-postgres) and plain T[] fallback.
 */
function firstRow<T>(result: unknown): T | undefined {
  const r = result as { rows?: T[] };
  if (Array.isArray(r.rows)) return r.rows[0];
  if (Array.isArray(result)) return (result as T[])[0];
  return undefined;
}

/**
 * Extract all rows from a drizzle db.execute() result.
 */
function allRows<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  if (Array.isArray(r.rows)) return r.rows;
  if (Array.isArray(result)) return result as T[];
  return [];
}

// ── PostgresObjectStorage ─────────────────────────────────────────────────────

class PostgresObjectStorage implements ObjectStorage {
  readonly enabled = true;
  readonly bucket = null;
  readonly region = null;

  /**
   * In-memory content-type registry for active multipart uploads.
   * Keyed by uploadId (UUID).  Populated by createMultipartUpload(),
   * consumed by completeMultipartUpload(), removed by abortMultipartUpload().
   * Falls back to "video/mp4" (correct for all video assemblies) on restart.
   */
  private readonly _pendingContentTypes = new Map<string, string>();

  // ── URL helpers ─────────────────────────────────────────────────────────────

  publicUrl(key: string): string {
    const cdnBase = env.CDN_BASE_URL?.replace(/\/$/, "");
    if (cdnBase) return `${cdnBase}/${key}`;
    const suffix = key.startsWith("uploads/") ? key.slice("uploads/".length) : key;
    return `/api/v1/uploads/${suffix}`;
  }

  async signedDownloadUrl(key: string, _ttlSeconds?: number): Promise<string> {
    return this.publicUrl(key);
  }

  async signedUploadUrl(_args: { key: string; contentType?: string; ttlSeconds?: number }): Promise<{ url: string; key: string }> {
    throw Object.assign(
      new Error(
        "Browser-direct signed uploads are not supported with PostgreSQL storage. " +
        "All uploads must go through the server-relay chunked upload path (/api/v1/admin/videos/upload/*).",
      ),
      { statusCode: 501, code: "STORAGE_SIGNED_UPLOAD_NOT_SUPPORTED" },
    );
  }

  // ── Core CRUD ───────────────────────────────────────────────────────────────

  async putObject({ key, body, contentType }: { key: string; body: Buffer | Uint8Array; contentType?: string }): Promise<{ key: string; url: string }> {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const ct = contentType ?? "application/octet-stream";
    await db.execute(sql`
      INSERT INTO storage_blobs (key, content_type, size_bytes, data, updated_at)
      VALUES (${key}, ${ct}, ${buf.length}, ${buf}, NOW())
      ON CONFLICT (key) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        size_bytes   = EXCLUDED.size_bytes,
        data         = EXCLUDED.data,
        updated_at   = NOW()
    `);
    return { key, url: this.publicUrl(key) };
  }

  async getObject(key: string): Promise<{ body: Readable; contentType?: string; contentLength?: number }> {
    if (_shuttingDown) {
      throw Object.assign(new Error("Storage shutting down"), { code: "STORAGE_SHUTDOWN" });
    }
    type Row = { data: Buffer; content_type: string; size_bytes: number };
    const result = await db.execute<Row>(sql`
      SELECT data, content_type, size_bytes
      FROM storage_blobs
      WHERE key = ${key}
      LIMIT 1
    `);
    const row = firstRow<Row>(result);
    if (!row || row.data == null) {
      throw Object.assign(
        new Error(`Object not found in storage: ${key}`),
        { code: "SOURCE_MISSING", $metadata: { httpStatusCode: 404 } },
      );
    }
    const buf = toBuffer(row.data);
    const body = Readable.from(buf);
    _activeStreamCount++;
    const dec = (): void => { _activeStreamCount = Math.max(0, _activeStreamCount - 1); };
    body.once("close", dec);
    body.once("error", dec);
    return { body, contentType: row.content_type, contentLength: row.size_bytes };
  }

  async getObjectRange(key: string, start: number, end: number): Promise<{ body: Readable; contentType?: string; contentLength: number } | null> {
    if (_shuttingDown) return null;
    const length = end - start + 1;
    // Use PostgreSQL SUBSTRING for efficient byte-range extraction so only the
    // requested slice is transferred over the DB connection, not the full blob.
    type Row = { chunk: Buffer; content_type: string };
    const result = await db.execute<Row>(sql`
      SELECT SUBSTRING(data FROM ${start + 1} FOR ${length}) AS chunk, content_type
      FROM storage_blobs
      WHERE key = ${key}
      LIMIT 1
    `).catch(() => null);
    if (!result) return null;
    const row = firstRow<Row>(result);
    if (!row || row.chunk == null) return null;
    const buf = toBuffer(row.chunk);
    const body = Readable.from(buf);
    _activeStreamCount++;
    const dec = (): void => { _activeStreamCount = Math.max(0, _activeStreamCount - 1); };
    body.once("close", dec);
    body.once("error", dec);
    return { body, contentType: row.content_type, contentLength: buf.length };
  }

  async headObject(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
    type Row = { size_bytes: number; content_type: string };
    const result = await db.execute<Row>(sql`
      SELECT size_bytes, content_type
      FROM storage_blobs
      WHERE key = ${key}
      LIMIT 1
    `).catch(() => null);
    if (!result) return { exists: false };
    const row = firstRow<Row>(result);
    if (!row) return { exists: false };
    return { exists: true, contentLength: Number(row.size_bytes), contentType: row.content_type };
  }

  async deleteObject(key: string): Promise<void> {
    await db.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const result = await db.execute(sql`
      DELETE FROM storage_blobs WHERE starts_with(key, ${prefix})
    `);
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  // ── Multipart upload ────────────────────────────────────────────────────────
  //
  // Parts are staged in storage_upload_parts (BYTEA rows).
  // completeMultipartUpload() fetches all parts in order, concatenates in
  // Node.js memory, and writes the assembled blob to storage_blobs.
  //
  // Each part is ~8 MiB (matching the upload engine's chunk size).
  // Peak RSS during assembly: ~2× the total file size (parts + assembled buf).

  async createMultipartUpload({ key: _key, contentType }: { key: string; contentType?: string }): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    this._pendingContentTypes.set(uploadId, contentType ?? "video/mp4");
    return { uploadId };
  }

  async signUploadPart(_args: { key: string; uploadId: string; partNumber: number; ttlSeconds?: number }): Promise<string> {
    throw Object.assign(
      new Error("Signed upload parts are not supported with PostgreSQL storage."),
      { statusCode: 501, code: "STORAGE_SIGNED_UPLOAD_NOT_SUPPORTED" },
    );
  }

  async uploadPart({ uploadId, partNumber, body }: { key: string; uploadId: string; partNumber: number; body: Buffer }): Promise<{ etag: string }> {
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    await db.execute(sql`
      INSERT INTO storage_upload_parts (upload_id, part_number, etag, data, created_at)
      VALUES (${uploadId}, ${partNumber}, ${etag}, ${body}, NOW())
      ON CONFLICT (upload_id, part_number) DO UPDATE SET
        etag = EXCLUDED.etag,
        data = EXCLUDED.data
    `);
    return { etag };
  }

  async completeMultipartUpload({ key, uploadId }: { key: string; uploadId: string; parts: MultipartPart[] }): Promise<{ key: string; etag: string | null; location: string | null }> {
    type PartRow = { data: Buffer; part_number: number };
    const result = await db.execute<PartRow>(sql`
      SELECT part_number, data
      FROM storage_upload_parts
      WHERE upload_id = ${uploadId}
      ORDER BY part_number ASC
    `);
    const partRows = allRows<PartRow>(result);
    if (partRows.length === 0) {
      throw new Error(
        `completeMultipartUpload: no parts found in storage_upload_parts for uploadId=${uploadId} key=${key}. ` +
        "Parts may have been cleaned up already (idempotent re-call) or were never uploaded.",
      );
    }
    const buffers = partRows.map((r) => toBuffer(r.data));
    const assembled = Buffer.concat(buffers);

    const contentType = this._pendingContentTypes.get(uploadId) ?? "video/mp4";
    this._pendingContentTypes.delete(uploadId);

    await db.execute(sql`
      INSERT INTO storage_blobs (key, content_type, size_bytes, data, updated_at)
      VALUES (${key}, ${contentType}, ${assembled.length}, ${assembled}, NOW())
      ON CONFLICT (key) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        size_bytes   = EXCLUDED.size_bytes,
        data         = EXCLUDED.data,
        updated_at   = NOW()
    `);

    // Clean up parts — no longer needed after successful assembly.
    await db.execute(sql`DELETE FROM storage_upload_parts WHERE upload_id = ${uploadId}`)
      .catch((err) => logger.warn({ err, uploadId }, "[storage] upload-parts cleanup failed (non-fatal)"));

    const etag = `"${createHash("md5").update(assembled).digest("hex")}"`;
    logger.info(
      { key, uploadId, parts: partRows.length, bytes: assembled.length },
      "[storage] completeMultipartUpload done",
    );
    return { key, etag, location: this.publicUrl(key) };
  }

  async abortMultipartUpload({ uploadId }: { key: string; uploadId: string }): Promise<void> {
    this._pendingContentTypes.delete(uploadId);
    await db.execute(sql`DELETE FROM storage_upload_parts WHERE upload_id = ${uploadId}`)
      .catch((err) => logger.warn({ err, uploadId }, "[storage] abortMultipartUpload cleanup failed (non-fatal)"));
  }
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
 * Refresh storage capacity stats from the storage_blobs DB table.
 * Fire-and-forget safe — failures are logged as warn only.
 * Call periodically (e.g. every 5 min) from a supervised background worker.
 */
export async function refreshStorageStats(): Promise<StorageStats> {
  try {
    const { db: localDb } = await import("./db.js");
    const { sql: localSql } = await import("drizzle-orm");
    const rows = await localDb.execute<{ total_bytes: string; blob_count: string }>(localSql`
      SELECT
        COALESCE(SUM(size_bytes), 0)::text AS total_bytes,
        COUNT(*)::text AS blob_count
      FROM storage_blobs
    `);
    const row = firstRow<{ total_bytes: string; blob_count: string }>(rows);
    const totalBytes = parseInt(String(row?.total_bytes ?? "0"), 10);
    const totalBlobCount = parseInt(String(row?.blob_count ?? "0"), 10);
    _storageStats = { totalBytes, totalBlobCount, lastRefreshedAtMs: Date.now() };
    return _storageStats;
  } catch (err) {
    const { logger: localLogger } = await import("./logger.js");
    localLogger.warn({ err }, "[storage-stats] refresh failed (non-fatal)");
    return _storageStats;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _storage: ObjectStorage | null = null;

/**
 * Returns the singleton PostgreSQL BYTEA object storage instance.
 *
 * All video assets are stored in the storage_blobs PostgreSQL table.
 * S3_BUCKET / AWS credentials are no longer required.
 */
export function storage(): ObjectStorage {
  if (_storage) return _storage;
  _storage = new PostgresObjectStorage();
  logger.info("[storage] PostgreSQL BYTEA object storage ready");
  return _storage;
}
