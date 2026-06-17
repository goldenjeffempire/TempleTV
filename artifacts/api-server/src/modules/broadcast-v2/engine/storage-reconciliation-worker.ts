/**
 * Storage Reconciliation Worker
 *
 * Runs every STORAGE_RECONCILIATION_INTERVAL_MS (default 10 min) and performs
 * continuous DB-to-storage reconciliation for every active broadcast_queue item.
 *
 * Algorithm — batch, not per-item-headObject:
 *   1. Load all active queue items with their objectPath (MP4 source) and videoId.
 *   2. Derive the full set of expected storage keys:
 *      • HLS:  transcoded/{videoId}/master.m3u8  (for items with hlsMasterUrl or hls_ready)
 *      • MP4:  the bare storage key from objectPath  (for local-upload items)
 *   3. Single batch query against storage_blobs for all expected keys.
 *   4. Compute gaps = expected keys absent from storage_blobs.
 *   5. For each gapped item: call storageBlobRecoveryService.runWaterfall() to
 *      re-transcode (tier1/2) or quarantine (tier3).
 *   6. Run orphaned-blob scan (blobs in storage_blobs with no managed_videos row).
 *
 * Metrics tracked per pass: itemsChecked, blobsVerified, gapsFound, recoveries.
 * All exposed via storageBlobRecoveryService.getStats() → /readyz storageReconciliation.
 *
 * Non-fatal: DB/storage errors are caught and logged; the pass aborts cleanly.
 */
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { storageBlobRecoveryService } from "./storage-blob-recovery.service.js";

const MODULE = "[storage-reconciliation]";

