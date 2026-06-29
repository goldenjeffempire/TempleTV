import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { env } from "../config/env.js";

/**
 * PostgreSQL BYTEA object storage — zero-copy streaming implementation.
 *
 * All video assets (source uploads, HLS segments, playlists, thumbnails) are
 * stored as BYTEA in the storage_blobs PostgreSQL table.  In-progress
 * multipart uploads are staged in storage_upload_parts and assembled on
 * completion.  No MinIO/S3 dependency required.
 *
 * Memory model (post streaming refactor):
 *   - getObject() streams data in STORAGE_READ_CHUNK_BYTES (8 MiB) chunks
 *     via repeated SUBSTRING queries.  Peak Node.js RSS per stream: ~24 MiB
 *     (one decoded chunk).  A 5 GB video uses the same Node.js memory as a
 *     100 MB video — O(1) regardless of blob size.
 *   - completeMultipartUpload() assembles all parts inside PostgreSQL using the
 *     bytea_agg(data ORDER BY part_number) custom aggregate.  Node.js sends
 *     one INSERT…SELECT query and receives nothing back — peak Node.js RSS: ~0.
 *     The aggregate is created at startup in ensureRuntimeIndexes().
 *   - getObjectRange() streams in STORAGE_READ_CHUNK_BYTES sub-ranges. The
 *     first chunk query also fetches content_type (no separate headObject()
 *     round-trip — saves one SELECT per Range request).
 *   - putObject() accepts a caller-supplied Buffer (small objects: HLS segments
 *     ≤8 MiB, thumbnails ≤200 KB).  No change needed.
 *
 * Storage key conventions:
 *   uploads/{yyyy}/{mm}/{dd}/{sessionId}.{ext}  — assembled source video
 *   transcoded/{videoId}/master.m3u8            — HLS master playlist
 *   transcoded/{videoId}/v0/playlist.m3u8       — rendition playlist
 *   transcoded/{videoId}/v0/seg_00001.ts        — MPEG-TS segment
 *   transcoded/{videoId}/thumbnail.jpg          — auto-generated thumbnail
 *   thumbnails/{sessionId}.{ext}                — custom uploaded thumbnail
 */

/** Each SUBSTRING query fetches this many bytes from PostgreSQL.
 *  4 MiB balances throughput with memory safety: each chunk produces an
 *  ~8 MiB intermediate hex string in the pg driver before decoding to a
 *  4 MiB Buffer — peak RSS per in-flight stream ≈ 12 MiB.  At
 *  HLS_MAX_CONCURRENT=10 that is ≤ 120 MiB external pressure from HLS alone
 *  (vs 240 MiB at 8 MiB chunks).  The extra round-trips add < 1 ms of
 *  latency per segment on a local PostgreSQL connection.                  */
