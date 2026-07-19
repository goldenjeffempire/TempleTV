/**
 * Upload Integrity Monitor — Enterprise-Grade Production Rewrite
 *
 * Background worker that periodically scans storage for anomalies the hot-path
 * guards cannot catch after the fact.
 *
 * Philosophy: VERIFY-AND-SELF-HEAL FIRST, destroy only as a last resort.
 * Every anomaly is first checked for lossless recoverability (are the upload
 * parts still staged?) and rebuilt via the normal reassembly path when
 * possible. A video is permanently failed only when no parts remain to
 * recover from — the monitor's primary job is to keep healthy uploads
 * healthy, not to clean up corruption.
 *
 * Scans:
 *   1. Corrupt blobs — storage_blobs rows where size_bytes = 0 or data IS NULL.
 *      Avoided the original octet_length(data) full-BYTEA-scan: the recorded
 *      size_bytes column is used for fast detection; a bounded mismatch check
 *      runs only if time budget permits, with a hard DB-level statement timeout.
 *      Recoverable blobs (upload parts still staged) are rebuilt via session
 *      reset; only truly unrecoverable blobs are deleted + marked CORRUPT_SOURCE.
 *
 *   2. Videos with confirmed blob reference (s3MirroredAt IS NOT NULL) but no
 *      matching row in storage_blobs — these produce a 404 on every playback
 *      request. If upload parts are present they are reset for auto-reassembly;
 *      otherwise the video is permanently marked ASSEMBLY_FAILED.
 *
 *   3. Orphaned storage_upload_parts — BYTEA rows whose upload_id has no active
 *      upload session. Each row is ≤ 8 MiB; orphans waste real PostgreSQL
 *      storage. Completely removed the original SUM(octet_length(data)) full
 *      BYTEA table scan; size is now estimated from COUNT × max-chunk-size.
 *
 * Production guarantees:
 *   • Every DB query is bounded by a hard client-side deadline + DB-level
 *     statement_timeout so a lock wait or slow sequential scan cannot block
 *     the shared connection pool indefinitely.
 *   • All three passes receive a shared deadline derived from the worker
 *     supervisor's 10-minute hard limit; each pass checks the deadline between
 *     row iterations and exits gracefully when time runs out.
 *   • Per-item remediation is wrapped in individual try/catch — one bad row
 *     never aborts the rest of the pass.
 *   • No BYTEA columns are read to compute sizes in the orphaned-parts scan.
 *   • The mismatch-size scan (the only remaining octet_length query) runs with
 *     a dedicated 25-second DB statement_timeout and is only attempted when the
 *     overall pass has at least 30 s of budget remaining.
 *   • The all-failed re-throw is replaced with per-pass tracking so the
 *     supervisor's circuit breaker counts correctly.
 *
 * Registered in main.ts via workerSupervisor.spawn():
 *   interval: 30 min, initial delay: 5 min, timeout: 10 min.
 */
/**
 * Reassembly availability check — shared self-healing primitive.
 *
 * Given a video id, locate its upload session and count how many BYTEA parts
 * remain in storage_upload_parts. A video is *recoverable* when at least
 * `total_chunks` parts are still staged: the existing reassembly path can
 * rebuild a fully-verified blob from them with zero data loss.
 *
 * Returns null when no session/upload_id exists (nothing to recover from).
 * The per-part non-empty / sequence / SHA-256 validation is re-run inside
 * completeMultipartUpload during the actual reassembly, so a count ≥ total
 * is a sufficient (and cheap, BYTEA-free) pre-check here.
 */
export declare function findReassemblyContext(videoId: string): Promise<{
    sessionId: string;
    uploadId: string;
    totalChunks: number;
    partsPresent: number;
    recoverable: boolean;
} | null>;
export declare function runUploadIntegrityScan(): Promise<void>;
