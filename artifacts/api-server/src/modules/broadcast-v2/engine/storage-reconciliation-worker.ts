/**
 * Storage Reconciliation Worker
 *
 * Runs every STORAGE_RECONCILIATION_INTERVAL_MS (default 10 min) and performs
 * continuous bidirectional DB↔storage reconciliation for every active broadcast
 * queue item plus a rolling library-wide pass.
 *
 * ─── What changed from the legacy 3-pass system ──────────────────────────────
 *
 * The legacy worker used a simple 3-tier waterfall that quarantined any item
 * whose blobs were absent from storage_blobs after a single pass.  This caused
 * false-positive SOURCE_MISSING quarantines on videos that were perfectly
 * healthy but had an external or YouTube-sourced HLS URL, an objectPath stored
 * in a non-standard format, or blobs temporarily absent due to a DB glitch.
 *
 * This redesign eliminates all known false-positive sources:
 *
 *   Source classification  — External HLS URLs and YouTube video_source rows
 *     skip storage checks entirely.  They have no local storage_blobs entries
 *     by design.  Items with sourceCleanupStatus='deleted' skip the MP4
 *     objectPath check since the blob was intentionally removed after HLS.
 *
 *   Size-validated presence — The batch storage_blobs presence query now
 *     requires size_bytes > 0 (when STORAGE_RECON_SIZE_CHECK=true, default).
 *     Zero-byte blobs produced by interrupted putObject calls look "present"
 *     in the DB but cannot be served.  They are now treated as absent and
 *     the recovery waterfall is triggered just as if the key was missing.
 *
 *   Retry-gated quarantine — The recovery service (StorageBlobRecoveryService)
 *     maintains a per-videoId consecutive-gap counter and only quarantines after
 *     STORAGE_RECON_QUARANTINE_MIN_FAILURES consecutive failing passes (default 3).
 *     A single transient gap emits a warn ops-alert but causes no permanent damage.
 *
 *   ON_AIR broadcast safety — The recovery service never quarantines an item
 *     whose queue row is the current ON_AIR item in broadcast_runtime_state.
 *
 * ─── Algorithm ───────────────────────────────────────────────────────────────
 *
 *  Pass A — Active queue items (broadcast_queue WHERE is_active=true)
 *    1. Load all active items with classification columns
 *       (video_source, source_cleanup_status).
 *    2. Classify each item's expected storage keys:
 *       • HLS: transcoded/{videoId}/master.m3u8 — only for own-server HLS URLs
 *         (relative, or absolute containing /api/hls/{videoId}/).  External
 *         CDN / YouTube URLs are skipped to avoid false "missing blob" gaps.
 *       • MP4: bare key from objectPath — skipped when:
 *           - video_source = 'youtube'
 *           - objectPath is absent or an external URL
 *           - source_cleanup_status = 'deleted' (MP4 intentionally removed
 *             after successful HLS transcoding — missing by design)
 *    3. Batch query storage_blobs for all expected keys with size_bytes > 0.
 *    4. For gapped items run StorageBlobRecoveryService.runWaterfall().
 *
 *  Pass B — Library-wide HLS integrity (non-queued hls_ready videos)
 *    Checks managed_videos rows with hls_master_url + hls_ready + s3MirroredAt
 *    that are NOT in the active queue.  Same classification + size-check rules.
 *
 *  Pass C — Orphaned blob scan
 *    Finds transcoded/ and uploads/ blobs with no managed_videos row and
 *    auto-deletes them when old enough (ORPHAN_BLOB_MIN_AGE_HOURS, default 7d).
 *    Also reports zero-byte blobs as a separate health signal.
 *
 * Non-fatal: DB/storage errors are caught and logged; the pass aborts cleanly.
 */