/** Derive a bare storage key from objectPath (strips URL prefix). */
function toStorageKey(objectPath: string): string {
  if (/^https?:\/\//i.test(objectPath)) {
    const marker = "/api/v1/uploads/";
    const idx = objectPath.indexOf(marker);
    return idx === -1 ? "" : objectPath.slice(idx + marker.length);
  }
  if (objectPath.startsWith("/")) {
    return objectPath.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
  }
  return objectPath;
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

  // ── Step 1: Load all active queue items ────────────────────────────────────
  let rows: ReconciliationRow[];
  try {
    const raw = await db.execute<Record<string, unknown>>(sql`
      SELECT
        bq.id          AS "queueId",
        bq.video_id    AS "videoId",
        bq.title       AS "title",
        bq.hls_master_url   AS "qHlsUrl",
        mv.hls_master_url   AS "vHlsUrl",
        mv.object_path      AS "vObjectPath",
        mv.transcoding_status AS "vTranscodingStatus"
      FROM broadcast_queue bq
      INNER JOIN managed_videos mv ON mv.id = bq.video_id
      WHERE bq.is_active = true
        AND bq.video_id IS NOT NULL
      ORDER BY bq.sort_order
    `);
    rows = raw.rows as unknown as ReconciliationRow[];
  } catch (err) {
    logger.warn({ err }, `${MODULE} DB query failed — skipping pass (non-fatal)`);
    return;
  }

  if (rows.length === 0) {
    logger.debug(`${MODULE} no active queue items — pass complete (empty)`);
    storageBlobRecoveryService.recordPassEnd(Date.now() - startMs, 0, 0, 0, 0);
    return;
  }

  // ── Step 2: Build expected storage key sets ────────────────────────────────
  // Items eligible for MP4 verification: have objectPath (local upload source)
  // and are NOT hls_ready (hls_ready items are covered by HLS check below).
  // External URLs (http/https without /api/ paths) are skipped.
  const mp4Items: Array<{ row: ReconciliationRow; key: string }> = [];
  const hlsItems: Array<{ row: ReconciliationRow; key: string }> = [];

  for (const row of rows) {
    if (!row.videoId) continue;
    const hlsUrl = row.qHlsUrl || row.vHlsUrl;

    // HLS: expect transcoded/{videoId}/master.m3u8 for hls_ready items
    if (hlsUrl || row.vTranscodingStatus === "hls_ready") {
      hlsItems.push({ row, key: `transcoded/${row.videoId}/master.m3u8` });
    }

    // MP4: expect blob at objectPath for local-upload items that aren't hls_ready
    if (row.vObjectPath && row.vTranscodingStatus !== "hls_ready") {
      const key = toStorageKey(row.vObjectPath);
      if (key && !key.startsWith("http")) {
        mp4Items.push({ row, key });
      }
    }
  }

  const allExpectedKeys = [
    ...hlsItems.map((i) => i.key),
    ...mp4Items.map((i) => i.key),
  ];
  const uniqueKeys = [...new Set(allExpectedKeys)];

  // ── Step 3: Batch query storage_blobs for all expected keys ────────────────
  let presentKeys = new Set<string>();
  const blobsVerified = uniqueKeys.length;

  if (uniqueKeys.length > 0) {
    try {
      const presentRows = await db
        .select({ key: schema.storageBlobsTable.key })
        .from(schema.storageBlobsTable)
        .where(inArray(schema.storageBlobsTable.key, uniqueKeys));
      presentKeys = new Set(presentRows.map((r) => r.key));
    } catch (err) {
      logger.warn({ err }, `${MODULE} storage_blobs batch query failed — skipping gap detection`);
      storageBlobRecoveryService.recordPassEnd(Date.now() - startMs, rows.length, blobsVerified, 0, 0);
      return;
    }
  }

  // ── Step 4: Find gaps and trigger recovery ─────────────────────────────────
  // Deduplicate: one video can appear in both mp4Items and hlsItems; run
  // waterfall at most once per videoId per pass.
  const processed = new Set<string>();
  let gapsFound = 0;
  let recoveries = 0;

  // Process HLS gaps first (higher priority — HLS is the preferred playback source)
  for (const { row, key } of hlsItems) {
    if (!row.videoId || processed.has(row.videoId)) continue;
    if (presentKeys.has(key)) continue; // blob present — healthy

    processed.add(row.videoId);
    gapsFound += 1;

    const hlsUrl = row.qHlsUrl || row.vHlsUrl;
    const result = await storageBlobRecoveryService.runWaterfall({
      videoId: row.videoId,
      queueId: row.queueId,
      title: row.title,
      objectPath: row.vObjectPath,
      hlsUrl,
      triggeredBy: MODULE,
    });

    if (result.tier !== "error") recoveries += 1;
    if (result.tier !== "healthy") {
      logger.warn({ videoId: row.videoId, queueId: row.queueId, tier: result.tier, missingKey: key }, `${MODULE} HLS gap — recovery action taken`);
    }
  }

  // Process MP4 gaps (items that rely on the MP4 source blob)
  for (const { row, key } of mp4Items) {
    if (!row.videoId || processed.has(row.videoId)) continue;
    if (presentKeys.has(key)) continue; // blob present — healthy

    processed.add(row.videoId);
    gapsFound += 1;

    const hlsUrl = row.qHlsUrl || row.vHlsUrl;
    const result = await storageBlobRecoveryService.runWaterfall({
      videoId: row.videoId,
      queueId: row.queueId,
      title: row.title,
      objectPath: row.vObjectPath,
      hlsUrl,
      triggeredBy: MODULE,
    });

    if (result.tier !== "error") recoveries += 1;
    if (result.tier !== "healthy") {
      logger.warn({ videoId: row.videoId, queueId: row.queueId, tier: result.tier, missingKey: key }, `${MODULE} MP4 gap — recovery action taken`);
    }
  }

  // ── Step 5: Library-wide HLS integrity check (non-queued videos) ──────────
  // Checks managed_videos rows with hls_master_url set and hls_ready status
  // that are NOT currently in the active queue.  If their master.m3u8 blob is
  // missing, runs the recovery waterfall proactively — before these videos
  // enter the queue and cause broadcast failures.  This closes the window
  // where a video could sit in the library with a stale hlsMasterUrl and
  // zero blobs, undetected until the queue-health-guard admits it.
  //
  // Capped at STORAGE_RECON_LIBRARY_BATCH rows per pass (default 200) to
  // bound per-pass duration on large libraries.  Active queue items (already
  // checked in Steps 3–4 above) are excluded via the NOT IN guard so there
  // is no double-processing.
  const activeVideoIdSet = new Set(rows.map((r) => r.videoId).filter(Boolean));
  let libraryItemsChecked = 0;
  let libraryGapsFound = 0;
  let libraryRecoveries = 0;

  try {
    const libraryBatch = env.STORAGE_RECON_LIBRARY_BATCH;

    const libraryResult = await db.execute<{
      videoId: string;
      title: string;
      objectPath: string | null;
      hlsUrl: string | null;
    }>(sql`
      SELECT
        mv.id             AS "videoId",
        mv.title          AS "title",
        mv.object_path    AS "objectPath",
        mv.hls_master_url AS "hlsUrl"
      FROM managed_videos mv
      WHERE mv.hls_master_url IS NOT NULL
        AND mv.transcoding_status = 'hls_ready'
        AND mv.s3_mirrored_at IS NOT NULL
        AND mv.video_source != 'youtube'
        AND mv.transcoding_error_code IS NULL
      ORDER BY mv.updated_at DESC NULLS LAST
      LIMIT ${libraryBatch}
    `);

    type LibRow = { videoId: string; title: string; objectPath: string | null; hlsUrl: string | null };
    const nonQueuedRows = (libraryResult.rows as LibRow[]).filter(
      (r) => !activeVideoIdSet.has(r.videoId),
    );
    libraryItemsChecked = nonQueuedRows.length;

    if (nonQueuedRows.length > 0) {
      // Batch presence check for master.m3u8 keys
      const masterKeys = nonQueuedRows.map((r) => `transcoded/${r.videoId}/master.m3u8`);
      const presentMasters = await db
        .select({ key: schema.storageBlobsTable.key })
        .from(schema.storageBlobsTable)
        .where(inArray(schema.storageBlobsTable.key, masterKeys))
        .catch(() => [] as { key: string }[]);
      const presentMasterSet = new Set(presentMasters.map((r) => r.key));

      for (const libRow of nonQueuedRows) {
        const masterKey = `transcoded/${libRow.videoId}/master.m3u8`;
        if (presentMasterSet.has(masterKey)) continue;

        // Non-queued library video has hls_ready status but no master.m3u8 blob.
        libraryGapsFound += 1;
        const result = await storageBlobRecoveryService.runWaterfall({
          videoId: libRow.videoId,
          queueId: "",
          title: libRow.title,
          objectPath: libRow.objectPath,
          hlsUrl: libRow.hlsUrl,
          triggeredBy: `${MODULE}:library-pass`,
        });
        if (result.tier !== "error") libraryRecoveries += 1;
        logger.warn(
          { videoId: libRow.videoId, tier: result.tier, message: result.message },
          `${MODULE} library-wide HLS gap — recovery action taken`,
        );
      }
    }
  } catch (libErr) {
    logger.warn({ err: libErr }, `${MODULE} library-wide HLS integrity pass failed (non-fatal)`);
  }

  // ── Step 6: Orphaned blob scan ─────────────────────────────────────────────
  await storageBlobRecoveryService.scanOrphanedBlobs();

  // ── Step 7: Record and log pass metrics ────────────────────────────────────
  const elapsedMs = Date.now() - startMs;
  storageBlobRecoveryService.recordPassEnd(elapsedMs, rows.length, blobsVerified, gapsFound, recoveries);

  const stats = storageBlobRecoveryService.getStats();
  logger.info(
    {
      itemsChecked: stats.itemsChecked,
      blobsVerified: stats.blobsVerified,
      gapsFound: stats.gapsFound,
      recoveries: stats.recoveries,
      orphanedBlobCount: stats.orphanedBlobCount,
      deletedOrphanBlobCount: stats.deletedOrphanBlobCount,
      hlsItems: hlsItems.length,
      mp4Items: mp4Items.length,
      libraryItemsChecked,
      libraryGapsFound,
      libraryRecoveries,
      elapsedMs,
    },
    `${MODULE} reconciliation pass complete`,
  );
}

export const storageReconciliationWorker = {
  run: runReconciliationPass,
};
