/**
 * Disk-level tertiary broadcast state backup.
 *
 * The primary state store is PostgreSQL (runtime_state + player_position_checkpoint).
 * This module writes a lightweight JSON snapshot to disk (default /tmp) as a
 * tertiary fallback for hydrate() when both DB reads fail (e.g. full DB outage
 * at restart time).
 *
 * Write path: called inside persistCheckpoint() after the DB write succeeds.
 * Read path:  called inside hydrate() as a final fallback when DB rows are absent.
 *
 * File: BROADCAST_STATE_BACKUP_PATH/<channelId>-state.json
 * Default dir: /tmp (always writable in Node.js containers).
 *
 * Failures are always non-fatal — the orchestrator continues without disk backup.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../../../infrastructure/logger.js";
import { storagePaths } from "../../../infrastructure/storage-paths.js";

const BACKUP_DIR = storagePaths.stateBackup;

function filePath(channelId: string): string {
  return path.join(BACKUP_DIR, `broadcast-state-${channelId}.json`);
}

export interface DiskStateSnapshot {
  channelId: string;
  savedAtMs: number;
  sequence: number;
  mode: string;
  currentItemId: string | null;
  startedAtMs: number | null;
  positionMs: number;
  failoverActive: boolean;
  failoverReason: string | null;
}

/**
 * Persist a state snapshot to disk.  Non-throwing — any I/O error is warned only.
 */
export async function saveDiskBackup(snap: DiskStateSnapshot): Promise<void> {
  try {
    const data = JSON.stringify({ ...snap, savedAtMs: Date.now() }, null, 2);
    await fs.writeFile(filePath(snap.channelId), data, "utf-8");
  } catch (err) {
    logger.warn({ err, channelId: snap.channelId }, "[disk-backup] write failed (non-fatal)");
  }
}

/**
 * Load the most recently saved disk snapshot for a channel.
 * Returns null when the file does not exist, is corrupt, or is older than maxAgeMs.
 */
export async function loadDiskBackup(
  channelId: string,
  maxAgeMs = 4 * 60 * 60 * 1000, // 4 h — covers long deployment queue waits
): Promise<DiskStateSnapshot | null> {
  try {
    const raw = await fs.readFile(filePath(channelId), "utf-8");
    const snap = JSON.parse(raw) as DiskStateSnapshot;
    if (!snap || snap.channelId !== channelId) return null;
    const age = Date.now() - (snap.savedAtMs ?? 0);
    if (age > maxAgeMs) {
      logger.warn({ channelId, ageMs: age, maxAgeMs }, "[disk-backup] snapshot too old — ignoring");
      return null;
    }
    logger.info({ channelId, savedAtMs: snap.savedAtMs, ageMs: age }, "[disk-backup] loaded disk backup");
    return snap;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err, channelId }, "[disk-backup] read failed (non-fatal)");
    }
    return null;
  }
}

/**
 * Delete the disk backup for a channel.  Non-throwing.
 * Call when the broadcast finishes cleanly so a stale file cannot cause
 * a wrong restore after a long period of inactivity.
 */
export async function deleteDiskBackup(channelId: string): Promise<void> {
  try {
    await fs.unlink(filePath(channelId));
  } catch {
    // File may not exist — silently ignore.
  }
}
