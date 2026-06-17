/**
 * Storage Reconciliation Worker
 *
 * Runs every STORAGE_RECONCILIATION_INTERVAL_MS (default 10 min) and
 * reconciles every active broadcast_queue item's referenced storage blobs
 * against what actually exists in storage_blobs.
 *
 * The recovery waterfall is fully delegated to StorageBlobRecoveryService,
 * which is the canonical single-place implementation of the 3-tier logic:
 *
 *   Tier 1 — HLS segment blobs exist but master.m3u8 missing
 *     a. MP4 source present → re-enqueue transcoding at priority 8
 *     b. MP4 source absent  → ops-alert; let media scanner probe
 *   Tier 2 — No HLS blobs but MP4 objectPath blob present
 *     → re-enqueue for transcoding at priority 5
 *   Tier 3 — No blobs at all (HLS + MP4 source gone)
 *     → quarantineVideo() + SOURCE_MISSING + ops-alert
 *
 * Additionally runs an orphaned-blob scan each pass to surface storage_blobs
 * entries that have no corresponding managed_videos row.
 *
 * Non-fatal: any DB/storage error is caught and logged.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { storageBlobRecoveryService } from "./storage-blob-recovery.service.js";

const MODULE = "[storage-reconciliation]";

/** Maximum items to reconcile per pass (prevents runaway scans on huge queues). */
const MAX_ITEMS_PER_PASS = 500;

/** Per-video cooldown: don't re-run recovery for the same videoId within this window. */
const RECOVERY_COOLDOWN_MS = 30 * 60_000; // 30 minutes

/** In-memory cooldown map: videoId → last-recovery wall-clock ms. */
const recoveryCooldown = new Map<string, number>();

function isOnCooldown(videoId: string): boolean {
  const last = recoveryCooldown.get(videoId);
  if (!last) return false;
  return Date.now() - last < RECOVERY_COOLDOWN_MS;
}

function markRecovered(videoId: string): void {
  recoveryCooldown.set(videoId, Date.now());
  if (recoveryCooldown.size > 2000) {
    const cutoff = Date.now() - RECOVERY_COOLDOWN_MS;
    for (const [id, ts] of recoveryCooldown.entries()) {
      if (ts < cutoff) recoveryCooldown.delete(id);
    }
  }
}

interface ReconciliationRow {
  queueId: string;
  videoId: string;
  title: string;
  qHlsUrl: string | null;
  vHlsUrl: string | null;
  vObjectPath: string | null;
  vTranscodingStatus: string | null;
}

async function runReconciliationPass(): Promise<void> {
  const startMs = Date.now();
  storageBlobRecoveryService.recordPassStart();

  const q = schema.broadcastQueueTable;
  const v = schema.videosTable;

  let rows: ReconciliationRow[];
  try {
    const raw = await db
      .select({
        queueId: q.id,
        videoId: q.videoId,
        title: q.title,
        qHlsUrl: q.hlsMasterUrl,
        vHlsUrl: v.hlsMasterUrl,
        vObjectPath: v.objectPath,
        vTranscodingStatus: v.transcodingStatus,
      })
      .from(q)
      .innerJoin(v, eq(q.videoId, v.id))
      .where(
        and(
          eq(q.isActive, true),
          isNotNull(q.videoId),
        ),
      )
      .orderBy(q.sortOrder)
      .limit(MAX_ITEMS_PER_PASS) as ReconciliationRow[];
    rows = raw;
  } catch (err) {
    logger.warn({ err }, `${MODULE} DB query failed — skipping pass (non-fatal)`);
    return;
  }

  if (rows.length === 0) {
    logger.debug(`${MODULE} no active queue items with video joins — pass complete (empty)`);
    const elapsedMs = Date.now() - startMs;
    storageBlobRecoveryService.recordPassEnd(elapsedMs);
    return;
  }

  let skipped = 0;

  for (const row of rows) {
    if (!row.videoId) continue;
    const videoId = row.videoId;
    const hlsUrl = row.qHlsUrl || row.vHlsUrl;

    // Only reconcile items that claim to have HLS or a local MP4 source.
    // External-URL-only items (YouTube, etc.) have no storage blobs to check.
    const hasHlsUrl = !!hlsUrl;
    const hasObjectPath = !!row.vObjectPath;
    if (!hasHlsUrl && !hasObjectPath) {
      skipped += 1;
      continue;
    }

    if (isOnCooldown(videoId)) {
      skipped += 1;
      continue;
    }

    const result = await storageBlobRecoveryService.runWaterfall({
      videoId,
      queueId: row.queueId,
      title: row.title,
      objectPath: row.vObjectPath,
      hlsUrl,
      triggeredBy: MODULE,
    });

    if (result.tier !== "healthy") {
      markRecovered(videoId);
      logger.warn({ videoId, queueId: row.queueId, tier: result.tier, message: result.message }, `${MODULE} recovery action taken`);
    }
  }

  // Orphaned blob scan: blobs in storage_blobs with no managed_videos row.
  await storageBlobRecoveryService.scanOrphanedBlobs(200);

  const elapsedMs = Date.now() - startMs;
  const stats = storageBlobRecoveryService.getStats();
  logger.info(
    {
      checked: stats.checked,
      healthy: stats.healthy,
      tier1Retranscode: stats.tier1RetranscodeTotal,
      tier1Alert: stats.tier1AlertTotal,
      tier2: stats.tier2Total,
      tier3: stats.tier3Total,
      orphaned: stats.orphanedBlobsTotal,
      skipped,
      elapsedMs,
      totalRows: rows.length,
    },
    `${MODULE} reconciliation pass complete`,
  );
  storageBlobRecoveryService.recordPassEnd(elapsedMs);
}

export const storageReconciliationWorker = {
  run: runReconciliationPass,
};
