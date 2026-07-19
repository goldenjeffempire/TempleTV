/**
 * Persistent storage path resolution for Render Disk (and any other mounted
 * volume / local filesystem deployment).
 *
 * Media content (uploads, HLS segments, thumbnails) is stored as PostgreSQL
 * BYTEA blobs and never disappears after a container restart.  This module
 * manages the *filesystem* paths that the API process itself uses for:
 *
 *   scratch   — FFmpeg workspace during transcoding.  Each job creates a
 *               sub-directory, writes segments / playlists there, uploads them
 *               to PostgreSQL, then deletes the sub-directory.  On Render the
 *               container /tmp is often only 500 MB — insufficient for a full
 *               1080p encode (~4× source size).  Pointing this at a Render
 *               Disk (/var/data) removes that ceiling.
 *
 *   stateBackup — Tertiary broadcast-state snapshot JSON (primary + secondary
 *                 copies are in PostgreSQL).  Benefit from persistence across
 *                 container restarts so the orchestrator can hydrate state even
 *                 during a brief DB outage at startup.
 *
 *   queueBackup — Secondary broadcast-queue snapshot JSON (same rationale).
 *
 *   uploads / hls / thumbnails — Informational / future-use paths. Actual
 *                 media is stored in PostgreSQL; these paths are documented and
 *                 created so operators have a place to put local overrides or
 *                 CDN-cache warm-up scripts without code changes.
 *
 * Path resolution priority (highest → lowest):
 *   1. Explicit env var for that path (e.g. TRANSCODER_SCRATCH_DIR)
 *   2. Derived from STORAGE_PATH (e.g. $STORAGE_PATH/scratch)
 *   3. System default (/tmp/transcoder, /tmp)
 *
 * Render Disk quick-start:
 *   Set STORAGE_PATH=/var/data in your Render service's Environment Variables.
 *   All paths will automatically derive from that mount point.
 *   Optionally set individual overrides (TRANSCODER_SCRATCH_DIR etc.) to
 *   customise further.
 */
export declare const storagePaths: {
    base: string | null;
    scratch: string;
    stateBackup: string;
    queueBackup: string;
    uploads: string | null;
    hls: string | null;
    thumbnails: string | null;
};
/**
 * Create all required storage directories and validate they are writable.
 * Called once during server startup, before any services that use the paths.
 *
 * Non-fatal: a failed directory creation logs an error but never prevents
 * the server from booting — the transcoder and broadcast engine have their
 * own graceful-degradation paths.
 */
export declare function ensureStorageDirectories(): Promise<void>;
/**
 * Sweep stale temp directories from storagePaths.scratch.
 *
 * Removes any subdirectory whose name matches STALE_DIR_PATTERN and whose
 * mtime is older than maxAgeMs (default: 2 h for startup, 30 min for
 * emergency disk-pressure sweeps triggered by the disk watchdog).
 *
 * Returns the count of directories removed.  Non-fatal: per-dir failures are
 * swallowed so one stuck directory never prevents the rest from being cleaned.
 */
export declare function sweepStaleTempDirs(opts?: {
    maxAgeMs?: number;
}): Promise<number>;
/**
 * Log the resolved storage path configuration on startup.
 * Useful for verifying that STORAGE_PATH and individual overrides were picked
 * up correctly when deploying to a new environment.
 */
export declare function logStoragePathConfig(): void;