import { and, inArray, gt, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { storageBlobRecoveryService } from "./storage-blob-recovery.service.js";
import { normalizeQueueUrl, markUrlBadBySource } from "../repository/queue.repo.js";

const MODULE = "[storage-reconciliation]";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the given HLS URL is served by this API server.
 * Relative URLs are always own-server.  Absolute URLs must contain
 * /api/hls/{videoId}/ or /api/v1/hls/{videoId}/ to be considered local.
 * Anything else (CDN, YouTube, third-party stream) is external and has no
 * storage_blobs row — checking for it would always produce a false gap.
 */
function isOwnHlsUrl(url: string, videoId: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  return (
    url.includes(`/api/hls/${videoId}/`) ||
    url.includes(`/api/v1/hls/${videoId}/`)
  );
}

/**
 * Derive a bare storage key from objectPath (strips known URL prefixes).
 * Returns empty string when the value is an external URL with no local key.
 */
function toStorageKey(objectPath: string): string {
  if (/^https?:\/\//i.test(objectPath)) {
    const marker = "/api/v1/uploads/";
    const idx = objectPath.indexOf(marker);
    if (idx !== -1) return objectPath.slice(idx + marker.length);
    const marker2 = "/api/uploads/";
    const idx2 = objectPath.indexOf(marker2);
    if (idx2 !== -1) return objectPath.slice(idx2 + marker2.length);
    return ""; // truly external URL — no local storage key
  }
  if (objectPath.startsWith("/")) {
    return objectPath.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
  }
  return objectPath;
}

// ── Row types ─────────────────────────────────────────────────────────────────

interface ReconciliationRow {
  queueId: string;
  videoId: string;
  title: string;
  qHlsUrl: string | null;
  vHlsUrl: string | null;
  vObjectPath: string | null;
  vTranscodingStatus: string | null;
  vVideoSource: string | null;
  vSourceCleanupStatus: string | null;
}

// ── Main reconciliation pass ──────────────────────────────────────────────────

async function runReconciliationPass(): Promise<void> {
  const startMs = Date.now();
  storageBlobRecoveryService.recordPassStart();

  // ── Pass A Step 1: Load all active queue items ───────────────────────────
  let rows: ReconciliationRow[];
  try {
    const raw = await db.execute<Record<string, unknown>>(sql`
      SELECT
        bq.id                     AS "queueId",
        bq.video_id               AS "videoId",
        bq.title                  AS "title",
        bq.hls_master_url         AS "qHlsUrl",
        mv.hls_master_url         AS "vHlsUrl",
        mv.object_path            AS "vObjectPath",
        mv.transcoding_status     AS "vTranscodingStatus",
        mv.video_source           AS "vVideoSource",
        mv.source_cleanup_status  AS "vSourceCleanupStatus"
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

  // ── Pass A Step 2: Build expected storage key sets with source classification
  //
  // Classification rules (evaluated in order — first match wins):
  //   YouTube video_source         → skip ALL storage checks (no local blobs)
  //   External HLS URL             → skip HLS storage check; still check MP4
  //   sourceCleanupStatus=deleted  → skip MP4 objectPath check (intentional)
  //   External objectPath URL      → skip MP4 check (no local key derivable)
  //
  // The batch size-validated query (Step 3) then confirms which of the expected
  // keys are genuinely present with data.

  const mp4Items:  Array<{ row: ReconciliationRow; key: string }> = [];
  const hlsItems:  Array<{ row: ReconciliationRow; key: string }> = [];

  for (const row of rows) {
    if (!row.videoId) continue;

    // YouTube videos: managed by YouTube — no local storage, never check
    if (row.vVideoSource === "youtube") continue;

    const hlsUrl = row.qHlsUrl || row.vHlsUrl;

    // HLS check: only for items whose HLS is served by THIS API.
    // External CDN / YouTube URLs have no storage_blobs row by design —
    // checking them would produce a guaranteed false gap on every pass.
    if (hlsUrl) {
      if (isOwnHlsUrl(hlsUrl, row.videoId)) {
        hlsItems.push({ row, key: `transcoded/${row.videoId}/master.m3u8` });
      }
      // External HLS URL → skip HLS storage check (no local blob expected)
    } else if (row.vTranscodingStatus === "hls_ready") {
      // No hlsUrl stored but status says hls_ready: check the canonical key
      hlsItems.push({ row, key: `transcoded/${row.videoId}/master.m3u8` });
    }

    // MP4 check: skip when source was intentionally deleted or path is external.
    const sourceDeleted = row.vSourceCleanupStatus === "deleted";
    const alreadyHlsReady = row.vTranscodingStatus === "hls_ready";

    if (!sourceDeleted && !alreadyHlsReady && row.vObjectPath) {
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

  // ── Pass A Step 3: Batch query — presence AND size_bytes > 0 ─────────────
  //
  // Requiring size_bytes > 0 ensures zero-byte blobs (produced by interrupted
  // putObject calls) are treated as absent.  A row exists in storage_blobs but
  // has no actual data — it would serve an empty/corrupt response to players.
  // The size gate catches this class of corruption without a separate scan.
  let presentKeys = new Set<string>();
  const blobsVerified = uniqueKeys.length;

  if (uniqueKeys.length > 0) {
    try {
      const whereClause = env.STORAGE_RECON_SIZE_CHECK
        ? and(
            inArray(schema.storageBlobsTable.key, uniqueKeys),
            gt(schema.storageBlobsTable.sizeBytes, 0),
          )
        : inArray(schema.storageBlobsTable.key, uniqueKeys);

      const presentRows = await db
        .select({ key: schema.storageBlobsTable.key })
        .from(schema.storageBlobsTable)
        .where(whereClause);

      presentKeys = new Set(presentRows.map((r) => r.key));
    } catch (err) {
      logger.warn({ err }, `${MODULE} storage_blobs batch query failed — skipping gap detection`);
      storageBlobRecoveryService.recordPassEnd(Date.now() - startMs, rows.length, blobsVerified, 0, 0);
      return;
    }
  }

  // ── Pass A Step 4: Find gaps and trigger recovery waterfall ───────────────
  // Deduplicate: one video can appear in both mp4Items and hlsItems; run
  // waterfall at most once per videoId per pass.
  const processed = new Set<string>();
  let gapsFound = 0;
  let recoveries = 0;

  // Process HLS gaps first (higher priority — HLS is the preferred playback source)
  for (const { row, key } of hlsItems) {
    if (!row.videoId || processed.has(row.videoId)) continue;
    if (presentKeys.has(key)) continue; // blob present and non-empty — healthy

    processed.add(row.videoId);
    gapsFound += 1;

    const hlsUrl = row.qHlsUrl || row.vHlsUrl;

    // ── Confidence system: storage-recon is the third independent source ──────
    // Register this storage gap with the confidence system using the resolved
    // HLS URL.  The orchestrator probe and scanner are sources 1 and 2;
    // storage-recon as source 3 pushes the confidence to gap3 (quarantine
    // candidate) when all three agree.  If we are the first or second source to
    // flag this URL, the confidence gate prevents premature bad-URL blocking.
    if (hlsUrl) {
      const resolvedUrl = normalizeQueueUrl(hlsUrl);
      if (resolvedUrl) {
        const confState = markUrlBadBySource(resolvedUrl, "storage-recon");
        if (confState !== "gap1") {
          logger.warn(
            { videoId: row.videoId, queueId: row.queueId, resolvedUrl, confState },
            `${MODULE} HLS gap confirmed by storage-recon — URL blocked at confidence ${confState}`,
          );
        }
      }
    }

    const result = await storageBlobRecoveryService.runWaterfall({
      videoId: row.videoId,
      queueId: row.queueId,
      title: row.title,
      objectPath: row.vObjectPath,
      hlsUrl,
      videoSource: row.vVideoSource,
      sourceCleanupStatus: row.vSourceCleanupStatus,
      triggeredBy: MODULE,
    });

    if (result.tier !== "error" && result.tier !== "tier3_deferred") recoveries += 1;
    if (result.tier !== "healthy" && result.tier !== "bypassed") {
      logger.warn(
        { videoId: row.videoId, queueId: row.queueId, tier: result.tier, missingKey: key },
        `${MODULE} HLS gap — recovery action taken`,
      );
    }
  }

  // Process MP4 gaps (items that rely on the MP4 source blob)
  for (const { row, key } of mp4Items) {
    if (!row.videoId || processed.has(row.videoId)) continue;
    if (presentKeys.has(key)) continue;

    processed.add(row.videoId);
    gapsFound += 1;

    const hlsUrl = row.qHlsUrl || row.vHlsUrl;

    // ── Confidence system: storage-recon as third source (MP4 path) ───────────
    // Use the MP4's objectPath-derived URL when no HLS URL is available.
    const mp4Url = hlsUrl
      ? null // HLS already handled above
      : normalizeQueueUrl(row.vObjectPath);
    const probeUrl = mp4Url;
    if (probeUrl) {
      const confState = markUrlBadBySource(probeUrl, "storage-recon");
      if (confState !== "gap1") {
        logger.warn(
          { videoId: row.videoId, queueId: row.queueId, probeUrl, confState },
          `${MODULE} MP4 gap confirmed by storage-recon — URL blocked at confidence ${confState}`,
        );
      }
    }

    const result = await storageBlobRecoveryService.runWaterfall({
      videoId: row.videoId,
      queueId: row.queueId,
      title: row.title,
      objectPath: row.vObjectPath,
      hlsUrl,
      videoSource: row.vVideoSource,
      sourceCleanupStatus: row.vSourceCleanupStatus,
      triggeredBy: MODULE,
    });

    if (result.tier !== "error" && result.tier !== "tier3_deferred") recoveries += 1;
    if (result.tier !== "healthy" && result.tier !== "bypassed") {
      logger.warn(
        { videoId: row.videoId, queueId: row.queueId, tier: result.tier, missingKey: key },
        `${MODULE} MP4 gap — recovery action taken`,
      );
    }
  }

  // ── Pass B: Library-wide HLS integrity check (non-queued videos) ─────────
  //
  // Checks managed_videos rows with hls_master_url set and hls_ready status
  // that are NOT currently in the active queue.  If their master.m3u8 blob is
  // missing (or zero-byte), runs the recovery waterfall proactively — before
  // these videos enter the queue and cause broadcast failures.
  //
  // Applies the same source-classification rules as Pass A:
  //   • youtube video_source → always skip (no local blobs)
  //   • external absolute hlsMasterUrl → skip (not our storage)
  //   • size_bytes > 0 required for "present"
  //
  // Capped at STORAGE_RECON_LIBRARY_BATCH rows per pass (default 200) to
  // bound per-pass duration on large libraries.  Active queue items (already
  // checked in Pass A) are excluded via the NOT IN guard.
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
      sourceCleanupStatus: string | null;
    }>(sql`
      SELECT
        mv.id                     AS "videoId",
        mv.title                  AS "title",
        mv.object_path            AS "objectPath",
        mv.hls_master_url         AS "hlsUrl",
        mv.source_cleanup_status  AS "sourceCleanupStatus"
      FROM managed_videos mv
      WHERE mv.hls_master_url IS NOT NULL
        AND mv.transcoding_status = 'hls_ready'
        AND mv.s3_mirrored_at IS NOT NULL
        AND mv.video_source != 'youtube'
        AND mv.transcoding_error_code IS NULL
      ORDER BY mv.updated_at DESC NULLS LAST
      LIMIT ${libraryBatch}
    `);

    type LibRow = typeof libraryResult.rows[number];

    const nonQueuedRows = (libraryResult.rows as LibRow[]).filter(
      (r) => !activeVideoIdSet.has(r.videoId),
    );
    libraryItemsChecked = nonQueuedRows.length;

    if (nonQueuedRows.length > 0) {
      // Filter to only own-server HLS URLs; external CDN rows need no check
      const ownServerRows = nonQueuedRows.filter(
        (r) => !r.hlsUrl || isOwnHlsUrl(r.hlsUrl, r.videoId),
      );

      if (ownServerRows.length > 0) {
        const masterKeys = ownServerRows.map((r) => `transcoded/${r.videoId}/master.m3u8`);

        const whereClause = env.STORAGE_RECON_SIZE_CHECK
          ? and(
              inArray(schema.storageBlobsTable.key, masterKeys),
              gt(schema.storageBlobsTable.sizeBytes, 0),
            )
          : inArray(schema.storageBlobsTable.key, masterKeys);

        const presentMasters = await db
          .select({ key: schema.storageBlobsTable.key })
          .from(schema.storageBlobsTable)
          .where(whereClause)
          .catch(() => [] as { key: string }[]);

        const presentMasterSet = new Set(presentMasters.map((r) => r.key));

        for (const libRow of ownServerRows) {
          const masterKey = `transcoded/${libRow.videoId}/master.m3u8`;
          if (presentMasterSet.has(masterKey)) continue;

          libraryGapsFound += 1;
          const result = await storageBlobRecoveryService.runWaterfall({
            videoId: libRow.videoId,
            queueId: "",
            title: libRow.title,
            objectPath: libRow.objectPath,
            hlsUrl: libRow.hlsUrl,
            videoSource: "local",
            sourceCleanupStatus: libRow.sourceCleanupStatus,
            triggeredBy: `${MODULE}:library-pass`,
          });
          if (result.tier !== "error" && result.tier !== "tier3_deferred") libraryRecoveries += 1;
          logger.warn(
            { videoId: libRow.videoId, tier: result.tier, message: result.message },
            `${MODULE} library-wide HLS gap — recovery action taken`,
          );
        }
      }
    }
  } catch (libErr) {
    logger.warn({ err: libErr }, `${MODULE} library-wide HLS integrity pass failed (non-fatal)`);
  }

  // ── Pass C: Orphaned blob scan ────────────────────────────────────────────
  await storageBlobRecoveryService.scanOrphanedBlobs();

  // ── Record and log pass metrics ───────────────────────────────────────────
  const elapsedMs = Date.now() - startMs;
  storageBlobRecoveryService.recordPassEnd(elapsedMs, rows.length, blobsVerified, gapsFound, recoveries);

  const stats = storageBlobRecoveryService.getStats();
  const failureRegistrySize = storageBlobRecoveryService.getFailureRegistry().size;

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
      failureRegistrySize,
      elapsedMs,
    },
    `${MODULE} reconciliation pass complete`,
  );
}

export const storageReconciliationWorker = {
  run: runReconciliationPass,
};
