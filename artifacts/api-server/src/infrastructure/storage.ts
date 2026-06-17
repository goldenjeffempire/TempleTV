import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { db, pgPool } from "./db.js";
import { logger } from "./logger.js";

/**
 * Database-backed binary object storage.
 *
 * All video assets — source uploads, HLS segments, playlists, thumbnails,
 * and multipart-upload temp parts — are stored as BYTEA rows in the
 * `storage_blobs` PostgreSQL table. PostgreSQL's TOAST mechanism
 * automatically compresses and fragments large values (> ~2 KiB) without
 * any application-layer intervention, keeping the main table row small
 * while the actual bytes live in a TOAST sub-table.
 *
 * Key design notes (mirroring the previous Replit Object Storage layer):
 *   - No presigned URLs — browser-direct uploads are not supported. All
 *     video data flows through the server-relay chunked upload path.
 *   - Multipart is emulated: createMultipartUpload stores a _meta/{uploadId}
 *     record, uploadPart stores parts under `_parts/{uploadId}/{000001}`,
 *     and completeMultipartUpload assembles them in order using PostgreSQL's
 *     bytea || operator (DB-side concat — no video bytes enter Node.js
 *     memory during finalization), upserts the final key, and cleans up
 *     the temp rows.
 *   - publicUrl / signedDownloadUrl both return the internal proxy path
 *     (`/api/v1/uploads/{key}`) so the video-serve routes stream bytes
 *     directly from the database — zero external dependencies.
 *   - Zero dependency on Replit Object Storage or any cloud provider.
 *
 * Storage key conventions:
 *   uploads/{yyyy}/{mm}/{dd}/{sessionId}.{ext}  — assembled source video
 *   transcoded/{videoId}/master.m3u8            — HLS master playlist
 *   transcoded/{videoId}/v0/playlist.m3u8       — rendition playlist
 *   transcoded/{videoId}/v0/seg_00001.ts        — MPEG-TS segment
 *   transcoded/{videoId}/thumbnail.jpg          — auto-generated thumbnail
 *   thumbnails/{sessionId}.{ext}                — custom uploaded thumbnail
 *   _parts/{uploadId}/{partNumber:06d}          — multipart temp parts
 *   _meta/{uploadId}                            — multipart content-type metadata
 *
 * ERR_STRING_TOO_LONG mitigation:
 *   The `pg` driver decodes `bytea` columns using hex encoding at the text-
 *   protocol level. For a 512 MB blob the in-flight hex string is ~1 GB —
 *   exceeding Node.js's maximum string length (~2^30 chars) and causing the
 *   fatal `ERR_STRING_TOO_LONG` crash. We mitigate this in two ways:
 *
 *   1. putObject enforces a configurable hard cap (MAX_PUT_BYTES, default 5 GB)
 *      and emits a warning for non-metadata blobs that approach the inline
 *      read threshold. Part rows (_parts/*) are exempt — they are always < 8 MiB.
 *
 *   2. getObject checks size_bytes before fetching data. For blobs above
 *      MAX_INLINE_READ_BYTES (64 MB) it falls back to a chunked streaming
 *      path that issues successive `SUBSTRING(data FROM x FOR n)` queries,
 *      each returning ≤ CHUNK_READ_BYTES (8 MiB) — well within the hex-string
 *      limit. The resulting Node.js Readable presents the same interface to
 *      callers so no changes are needed in video-serve routes.
 */

/**
 * Blobs at or below this size are fetched in a single query (fast path).
 * Above this threshold the chunked streaming path is used instead.
 * 64 MiB keeps the hex wire string at ≤ 128 MiB, comfortably below the
 * ~1 GiB Node.js string-length limit even across all supported Node versions.
 */
const MAX_INLINE_READ_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Each chunk in the streaming path fetches this many bytes via SUBSTRING.
 * 8 MiB matches the upload chunk size so memory stays flat during playback.
 */