const STORAGE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

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
  /**
   * @param expectedSha256 Optional 64-char lowercase hex SHA-256 of the complete file.
   *   When provided, the assembled blob's SHA-256 is computed server-side inside
   *   PostgreSQL and compared.  Any mismatch causes the transaction to roll back
   *   so no corrupt blob is ever committed to storage_blobs.
   */
  completeMultipartUpload(args: { key: string; uploadId: string; parts: MultipartPart[]; expectedSha256?: string }): Promise<{ key: string; etag: string | null; location: string | null }>;
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

    // Reject empty bodies upfront — writing a zero-byte blob produces a row that
    // looks valid in storage_blobs but serves empty/corrupt content to clients.
    // Callers must ensure the body is non-empty before calling putObject.
    if (buf.length === 0) {
      throw Object.assign(
        new Error(
          `putObject: refusing to write zero-byte blob for key "${key}". ` +
          "An empty body indicates an interrupted or failed upstream write. " +
          "Ensure the source data is fully materialised before calling putObject.",
        ),
        { code: "STORAGE_EMPTY_BODY", statusCode: 400 },
      );
    }

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

    // Fetch metadata first — needed to drive chunk boundaries and validate existence.
    // One extra round-trip vs the old single-query approach, but avoids loading the
    // entire BYTEA into Node.js memory (critical for multi-gigabyte source videos:
    // the pg driver hex-decodes BYTEA, so a 1 GB blob produces ~2 GB of transient
    // allocations causing "invalid memory alloc request size" / OOM crashes).
    const head = await this.headObject(key);
    if (!head.exists || head.contentLength === undefined) {
      throw Object.assign(
        new Error(`Object not found in storage: ${key}`),
        { code: "SOURCE_MISSING", $metadata: { httpStatusCode: 404 } },
      );
    }

    const totalSize = head.contentLength;
    const chunkSize = STORAGE_READ_CHUNK_BYTES;
    const chunkCount = Math.ceil(totalSize / Math.max(1, chunkSize));

    logger.debug(
      { key, sizeBytes: totalSize, chunkSize, chunkCount },
      "[storage] getObject: chunked stream start",
    );

    // Capture for async generator closure (avoids stale `this` / parameter ref).
    const capturedKey = key;

    // Async generator — each iteration issues one SUBSTRING query fetching
    // exactly chunkSize bytes.  Only one chunk (~8 MiB) is held in Node.js
    // memory at a time regardless of total blob size.  Backpressure is handled
    // automatically by Readable.from(): the generator only advances when the
    // downstream consumer has drained its internal buffer.
    async function* readChunks(): AsyncGenerator<Buffer> {
      let offset = 0;
      let chunksRead = 0;
      while (offset < totalSize) {
        // Stop issuing new DB queries once the process is shutting down.
        // Mirrors the same guard in readRangeChunks() below so in-flight
        // streams release their DB connections promptly on SIGTERM.
        if (_shuttingDown) break;
        const length = Math.min(chunkSize, totalSize - offset);
        // PostgreSQL SUBSTRING is 1-indexed; our offset is 0-based.
        const pgOffset = offset + 1;
        type ChunkRow = { chunk: Buffer };
        let row: ChunkRow | undefined;
        try {
          const result = await db.execute<ChunkRow>(sql`
            SELECT SUBSTRING(data FROM ${pgOffset} FOR ${length}) AS chunk
            FROM storage_blobs
            WHERE key = ${capturedKey}
            LIMIT 1
          `);
          row = firstRow<ChunkRow>(result);
        } catch (err) {
          throw Object.assign(
            new Error(
              `[storage] getObject: chunk read failed at byte offset ${offset} for key "${capturedKey}": ${(err as Error).message}`,
            ),
            { code: "STORAGE_READ_ERROR", cause: err },
          );
        }
        if (!row?.chunk) {
          // Key was deleted between headObject and this chunk read.
          throw Object.assign(
            new Error(
              `[storage] getObject: chunk missing at byte offset ${offset} for key "${capturedKey}" ` +
              `(blob deleted between headObject and chunk read)`,
            ),
            { code: "SOURCE_MISSING", $metadata: { httpStatusCode: 404 } },
          );
        }
        const buf = toBuffer(row.chunk);
        if (buf.length === 0) break; // Defensive: SUBSTRING past EOF returns empty.
        offset += buf.length;
        chunksRead++;
        yield buf;
      }
      logger.debug(
        { key: capturedKey, sizeBytes: totalSize, chunksRead },
        "[storage] getObject: chunked stream complete",
      );
    }

    const body = Readable.from(readChunks(), { objectMode: false });
    _activeStreamCount++;
    // One-shot flag prevents double-decrement when Node.js emits both
    // 'error' and 'close' on the same Readable (happens on destroy(err)).
    let _decCalled = false;
    const dec = (): void => {
      if (_decCalled) return;
      _decCalled = true;
      _activeStreamCount = Math.max(0, _activeStreamCount - 1);
    };
    body.once("close", dec);
    body.once("error", dec);

    return { body, contentType: head.contentType, contentLength: totalSize };
  }

  async getObjectRange(key: string, start: number, end: number): Promise<{ body: Readable; contentType?: string; contentLength: number } | null> {
    if (_shuttingDown) return null;
    const rangeLength = end - start + 1;

    // Stream the requested byte range in STORAGE_READ_CHUNK_BYTES (8 MiB)
    // sub-ranges, exactly like getObject().
    //
    // WHY CHUNKED:  The old single-query approach —
    //   SELECT SUBSTRING(data FROM start FOR length)
    // — makes the pg driver allocate a hex string of `length * 2` bytes
    // internally before handing a Buffer to Node.js.  For a 50 MB Range
    // request that is a 100 MB intermediate hex string; on a 268 MiB V8
    // heap (Replit free tier) it throws ERR_STRING_TOO_LONG, which triggers
    // an unhandledRejection → process crash → "Cannot use a pool after
    // calling end on the pool" during in-flight uploads → server restart
    // → mobile black screen.
    //
    // Each 8 MiB chunk produces only a 16 MiB hex string — safe on any
    // host.  Memory per concurrent range-stream: ~24 MiB (one decoded
    // chunk held between yield and GC).
    //
    // WHY NO SEPARATE headObject():  The Range request handler (caller) has
    // already called headObject() to validate the range and determine total
    // file size.  A second headObject() inside getObjectRange() was redundant
    // — an extra SELECT per Range request.  Instead, we include content_type
    // in the first SUBSTRING query, which simultaneously checks existence,
    // captures the content type, and fetches the first data chunk in one
    // round-trip.
    const chunkSize = STORAGE_READ_CHUNK_BYTES;
    const capturedKey = key;

    // Pre-fetch the first chunk together with content_type.  This combines
    // the existence check, content-type resolution, and first data read into
    // a single DB round-trip (saves one SELECT vs a prior headObject() call).
    const firstChunkLen = Math.min(chunkSize, rangeLength);
    const firstPgFrom = start + 1; // SUBSTRING is 1-indexed; start is 0-indexed
    type FirstRow = { chunk: Buffer; content_type: string };
    const firstResult = await db.execute<FirstRow>(sql`
      SELECT SUBSTRING(data FROM ${firstPgFrom} FOR ${firstChunkLen}) AS chunk,
             content_type
      FROM storage_blobs
      WHERE key = ${capturedKey}
      LIMIT 1
    `).catch(() => null);
    if (!firstResult) return null;
    const firstRowData = firstRow<FirstRow>(firstResult);
    if (!firstRowData) return null; // key does not exist

    const resolvedContentType = firstRowData.content_type;
    const firstBuf = toBuffer(firstRowData.chunk);

    async function* readRangeChunks(): AsyncGenerator<Buffer> {
      // Yield the pre-fetched first chunk (may be empty if start ≥ blob end).
      if (firstBuf.length === 0) return;
      yield firstBuf;

      // Advance by ACTUAL bytes returned, not the intended chunkLen.
      // When SUBSTRING returns fewer bytes than requested (only possible if
      // size_bytes in the DB over-reports the real data length), advancing by
      // buf.length keeps pos accurate so the next query starts at the correct
      // position rather than skipping a gap.  This mirrors getObject()'s
      // `offset += buf.length` pattern.
      let pos = start + firstBuf.length;
      while (pos <= end) {
        if (_shuttingDown) break;
        const chunkLen = Math.min(chunkSize, end - pos + 1);
        // PostgreSQL SUBSTRING is 1-indexed.
        const pgFrom = pos + 1;
        type ChunkRow = { chunk: Buffer };
        const result = await db.execute<ChunkRow>(sql`
          SELECT SUBSTRING(data FROM ${pgFrom} FOR ${chunkLen}) AS chunk
          FROM storage_blobs
          WHERE key = ${capturedKey}
          LIMIT 1
        `).catch(() => null);
        if (!result) break;
        const row = firstRow<ChunkRow>(result);
        if (!row?.chunk) break;
        const buf = toBuffer(row.chunk);
        if (buf.length === 0) break; // past end of blob
        yield buf;
        pos += buf.length; // advance by actual bytes, not intended chunkLen
      }
    }

    const body = Readable.from(readRangeChunks(), { objectMode: false });
    _activeStreamCount++;
    // One-shot flag prevents double-decrement when Node.js emits both
    // 'error' and 'close' on the same Readable (happens on destroy(err)).
    let _decRangeCalled = false;
    const dec = (): void => {
      if (_decRangeCalled) return;
      _decRangeCalled = true;
      _activeStreamCount = Math.max(0, _activeStreamCount - 1);
    };
    body.once("close", dec);
    body.once("error", dec);
    // contentLength reports the nominal range length so callers can set the
    // correct Content-Length / Content-Range headers.  The actual bytes
    // yielded match this for all intact blobs (SUBSTRING at a valid position
    // returns exactly the requested byte count).
    return { body, contentType: resolvedContentType, contentLength: rangeLength };
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
  // Parts are staged in storage_upload_parts (BYTEA rows, ~8 MiB each).
  // completeMultipartUpload() assembles all parts inside PostgreSQL via the
  // bytea_agg custom aggregate — Node.js never receives the assembled blob.
  // Peak Node.js RSS during assembly: ~0 bytes (one INSERT…SELECT round-trip).
  // Peak PostgreSQL working memory: O(total file size) for the aggregation.

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
    if (_shuttingDown) {
      throw Object.assign(new Error("Storage is shutting down — upload rejected"), { code: "STORAGE_SHUTDOWN" });
    }
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

  async completeMultipartUpload({ key, uploadId, expectedSha256 }: { key: string; uploadId: string; parts: MultipartPart[]; expectedSha256?: string }): Promise<{ key: string; etag: string | null; location: string | null }> {
    if (_shuttingDown) {
      throw Object.assign(new Error("Storage is shutting down — multipart assembly rejected"), { code: "STORAGE_SHUTDOWN" });
    }
    const contentType = this._pendingContentTypes.get(uploadId) ?? "video/mp4";
    this._pendingContentTypes.delete(uploadId);

    // ── Transactional assembly with advisory lock ──────────────────────────
    //
    // All validation, assembly, post-check, SHA-256 verification, and parts
    // cleanup run inside a single PostgreSQL transaction.  This eliminates:
    //
    //   1. Race: concurrent abortMultipartUpload deletes parts mid-assembly.
    //   2. Race: two concurrent completeMultipartUpload calls for the same
    //      uploadId double-assemble, producing a corrupt double-write.
    //   3. Partial state: if any step fails the transaction rolls back,
    //      leaving storage_blobs untouched (old partial blob deleted at the
    //      START of the transaction so a re-attempt starts clean).
    //   4. Zombie blob: a failed bytea_agg leaving a 0-byte row in
    //      storage_blobs that masquerades as a valid object.
    //
    // Advisory lock: pg_advisory_xact_lock(bigint) acquired at the start of
    // the transaction, auto-released at COMMIT/ROLLBACK.  The lock key is
    // derived from the uploadId so two concurrent assemblies of DIFFERENT
    // uploads never block each other.

    type PartRow = { part_number: number; size_bytes: number };

    let finalPartCount = 0;
    let finalTotalBytes = 0;

    const result = await db.transaction(async (tx) => {
      // ── 1. Advisory lock — one assembly at a time per uploadId ────────────
      // ('x' || right(md5(uploadId), 16))::bit(64)::bigint converts the last
      // 8 bytes of the MD5 into a bigint lock key.  This avoids hashtext()
      // IMMUTABLE issues and guarantees a unique key per uploadId.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(('x' || right(md5(${uploadId}), 16))::bit(64)::bigint)
      `);

      // ── 2. Load all parts and validate sequence/integrity ─────────────────
      // Select part_number + octet_length (not data!) — O(1) Node.js memory.
      const partRows = allRows<PartRow>(await tx.execute<PartRow>(sql`
        SELECT part_number, octet_length(data)::int AS size_bytes
        FROM storage_upload_parts
        WHERE upload_id = ${uploadId}
        ORDER BY part_number ASC
      `));

      const partCount = partRows.length;
      if (partCount === 0) {
        throw Object.assign(
          new Error(
            `completeMultipartUpload: no parts found in storage_upload_parts for ` +
            `uploadId=${uploadId} key=${key}. Parts may have been cleaned up already ` +
            `(idempotent re-call), never uploaded, or aborted concurrently.`,
          ),
          { code: "ASSEMBLY_NO_PARTS" },
        );
      }

      // Validate part_number sequence: must be 1, 2, 3 … N with no gaps.
      // A gap means a chunk was uploaded without a corresponding part row —
      // bytea_agg would silently skip it, producing a truncated blob.
      const gapParts: number[] = [];
      for (let i = 0; i < partRows.length; i++) {
        const expected = i + 1;
        const actual = partRows[i]!.part_number;
        if (actual !== expected) gapParts.push(expected);
      }
      if (gapParts.length > 0) {
        throw Object.assign(
          new Error(
            `Part sequence gap for uploadId=${uploadId} key=${key}: ` +
            `missing part_number(s) ${gapParts.slice(0, 10).join(", ")}` +
            (gapParts.length > 10 ? ` … and ${gapParts.length - 10} more` : "") +
            `. Parts must be contiguous starting from 1. Re-upload missing chunks to recover.`,
          ),
          { code: "ASSEMBLY_SEQUENCE_GAP" },
        );
      }

      // Validate all parts are non-empty. A zero-byte part means uploadPart()
      // wrote an empty Buffer to the DB — bytea_agg would produce a truncated blob.
      const emptyParts = partRows.filter((p) => p.size_bytes === 0);
      if (emptyParts.length > 0) {
        throw Object.assign(
          new Error(
            `${emptyParts.length} zero-byte part(s) detected: part_numbers=` +
            `${emptyParts.map((p) => p.part_number).join(",")} for uploadId=${uploadId}. ` +
            `Cannot assemble corrupt empty parts. Re-upload these chunks to recover.`,
          ),
          { code: "ASSEMBLY_EMPTY_PARTS" },
        );
      }

      const totalBytes = partRows.reduce((s, p) => s + p.size_bytes, 0);
      finalPartCount = partCount;
      finalTotalBytes = totalBytes;

      logger.info(
        { key, uploadId, partCount, totalBytes },
        "[storage] completeMultipartUpload: all parts validated — starting transactional assembly",
      );

      // ── 3. Delete any stale destination blob ──────────────────────────────
      // A previous failed assembly attempt may have left a partial or
      // zero-byte blob at this key.  Delete it unconditionally so the new
      // INSERT starts from a clean slate instead of overwriting via
      // ON CONFLICT (which could corrupt the row if bytea_agg returns NULL).
      await tx.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`);

      // ── 4. Assemble entirely inside PostgreSQL — zero bytes to Node.js ────
      // bytea_agg(data ORDER BY part_number) concatenates all parts in a
      // single server-side aggregate pass; the INSERT writes the result
      // directly into storage_blobs.  Peak Node.js RSS contribution: ~0.
      let usedFallback = false;
      try {
        await tx.execute(sql`
          INSERT INTO storage_blobs (key, content_type, size_bytes, data, updated_at)
          SELECT
            ${key}                                     AS key,
            ${contentType}                             AS content_type,
            SUM(octet_length(data))                    AS size_bytes,
            bytea_agg(data ORDER BY part_number)       AS data,
            NOW()                                      AS updated_at
          FROM storage_upload_parts
          WHERE upload_id = ${uploadId}
        `);
      } catch (aggErr) {
        const msg = String((aggErr as Error).message ?? "");
        const isMissingAggregate =
          msg.includes("bytea_agg") ||
          (msg.includes("does not exist") && msg.includes("function"));
        if (!isMissingAggregate) throw aggErr;
        // bytea_agg not yet installed (rare first-boot race) — fall back to
        // server-side iterative append (O(1) Node.js memory per part).
        logger.warn(
          { key, uploadId, partCount, totalBytes },
          "[storage] completeMultipartUpload: bytea_agg unavailable — using server-side iterative append fallback",
        );
        usedFallback = true;
      }

      if (usedFallback) {
        // Iterative server-side concatenation.  Each UPDATE reads one part
        // from storage_upload_parts and appends it to the growing blob —
        // no data crosses the Node.js/PostgreSQL boundary.
        // First part: INSERT the row.
        await tx.execute(sql`
          INSERT INTO storage_blobs (key, content_type, size_bytes, data, updated_at)
          SELECT ${key}, ${contentType}, 0, data, NOW()
          FROM storage_upload_parts
          WHERE upload_id = ${uploadId} AND part_number = 1
        `);
        // Subsequent parts: server-side append.
        for (let n = 2; n <= partCount; n++) {
          await tx.execute(sql`
            UPDATE storage_blobs
            SET data = data || (
              SELECT data FROM storage_upload_parts
              WHERE upload_id = ${uploadId} AND part_number = ${n}
            )
            WHERE key = ${key}
          `);
        }
        // Sync size_bytes once all parts are appended.
        await tx.execute(sql`
          UPDATE storage_blobs
          SET size_bytes = octet_length(data), updated_at = NOW()
          WHERE key = ${key}
        `);
      }

      // ── 5. Post-assembly integrity validation ─────────────────────────────
      // Verify both size_bytes (header field) and octet_length(data) (actual
      // stored bytes) are non-zero and equal.  A discrepancy means the
      // aggregate produced NULL or empty output and the INSERT/UPDATE succeeded
      // on zero matching rows.
      type SizeRow = { size_bytes: string; actual_length: string };
      const sizeRow = firstRow<SizeRow>(await tx.execute<SizeRow>(sql`
        SELECT size_bytes::text, octet_length(data)::text AS actual_length
        FROM storage_blobs
        WHERE key = ${key}
        LIMIT 1
      `));

      const recordedSize = parseInt(sizeRow?.size_bytes ?? "0", 10);
      const actualLength = parseInt(sizeRow?.actual_length ?? "0", 10);

      if (recordedSize === 0 || actualLength === 0) {
        throw Object.assign(
          new Error(
            `completeMultipartUpload: assembled blob is zero bytes ` +
            `(recorded=${recordedSize}, actual=${actualLength}) for key="${key}" ` +
            `uploadId=${uploadId} despite ${partCount} part(s) totaling ${totalBytes} B. ` +
            `Transaction rolled back — no partial blob committed. ` +
            `Possible cause: bytea_agg received NULL inputs or aggregate aggregate failed silently.`,
          ),
          { code: "ASSEMBLY_ZERO_BYTES" },
        );
      }

      if (actualLength !== totalBytes) {
        throw Object.assign(
          new Error(
            `Assembly size mismatch for key="${key}" uploadId=${uploadId}: ` +
            `expected ${totalBytes} B from ${partCount} parts, ` +
            `actual blob is ${actualLength} B. ` +
            `Transaction rolled back — the partial blob was not committed.`,
          ),
          { code: "ASSEMBLY_SIZE_MISMATCH" },
        );
      }

      // ── 6. End-to-end SHA-256 verification ───────────────────────────────
      // sha256(data) runs entirely inside PostgreSQL — only the 32-byte hash
      // is returned to Node.js (O(1) memory regardless of blob size).
      // This provides a cryptographic proof that the assembled file is a
      // byte-for-byte copy of the original, beyond per-chunk SHA-256 checks.
      if (expectedSha256) {
        type HashRow = { file_sha256: string };
        const hashRow = firstRow<HashRow>(await tx.execute<HashRow>(sql`
          SELECT encode(sha256(data), 'hex') AS file_sha256
          FROM storage_blobs
          WHERE key = ${key}
          LIMIT 1
        `));
        const actualSha256 = hashRow?.file_sha256 ?? "";
        if (actualSha256 !== expectedSha256.toLowerCase()) {
          throw Object.assign(
            new Error(
              `End-to-end SHA-256 mismatch for key="${key}" uploadId=${uploadId}: ` +
              `expected ${expectedSha256}, computed ${actualSha256}. ` +
              `The assembled file does not match the original source — possible data corruption ` +
              `in transit or reassembly. Transaction rolled back — no corrupt blob committed. ` +
              `Re-upload the file to recover.`,
            ),
            { code: "ASSEMBLY_CORRUPT_SOURCE" },
          );
        }
        logger.info(
          { key, uploadId, sha256: actualSha256 },
          "[storage] completeMultipartUpload: end-to-end SHA-256 verified ✓",
        );
      }

      // ── 7. Delete staging parts — inside the same transaction ────────────
      // Deleting inside the transaction is safe: if any subsequent step
      // fails the entire transaction rolls back, restoring the parts rows
      // so the next assembly attempt can re-read them.
      await tx.execute(sql`DELETE FROM storage_upload_parts WHERE upload_id = ${uploadId}`);

      const etag = `"${uploadId.slice(0, 8)}-${actualLength}"`;
      return { key, etag, location: this.publicUrl(key) };
    }); // ← transaction COMMIT; advisory lock auto-released

    logger.info(
      { key, uploadId, parts: finalPartCount, bytes: finalTotalBytes, sha256Verified: !!expectedSha256 },
      "[storage] completeMultipartUpload done (transactional) ✓",
    );
    return result;
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
