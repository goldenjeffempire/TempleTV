/**
 * Storage Reconciliation Worker
 *
 * Runs every STORAGE_RECONCILIATION_INTERVAL_MS (default 10 min) and
 * reconciles every active broadcast_queue item's referenced storage blobs
 * against what actually exists in storage_blobs.
 *
 * Checks performed for each active queue item that references a managed_video:
 *
 *   HLS items (hlsMasterUrl IS NOT NULL):
 *     • If master.m3u8 blob is missing → MP4 blob recovery waterfall below.
 *     • If master.m3u8 exists → item is healthy, skip.
 *
 *   MP4 items (localVideoUrl IS NOT NULL, no HLS):
 *     • objectPath blob missing → recovery waterfall.
 *     • objectPath blob present → item is healthy, skip.
 *
 * Recovery waterfall (executed when the primary source blob is missing):
 *   Tier 1 — HLS blobs exist (segments/playlists present despite missing master):
 *     Promote by re-enabling HLS (if hlsMasterUrl exists on the video row).
 *     Emits broadcast-queue-updated so the orchestrator reloads immediately.
 *   Tier 2 — objectPath blob exists (MP4 source present but HLS missing):
 *     Re-enqueue for transcoding. The transcoder will rebuild HLS output.
 *   Tier 3 — No blobs at all (complete data loss):
 *     quarantineVideo() → SOURCE_MISSING → deactivate queue row → ops-alert.
 *     Operators must re-upload the source video to restore the item.
 *
 * Non-fatal: any DB/storage error is caught and logged. A failing scan never
 * prevents the server from operating — the orchestrator's own bad-URL circuit
 * breaker and the media integrity scanner provide overlapping coverage.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { storage } from "../../../infrastructure/storage.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { quarantineVideo } from "../../broadcast/quarantine.service.js";
import { enqueueTranscode } from "../../transcoder/transcoder.queue.js";

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
  // Evict stale entries to prevent unbounded growth.
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
  qLocalUrl: string | null;
  qHlsUrl: string | null;
  vLocalUrl: string | null;
  vHlsUrl: string | null;
  vObjectPath: string | null;
  vTranscodingStatus: string | null;
}

/** Derive a storage key from objectPath (strips /api/v1/ URL prefix if present). */
function toStorageKey(objectPath: string): string {
  if (/^https?:\/\//i.test(objectPath)) return ""; // remote URL — not our storage
  if (objectPath.startsWith("/")) {
    return objectPath.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
  }
  return objectPath;
}

async function runReconciliationPass(): Promise<void> {
  const startMs = Date.now();

  const q = schema.broadcastQueueTable;
  const v = schema.videosTable;

  let rows: ReconciliationRow[];
  try {
    const raw = await db
      .select({
        queueId: q.id,
        videoId: q.videoId,
        title: q.title,
        qLocalUrl: q.localVideoUrl,
        qHlsUrl: q.hlsMasterUrl,
        vLocalUrl: v.localVideoUrl,
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
    return;
  }

  let checked = 0;
  let healthy = 0;
  let recovered = 0;
  let quarantined = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.videoId) continue;
    checked += 1;

    const videoId = row.videoId;
    const hlsUrl = row.qHlsUrl || row.vHlsUrl;
    const objectPath = row.vObjectPath;

    if (isOnCooldown(videoId)) {
      skipped += 1;
      continue;
    }

    try {
      // ── Step 1: Check HLS master blob ────────────────────────────────────
      if (hlsUrl) {
        const masterKey = `transcoded/${videoId}/master.m3u8`;
        const masterHead = await storage().headObject(masterKey);
        if (masterHead.exists) {
          healthy += 1;
          continue;
        }

        // master.m3u8 missing — check if any HLS segment blobs are present.
        const segmentCountResult = await db.execute<{ cnt: number }>(sql`
          SELECT COUNT(*)::int AS cnt
          FROM storage_blobs
          WHERE key LIKE ${"transcoded/" + videoId + "/%"}
        `);
        const segmentCount = Number(segmentCountResult.rows[0]?.cnt ?? 0);

        if (segmentCount > 0) {
          // Tier 1: partial HLS output exists — log and let media scanner probe.
          logger.warn(
            { videoId, queueId: row.queueId, title: row.title, segmentCount },
            `${MODULE} HLS master.m3u8 missing but ${segmentCount} segment blob(s) found — ` +
            "media scanner will probe; skipping automatic recovery to avoid thrashing",
          );
          adminEventBus.push("ops-alert", {
            level: "warn",
            component: MODULE,
            message:
              `Queue item "${row.title}" (videoId: ${videoId}) is missing HLS master.m3u8 ` +
              `but has ${segmentCount} segment blob(s) in storage. Possible partial transcode. ` +
              "Re-transcode the video to restore full HLS output.",
            videoId,
            queueId: row.queueId,
          });
          markRecovered(videoId);
          skipped += 1;
          continue;
        }

        // No HLS blobs at all — fall through to MP4 recovery waterfall.
        logger.warn(
          { videoId, queueId: row.queueId, title: row.title },
          `${MODULE} HLS URL set but ZERO HLS blobs in storage — running MP4 recovery waterfall`,
        );
      }

      // ── Step 2: Check MP4 objectPath blob ───────────────────────────────
      const rawKey = objectPath ? toStorageKey(objectPath) : "";
      const mp4Exists = rawKey
        ? (await storage().headObject(rawKey)).exists
        : false;

      if (mp4Exists) {
        // Tier 2: MP4 blob present — re-enqueue for transcoding.
        logger.warn(
          { videoId, queueId: row.queueId, title: row.title, objectPath },
          `${MODULE} MP4 source blob found but HLS missing — re-enqueueing for transcoding`,
        );
        try {
          await enqueueTranscode({ videoId, videoPath: rawKey, priority: 5 });
          adminEventBus.push("transcoding-update", { videoId, status: "queued", progress: 0 });
          adminEventBus.push("ops-alert", {
            level: "warn",
            component: MODULE,
            message:
              `Queue item "${row.title}" (videoId: ${videoId}) had no HLS output in storage. ` +
              "MP4 source blob found — re-enqueued for transcoding. HLS will be available once transcoding completes.",
            videoId,
            queueId: row.queueId,
          });
          markRecovered(videoId);
          recovered += 1;
        } catch (enqErr) {
          logger.warn({ err: enqErr, videoId }, `${MODULE} failed to re-enqueue for transcoding (non-fatal)`);
        }
        continue;
      }

      // ── Step 3: No blobs at all — quarantine ────────────────────────────
      // Both the HLS master and the MP4 source are gone from storage.
      // The item is permanently unplayable until the operator re-uploads.
      logger.error(
        { videoId, queueId: row.queueId, title: row.title, objectPath },
        `${MODULE} ZERO blobs in storage (HLS + MP4) — quarantining video as SOURCE_MISSING`,
      );

      // Mark the video row with SOURCE_MISSING so the retry guard blocks re-queue.
      try {
        await db.update(schema.videosTable)
          .set({
            transcodingStatus: "failed",
            transcodingErrorCode: "SOURCE_MISSING",
            transcodingErrorMessage:
              "All storage blobs missing (detected by storage reconciliation worker). " +
              "Re-upload the source video to restore.",
          })
          .where(eq(schema.videosTable.id, videoId));
      } catch (updateErr) {
        logger.warn({ err: updateErr, videoId }, `${MODULE} failed to mark SOURCE_MISSING on video row (non-fatal)`);
      }

      await quarantineVideo(videoId, {
        errorCode: "SOURCE_MISSING",
        reason:
          "All storage blobs (HLS and MP4 source) are missing from storage_blobs. " +
          "The video is permanently unplayable until the source file is re-uploaded.",
        triggeredBy: "storage-reconciliation-worker",
        metadata: {
          hlsUrl,
          objectPath,
          detectedAtMs: Date.now(),
        },
      });

      markRecovered(videoId);
      quarantined += 1;
    } catch (itemErr) {
      logger.warn(
        { err: itemErr, videoId, queueId: row.queueId },
        `${MODULE} error processing item (non-fatal, will retry next pass)`,
      );
    }
  }

  const elapsedMs = Date.now() - startMs;
  logger.info(
    { checked, healthy, recovered, quarantined, skipped, elapsedMs, totalRows: rows.length },
    `${MODULE} reconciliation pass complete`,
  );

  if (quarantined > 0 || recovered > 0) {
    adminEventBus.push("broadcast-queue-updated", {
      reason: "storage-reconciliation",
      recovered,
      quarantined,
    });
  }
}

export const storageReconciliationWorker = {
  run: runReconciliationPass,
};