const CHUNK_READ_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Hard cap on a single putObject call (5 GiB). Requests exceeding this
 * are rejected immediately rather than letting the pg driver try to
 * serialise a multi-GiB buffer as a query parameter string.
 * Upload chunks (_parts/*) use the multipart path so they are always < 8 MiB.
 */
const MAX_PUT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

/**
 * Warn when a non-multipart, non-video blob is stored inline above this size.
 * This catches accidental misuse (e.g. storing a full video without multipart).
 */
const WARN_PUT_BYTES = 5 * 1024 * 1024; // 5 MiB

// ── Active-stream tracking for graceful shutdown ──────────────────────────────
//
// `getObject` and `getObjectRange` increment this counter when they return a
// streaming Readable, and decrement it when that stream emits "close".
//
// The shutdown handler must call `signalStorageShutdown()` BEFORE closing the
// DB pool.  Without this guard, in-flight `streamChunked` generators continue
// issuing SUBSTRING queries against the closing pool and crash with:
//   "Error: Cannot use a pool after calling end on the pool"
//
// Shutdown sequence (in main.ts):
//   1. signalStorageShutdown()        ← generators stop at next chunk boundary
//   2. wait for getActiveStorageStreamCount() === 0  (up to ~15 s)
//   3. closeDb()                      ← safe — no more DB queries in flight
let _activeStreamCount = 0;
let _shuttingDown = false;

/** How many storage read streams are currently open (DB queries in-flight). */
export function getActiveStorageStreamCount(): number { return _activeStreamCount; }

/**
 * Signal the storage layer that the process is shutting down.
 * After this call, `streamChunked` generators exit at the next chunk boundary
 * instead of issuing another SUBSTRING query, preventing the
 * "Cannot use a pool after calling end" crash that occurs when the pool is
 * closed while active streams are still reading.
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
   * Returns the number of rows deleted.
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

class DatabaseObjectStorage implements ObjectStorage {
  readonly enabled = true;
  readonly bucket = null;
  readonly region = null;

  // ── URL helpers ─────────────────────────────────────────────────────────────

  publicUrl(key: string): string {
    // Strip the "uploads/" prefix so the video-serve /uploads/* wildcard
    // route can add it back: GET /api/v1/uploads/<suffix> → key=uploads/<suffix>.
    const suffix = key.startsWith("uploads/") ? key.slice("uploads/".length) : key;
    return `/api/v1/uploads/${suffix}`;
  }

  async signedDownloadUrl(key: string, _ttlSeconds?: number): Promise<string> {
    const suffix = key.startsWith("uploads/") ? key.slice("uploads/".length) : key;
    return `/api/v1/uploads/${suffix}`;
  }

  async signedUploadUrl(_args: { key: string; contentType?: string; ttlSeconds?: number }): Promise<{ url: string; key: string }> {
    throw Object.assign(
      new Error(
        "Direct browser upload is not supported with database-backed storage. " +
        "Use the chunked server-relay upload path (/api/admin/videos/upload/init).",
      ),
      { statusCode: 410 },
    );
  }

  // ── Core CRUD ───────────────────────────────────────────────────────────────

  async putObject({ key, body, contentType }: { key: string; body: Buffer | Uint8Array; contentType?: string }): Promise<{ key: string; url: string }> {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const ct = contentType ?? "application/octet-stream";

    // Hard cap: reject blobs that exceed 5 GiB. A single pg query parameter
    // cannot safely carry a multi-GiB buffer — it would be hex-encoded into
    // a string that may exceed Node.js's ERR_STRING_TOO_LONG limit before
    // even reaching the database.
    if (buf.length > MAX_PUT_BYTES) {
      throw Object.assign(
        new Error(
          `putObject rejected: blob for key "${key}" is ${buf.length} bytes — ` +
          `exceeds the ${MAX_PUT_BYTES}-byte hard cap. Use the multipart upload path.`,
        ),
        { statusCode: 413, code: "BLOB_TOO_LARGE" },
      );
    }

    // Warn when a non-multipart blob exceeds the inline-read threshold.
    // Part rows (_parts/*) are always ≤ 8 MiB so we exempt them.
    const isPartRow = key.startsWith("_parts/") || key.startsWith("_meta/");
    if (!isPartRow && buf.length > WARN_PUT_BYTES) {
      logger.warn(
        { key, sizeBytes: buf.length, inlineReadThreshold: MAX_INLINE_READ_BYTES },
        "[storage] large blob stored inline — getObject will use chunked streaming path",
      );
    }

    await db.execute(sql`
      INSERT INTO storage_blobs (key, content_type, data, size_bytes, updated_at)
      VALUES (${key}, ${ct}, ${buf}, ${buf.length}, NOW())
      ON CONFLICT (key) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        data         = EXCLUDED.data,
        size_bytes   = EXCLUDED.size_bytes,
        updated_at   = NOW()
    `);
    return { key, url: this.publicUrl(key) };
  }

  /**
   * Retrieves a blob by key and returns a Readable stream of its bytes.
   *
   * ERR_STRING_TOO_LONG safety: the `pg` driver decodes bytea via hex, so a
   * 512 MiB blob produces a ~1 GiB hex string in the wire buffer — crashing
   * Node.js before we can even convert it to a Buffer. To prevent this, we
   * first check the stored size_bytes (a cheap integer column read), then:
   *
   *   ≤ MAX_INLINE_READ_BYTES (64 MiB): single-query fast path (no change vs. before).
   *   >  MAX_INLINE_READ_BYTES (64 MiB): chunked streaming via successive
   *      SUBSTRING(data FROM x FOR n) queries of ≤ 8 MiB each.
   *
   * The interface to callers is unchanged — they always get a Readable.
   */
  async getObject(key: string): Promise<{ body: Readable; contentType?: string; contentLength?: number }> {
    // First, resolve the content-type and size without loading any bytea data.
    const headResult = await db.execute(sql`
      SELECT content_type, size_bytes
      FROM storage_blobs
      WHERE key = ${key}
      LIMIT 1
    `);

    if (headResult.rows.length === 0) {
      throw Object.assign(
        new Error(`Object not found in storage: ${key}`),
        { code: "SOURCE_MISSING", $metadata: { httpStatusCode: 404 } },
      );
    }

    const headRow = headResult.rows[0] as { content_type: string; size_bytes: number };
    const sizeBytes = Number(headRow.size_bytes ?? 0);
    const contentType = headRow.content_type;

    // For large blobs, use the chunked streaming path to avoid ERR_STRING_TOO_LONG.
    if (sizeBytes > MAX_INLINE_READ_BYTES) {
      logger.debug(
        { key, sizeBytes, threshold: MAX_INLINE_READ_BYTES, chunkSize: CHUNK_READ_BYTES },
        "[storage] using chunked streaming path for large blob",
      );
      const body = this.streamChunked(key, sizeBytes);
      _activeStreamCount++;
      const decStream = () => { _activeStreamCount = Math.max(0, _activeStreamCount - 1); };
      body.once("close", decStream);
      // Also decrement on error so a stream that errors without emitting
      // "close" does not permanently inflate _activeStreamCount and block
      // graceful shutdown from completing.
      body.once("error", decStream);
      return { body, contentType, contentLength: sizeBytes };
    }

    // Fast path: small blob fits safely in a single query result string.
    const result = await db.execute(sql`
      SELECT content_type, data, size_bytes
      FROM storage_blobs
      WHERE key = ${key}
      LIMIT 1
    `);

    const row = result.rows[0] as { content_type: string; data: Buffer; size_bytes: number };
    const buf: Buffer = Buffer.isBuffer(row.data)
      ? row.data
      : Buffer.from(row.data as unknown as Uint8Array);

    const body = Readable.from(buf);
    _activeStreamCount++;
    const decInline = () => { _activeStreamCount = Math.max(0, _activeStreamCount - 1); };
    body.once("close", decInline);
    body.once("error", decInline);
    return { body, contentType: row.content_type, contentLength: buf.length };
  }

  /**
   * Streams a large blob from the database using successive SUBSTRING queries.
   *
   * Each query retrieves at most CHUNK_READ_BYTES (8 MiB) of the bytea value.
   * The hex encoding of an 8 MiB chunk is 16 MiB — far below Node.js's
   * ~1 GiB string limit. This generator is wrapped in a Node.js Readable so
   * callers see the same interface as the small-blob fast path.
   *
   * PostgreSQL SUBSTRING uses 1-based indexing: SUBSTRING(data FROM 1 FOR n)
   * returns the first n bytes.
   */
  private streamChunked(key: string, totalBytes: number): Readable {
    const chunkSize = CHUNK_READ_BYTES;

    async function* generate() {
      let offset = 1; // PostgreSQL SUBSTRING is 1-indexed
      while (offset <= totalBytes) {
        // Stop issuing new SUBSTRING queries once the server is shutting down.
        // This prevents "Cannot use a pool after calling end on the pool" when
        // the DB pool is closed before all in-flight streamChunked generators
        // have finished reading.  The Readable downstream will see an early end
        // which is benign — the client connection is being torn down anyway.
        if (_shuttingDown) break;
        const result = await db.execute(sql`
          SELECT SUBSTRING(data FROM ${offset} FOR ${chunkSize}) AS chunk
          FROM storage_blobs
          WHERE key = ${key}
        `);

        const row = result.rows[0] as { chunk: Buffer | string | null } | undefined;
        if (!row?.chunk) break;

        const chunk = row.chunk;
        const buf: Buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as unknown as Uint8Array);

        if (buf.length === 0) break;
        yield buf;
        offset += buf.length;

        // If we got fewer bytes than requested, we've reached the end.
        if (buf.length < chunkSize) break;
      }
    }

    return Readable.from(generate());
  }

  async deleteObject(key: string): Promise<void> {
    await db.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const result = await db.execute(
      sql`DELETE FROM storage_blobs WHERE starts_with(key, ${prefix})`,
    );
    return (result as unknown as { rowCount: number }).rowCount ?? 0;
  }

  async headObject(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
    const result = await db.execute(sql`
      SELECT size_bytes, content_type
      FROM storage_blobs
      WHERE key = ${key}
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return { exists: false };
    }

    const row = result.rows[0] as { size_bytes: number; content_type: string };
    return {
      exists: true,
      contentLength: Number(row.size_bytes),
      contentType: row.content_type,
    };
  }

  /**
   * Fetches a byte-range slice from a stored blob using PostgreSQL's
   * SUBSTRING function. `start` and `end` are 0-indexed, inclusive
   * (HTTP Range header semantics). Converts to PostgreSQL's 1-indexed
   * SUBSTRING(data FROM pgStart FOR pgLen).
   *
   * For ranges > CHUNK_READ_BYTES the result is chunked through the
   * same streaming generator used by getObject, keeping Node.js memory
   * flat even for large range requests.
   */
  async getObjectRange(
    key: string,
    start: number,
    end: number,
  ): Promise<{ body: Readable; contentType?: string; contentLength: number } | null> {
    const head = await this.headObject(key);
    if (!head.exists) return null;

    const totalBytes = head.contentLength ?? 0;
    const clampedEnd = Math.min(end, totalBytes - 1);
    const clampedStart = Math.max(0, start);
    const length = clampedEnd - clampedStart + 1;

    if (length <= 0) {
      return { body: Readable.from([]), contentType: head.contentType, contentLength: 0 };
    }

    // PostgreSQL SUBSTRING is 1-indexed.
    const pgStart = clampedStart + 1;
    const chunkSize = CHUNK_READ_BYTES;

    if (length <= chunkSize) {
      // Fast path: single SUBSTRING query for the whole range.
      const result = await db.execute(sql`
        SELECT content_type, SUBSTRING(data FROM ${pgStart} FOR ${length}) AS chunk
        FROM storage_blobs
        WHERE key = ${key}
        LIMIT 1
      `);
      const row = result.rows[0] as { content_type: string; chunk: Buffer | string | null } | undefined;
      if (!row?.chunk) {
        return { body: Readable.from([]), contentType: head.contentType, contentLength: 0 };
      }
      const buf = Buffer.isBuffer(row.chunk)
        ? row.chunk
        : Buffer.from(row.chunk as unknown as Uint8Array);
      return { body: Readable.from(buf), contentType: head.contentType, contentLength: buf.length };
    }

    // Large range: stream in chunks.
    const contentType = head.contentType;
    async function* generate() {
      let offset = pgStart;
      const pgEnd = pgStart + length - 1;
      while (offset <= pgEnd) {
        if (_shuttingDown) break; // same guard as streamChunked
        const remaining = pgEnd - offset + 1;
        const fetchLen = Math.min(chunkSize, remaining);
        const result = await db.execute(sql`
          SELECT SUBSTRING(data FROM ${offset} FOR ${fetchLen}) AS chunk
          FROM storage_blobs
          WHERE key = ${key}
        `);
        const row = result.rows[0] as { chunk: Buffer | string | null } | undefined;
        if (!row?.chunk) break;
        const buf = Buffer.isBuffer(row.chunk)
          ? row.chunk
          : Buffer.from(row.chunk as unknown as Uint8Array);
        if (buf.length === 0) break;
        yield buf;
        offset += buf.length;
        if (buf.length < fetchLen) break;
      }
    }

    const body = Readable.from(generate());
    _activeStreamCount++;
    const decRange = () => { _activeStreamCount = Math.max(0, _activeStreamCount - 1); };
    body.once("close", decRange);
    // Also handle error to prevent count from getting stuck when the stream
    // errors without emitting a close event.
    body.once("error", decRange);
    return { body, contentType, contentLength: length };
  }

  // ── Multipart upload (emulated via storage_blobs temp rows) ─────────────────

  /**
   * Reserves a multipart upload slot. The content-type is persisted to a
   * `_meta/{uploadId}` row so `completeMultipartUpload` can use it when
   * writing the final assembled blob.
   */
  async createMultipartUpload({ key, contentType }: { key: string; contentType?: string }): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    const meta = JSON.stringify({ key, contentType: contentType ?? "application/octet-stream" });
    await this.putObject({
      key: `_meta/${uploadId}`,
      body: Buffer.from(meta, "utf8"),
      contentType: "application/json",
    });
    return { uploadId };
  }

  async signUploadPart(_args: { key: string; uploadId: string; partNumber: number; ttlSeconds?: number }): Promise<string> {
    throw Object.assign(
      new Error(
        "Presigned part URLs are not supported with database-backed storage. " +
        "Use the server-relay chunked upload path.",
      ),
      { statusCode: 410 },
    );
  }

  /**
   * Stores a raw chunk as a temp row keyed `_parts/{uploadId}/{partNumber:06d}`.
   * Returns a real MD5 ETag of the part bytes — matching S3 ETag semantics and
   * providing a cryptographic fingerprint for each stored part.
   *
   * The MD5 is computed in Node.js after the part is written to storage so the
   * ETag can be verified independently of the DB bytes at finalize time.
   */
  async uploadPart({ uploadId, partNumber, body }: { key: string; uploadId: string; partNumber: number; body: Buffer }): Promise<{ etag: string }> {
    const partKey = `_parts/${uploadId}/${String(partNumber).padStart(6, "0")}`;
    await this.putObject({ key: partKey, body, contentType: "application/octet-stream" });
    const etag = createHash("md5").update(body).digest("hex");
    return { etag };
  }

  /**
   * Assembles all uploaded parts in part-number order and writes the combined
   * data to the final key using PostgreSQL's bytea || operator entirely inside
   * the database engine.
   *
   * This avoids loading the full video into Node.js memory: only SQL query
   * strings travel over the pg connection — the video bytes never leave the
   * database server during assembly. Peak Node.js memory impact is O(1)
   * regardless of file size.
   *
   * The assembly is an iterative UPDATE ... FROM self-join:
   *   dest.data = dest.data || src.data
   * PostgreSQL's TOAST engine handles large bytea values efficiently; it can
   * spill partial results to disk when work_mem is exhausted, so files well
   * beyond available RAM can be assembled without an OOM crash.
   *
   * Temp part rows (_parts/*) and the _meta row are deleted asynchronously
   * after the final key is committed — failures are non-fatal (they leave
   * orphaned rows that the storage GC sweep can clean later).
   */
  async completeMultipartUpload({ key, uploadId, parts }: { key: string; uploadId: string; parts: MultipartPart[] }): Promise<{ key: string; etag: string | null; location: string | null }> {
    // ── TOCTOU guard via PostgreSQL session-level advisory lock ────────────
    // Two concurrent /finalize calls for the same upload (client retry while
    // the first is still assembling) would otherwise both INSERT…ON CONFLICT
    // race on the seed row and then interleave UPDATE …|| src.data appends,
    // producing a corrupt assembled blob whose size_bytes no longer equals
    // the sum of the parts.
    //
    // CRITICAL: PostgreSQL session-scoped advisory locks are tied to the
    // physical connection. The Drizzle `db` instance is backed by a pg pool,
    // so two `db.execute` calls can land on different connections — the lock
    // would be released the moment the lock-acquire call returns the
    // connection to the pool. We therefore pin a single client for the
    // entire lock → assembly → unlock critical section. Connection loss
    // releases the lock automatically.
    let lockKey = 0;
    for (let i = 0; i < uploadId.length; i++) {
      lockKey = ((lockKey << 5) - lockKey + uploadId.charCodeAt(i)) | 0;
    }
    const client = await pgPool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
      try {
        return await this._completeMultipartUploadLocked({ key, uploadId, parts }, client);
      } finally {
        await client
          .query("SELECT pg_advisory_unlock($1::bigint)", [lockKey])
          .catch(() => {});
      }
    } finally {
      // Restore the connection's statement_timeout to the session default
      // (the startup-parameter value) before returning it to the pool.
      // _completeMultipartUploadLocked sets statement_timeout=0 to prevent
      // the per-part assembly UPDATEs from being killed on large files.
      await client.query("RESET statement_timeout").catch(() => {});
      client.release();
    }
  }

  /**
   * Lock-protected assembly. The `client` argument is the same pinned
   * pg connection that holds the session-scoped advisory lock — all SQL
   * runs on it so the finalize path consumes exactly one pool connection
   * (not two) and the lock is observably held for every UPDATE.
   *
   * The cleanup work (DELETE temp parts, DELETE _meta) is fire-and-forget
   * through the shared `db` pool because it runs after the assembled blob
   * is committed and the lock is no longer needed.
   */
  private async _completeMultipartUploadLocked(
    { key, uploadId, parts }: { key: string; uploadId: string; parts: MultipartPart[] },
    client: import("pg").PoolClient,
  ): Promise<{ key: string; etag: string | null; location: string | null }> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    // Resolve content-type from the _meta record stored at createMultipartUpload time.
    // Read via the pinned `client` so the entire lock-critical section (meta read +
    // seed INSERT + per-part UPDATE loop + content-type UPDATE) executes on a single
    // physical connection while the advisory lock is held. This closes any TOCTOU
    // window between the meta lookup and assembly: a concurrent abort/cleanup on
    // another client would block on the same advisory lock and cannot race the read.
    let contentType = "application/octet-stream";
    try {
      const metaKey = `_meta/${uploadId}`;
      const metaRes = await client.query<{ data: Buffer }>(
        `SELECT data FROM storage_blobs WHERE key = $1`,
        [metaKey],
      );
      if (metaRes.rowCount && metaRes.rows[0]?.data) {
        const parsed = JSON.parse(metaRes.rows[0].data.toString("utf8")) as {
          contentType?: string;
        };
        if (parsed.contentType) contentType = parsed.contentType;
      }
    } catch {
      // Non-fatal: fall back to octet-stream.
    }

    /**
     * Per-part iterative assembly — guaranteed to work regardless of work_mem.
     *
     * The previous batch-hex approach (string_agg(encode(data,'hex'))) built a
     * 480 MB intermediate hex string in PostgreSQL memory for each 30-part batch.
     * On Replit's shared PostgreSQL (low work_mem), this causes an OOM error and
     * the finalize request fails.
     *
     * This approach uses individual bytea || appends per part. PostgreSQL's TOAST
     * engine spills partial results to disk automatically when work_mem is
     * exhausted, so assembly always completes regardless of memory limits.
     *
     * Performance: O(n²) in TOAST I/O — each UPDATE reads the growing dest blob
     * plus the 8 MiB source part. For typical uploads (≤ 30 parts / ≤ 240 MB)
     * this is fast enough. For very large files the I/O cost is higher but the
     * operation always succeeds.
     *
     * statement_timeout override: The shared pool is initialized with a
     * statement_timeout startup parameter (default 30 s) to guard against
     * runaway OLTP queries. The per-part UPDATE here reads the ENTIRE
     * growing TOAST blob on every iteration — for large files (128+ parts /
     * 1 GB+) a single UPDATE can legitimately run for several minutes.
     * We disable the timeout for the duration of this pinned client's
     * assembly work and restore the pool default afterwards so the guard
     * remains in place for all other queries on this connection once it
     * returns to the pool.
     */
    await client.query("SET statement_timeout = 0").catch(() => {});

    const partPrefix = `_parts/${uploadId}/`;

    // ── Seed the destination row with the first part ───────────────────────────
    // INSERT … SELECT copies chunk bytes entirely within the DB; Node.js sees
    // only the SQL string — no video bytes cross the pg connection.
    const firstPartKey = `${partPrefix}${String(sorted[0]!.partNumber).padStart(6, "0")}`;
    const seedResult = await client.query(
      `INSERT INTO storage_blobs (key, content_type, data, size_bytes, updated_at)
       SELECT $1, $2, data, size_bytes, NOW()
       FROM   storage_blobs
       WHERE  key = $3
       ON CONFLICT (key) DO UPDATE SET
         content_type = EXCLUDED.content_type,
         data         = EXCLUDED.data,
         size_bytes   = EXCLUDED.size_bytes,
         updated_at   = NOW()`,
      [key, contentType, firstPartKey],
    );
    const seedRowCount = seedResult.rowCount ?? 0;
    if (seedRowCount === 0) {
      throw Object.assign(
        new Error(
          `Assembly failed: first part (key ${firstPartKey}) not found in storage. ` +
          `The upload part rows may have been cleaned up — restart the upload to recover.`,
        ),
        { statusCode: 409 },
      );
    }

    // ── Append remaining parts one at a time ───────────────────────────────────
    // O(n²) in total PostgreSQL I/O — each UPDATE reads the growing dest blob
    // plus the 8 MiB source part. For a 1 GB file (128 parts) this is ~65 GB of
    // DB I/O total. The operation is therefore run in the background task started
    // by the finalize endpoint so it never blocks an HTTP response.
    const assemblyStart = Date.now();
    for (let i = 1; i < sorted.length; i++) {
      const partKey = `${partPrefix}${String(sorted[i]!.partNumber).padStart(6, "0")}`;
      const appended = await client.query(
        `UPDATE storage_blobs AS dest
         SET
           data       = dest.data || src.data,
           size_bytes = dest.size_bytes + src.size_bytes,
           updated_at = NOW()
         FROM   storage_blobs AS src
         WHERE  dest.key = $1
           AND  src.key  = $2`,
        [key, partKey],
      );
      const rowCount = appended.rowCount ?? 0;
      if (rowCount === 0) {
        throw Object.assign(
          new Error(
            `Assembly failed: part ${sorted[i]!.partNumber} (key ${partKey}) not found in storage. ` +
            `Re-upload the missing chunk and re-finalize to retry.`,
          ),
          { statusCode: 409 },
        );
      }
      // Log progress every 25 parts so operators can monitor large-file assembly.
      if (i % 25 === 0 || i === sorted.length - 1) {
        const pct = Math.round(((i + 1) / sorted.length) * 100);
        const elapsedMs = Date.now() - assemblyStart;
        logger.info(
          { key, part: i + 1, total: sorted.length, pct, elapsedMs },
          "[storage:assembly] multipart assembly progress",
        );
      }
    }

    // ── Post-assembly size assertion ──────────────────────────────────────────
    // Verify the assembled blob's size_bytes equals the sum of all part
    // size_bytes BEFORE cleaning up the part rows.  The part rows are still
    // present at this point so summing them is accurate.  A mismatch means a
    // part-append UPDATE silently affected 0 rows (part row missing or
    // statement-timeout despite SET statement_timeout=0, or a concurrent
    // DELETE swept a part mid-loop). Throwing here surfaces the problem to the
    // caller so it can mark the video failed and reset the session — much safer
    // than returning a truncated blob that only fails when the transcoder tries
    // to decode it after burning through retry budget.
    {
      type SizeRow = { assembled: string | number; expected: string | number };
      const sizeCheck = await client.query<SizeRow>(
        `SELECT
           (SELECT size_bytes FROM storage_blobs WHERE key = $1) AS assembled,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM storage_blobs WHERE starts_with(key, $2)) AS expected`,
        [key, partPrefix],
      );
      const row = sizeCheck.rows[0];
      const assembledBytes = Number(row?.assembled ?? 0);
      const expectedBytes  = Number(row?.expected  ?? 0);
      if (expectedBytes > 0 && assembledBytes !== expectedBytes) {
        throw Object.assign(
          new Error(
            `[storage] completeMultipartUpload size assertion failed for key "${key}": ` +
            `assembled ${assembledBytes} bytes but parts sum to ${expectedBytes} bytes. ` +
            `The assembled blob is corrupt — do not proceed to transcoding.`,
          ),
          { statusCode: 500 },
        );
      }
    }

    // Correct content-type on the assembled row (the seed INSERT already set it,
    // but an idempotent re-finalize may have preserved a stale value).
    await client.query(
      `UPDATE storage_blobs SET content_type = $1, updated_at = NOW() WHERE key = $2`,
      [contentType, key],
    );

    // Clean up temp part rows and meta record asynchronously — non-fatal.
    void Promise.allSettled([
      db.execute(sql`DELETE FROM storage_blobs WHERE starts_with(key, ${partPrefix})`),
      this.deleteObject(`_meta/${uploadId}`),
    ]).catch(() => {});

    logger.info(
      { key, uploadId, parts: sorted.length },
      "[storage] completeMultipartUpload: assembly done",
    );

    return { key, etag: null, location: this.publicUrl(key) };
  }

  /**
   * Deletes all temp rows for a cancelled multipart upload.
   * Uses a prefix scan on the primary key index.
   */
  async abortMultipartUpload({ uploadId }: { key: string; uploadId: string }): Promise<void> {
    const partPrefix = `_parts/${uploadId}/`;
    const metaKey = `_meta/${uploadId}`;
    await Promise.allSettled([
      db.execute(sql`DELETE FROM storage_blobs WHERE starts_with(key, ${partPrefix})`),
      db.execute(sql`DELETE FROM storage_blobs WHERE key = ${metaKey}`),
    ]);
  }
}

let _storage: ObjectStorage | null = null;

export function storage(): ObjectStorage {
  if (_storage) return _storage;
  _storage = new DatabaseObjectStorage();
  logger.info("Database-backed object storage ready (zero external dependencies)");
  return _storage;
}
