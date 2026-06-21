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

import os from "node:os";
import path from "node:path";
import { access, mkdir, writeFile, unlink, constants } from "node:fs/promises";
import { logger } from "./logger.js";
import { env } from "../config/env.js";

// ── Path resolution ───────────────────────────────────────────────────────────

function resolveStoragePaths() {
  const base = env.STORAGE_PATH;

  // FFmpeg transcoder scratch workspace.
  // Each job uses <scratch>/<jobId>/ — automatically cleaned up after the job.
  // Explicit TRANSCODER_SCRATCH_DIR > STORAGE_PATH/scratch > /tmp/transcoder
  const scratch =
    env.TRANSCODER_SCRATCH_DIR ??
    (base ? path.join(base, "scratch") : path.join(os.tmpdir(), "transcoder"));

  // Broadcast-state tertiary disk backup.
  // Explicit BROADCAST_STATE_BACKUP_PATH (only when set by operator, not when
  // it is the Zod-injected default) > STORAGE_PATH > /tmp
  const stateBackupFromEnv = process.env["BROADCAST_STATE_BACKUP_PATH"];
  const stateBackup = stateBackupFromEnv ?? (base ?? "/tmp");

  // Broadcast-queue secondary disk backup.
  // Explicit BROADCAST_QUEUE_BACKUP_DIR > STORAGE_PATH > /tmp
  const queueBackupFromEnv = process.env["BROADCAST_QUEUE_BACKUP_DIR"];
  const queueBackup = queueBackupFromEnv ?? (base ?? "/tmp");

  // Informational media paths — actual content is in PostgreSQL.
  const uploads = env.UPLOAD_DIR ?? (base ? path.join(base, "uploads") : null);
  const hls = env.HLS_DIR ?? (base ? path.join(base, "hls") : null);
  const thumbnails = env.THUMBNAIL_DIR ?? (base ? path.join(base, "thumbnails") : null);

  return { base: base ?? null, scratch, stateBackup, queueBackup, uploads, hls, thumbnails };
}

export const storagePaths = resolveStoragePaths();

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Create all required storage directories and validate they are writable.
 * Called once during server startup, before any services that use the paths.
 *
 * Non-fatal: a failed directory creation logs an error but never prevents
 * the server from booting — the transcoder and broadcast engine have their
 * own graceful-degradation paths.
 */
export async function ensureStorageDirectories(): Promise<void> {
  const dirsToEnsure: Array<{ path: string; label: string; critical: boolean }> = [
    { path: storagePaths.scratch, label: "transcoder scratch", critical: false },
    { path: storagePaths.stateBackup, label: "broadcast state backup", critical: false },
    { path: storagePaths.queueBackup, label: "broadcast queue backup", critical: false },
  ];

  // When STORAGE_PATH is set, also create the informational subdirs.
  if (storagePaths.base) {
    if (storagePaths.uploads)    dirsToEnsure.push({ path: storagePaths.uploads,    label: "uploads dir",    critical: false });
    if (storagePaths.hls)        dirsToEnsure.push({ path: storagePaths.hls,        label: "hls dir",        critical: false });
    if (storagePaths.thumbnails) dirsToEnsure.push({ path: storagePaths.thumbnails, label: "thumbnails dir", critical: false });
  }

  // Deduplicate: multiple paths might resolve to the same directory (e.g.
  // stateBackup and queueBackup both default to /tmp).
  const seen = new Set<string>();
  const unique = dirsToEnsure.filter((d) => {
    if (seen.has(d.path)) return false;
    seen.add(d.path);
    return true;
  });

  const results: Array<{ path: string; label: string; ok: boolean; writable: boolean; error?: string }> = [];

  for (const dir of unique) {
    let ok = false;
    let writable = false;
    let errorMsg: string | undefined;

    try {
      await mkdir(dir.path, { recursive: true });
      ok = true;
    } catch (err) {
      errorMsg = (err as Error).message;
      logger.error(
        { err, dir: dir.path, label: dir.label },
        `[storage-paths] failed to create ${dir.label} directory`,
      );
    }

    if (ok) {
      // Write-permission probe: create a temp file and delete it.
      const probe = path.join(dir.path, `.write-probe-${process.pid}`);
      try {
        await writeFile(probe, "probe", "utf-8");
        await unlink(probe);
        writable = true;
      } catch (err) {
        errorMsg = (err as Error).message;
        logger.error(
          { err, dir: dir.path, label: dir.label },
          `[storage-paths] ${dir.label} directory exists but is NOT writable`,
        );
      }
    }

    results.push({ path: dir.path, label: dir.label, ok, writable, error: errorMsg });
  }

  const allOk = results.every((r) => r.ok && r.writable);
  const summary = results.map((r) => ({
    label: r.label,
    path: r.path,
    status: r.ok && r.writable ? "ok" : r.ok ? "not-writable" : "create-failed",
  }));

  if (allOk) {
    logger.info(
      { storagePath: storagePaths.base ?? "(system defaults)", dirs: summary },
      "[storage-paths] all storage directories ready",
    );
  } else {
    logger.warn(
      { dirs: summary },
      "[storage-paths] one or more storage directories could not be created or written — " +
      "transcoder and broadcast state persistence may be degraded; set STORAGE_PATH to a writable mount",
    );
  }
}

/**
 * Log the resolved storage path configuration on startup.
 * Useful for verifying that STORAGE_PATH and individual overrides were picked
 * up correctly when deploying to a new environment.
 */
export function logStoragePathConfig(): void {
  logger.info(
    {
      STORAGE_PATH: storagePaths.base ?? "(not set — using system defaults)",
      scratch: storagePaths.scratch,
      stateBackup: storagePaths.stateBackup,
      queueBackup: storagePaths.queueBackup,
      uploads: storagePaths.uploads ?? "(informational — media is in PostgreSQL)",
      hls: storagePaths.hls ?? "(informational — media is in PostgreSQL)",
      thumbnails: storagePaths.thumbnails ?? "(informational — media is in PostgreSQL)",
    },
    "[storage-paths] resolved storage path configuration",
  );
}
