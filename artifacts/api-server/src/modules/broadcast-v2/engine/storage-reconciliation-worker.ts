/**
 * Storage reconciliation worker — MP4-only pipeline.
 *
 * Periodic (default 10 min, see STORAGE_RECONCILIATION_INTERVAL_MS) pass that
 * reconciles every *active* broadcast_queue item's blob reference against
 * `storage_blobs` and drives the recovery waterfall
 * (`storageBlobRecoveryService.runWaterfall`) for any gap found.
 *
 * This complements two other layers that already exist:
 *   - `queueIntegrityValidator` (runs far more frequently) flags MISSING_BLOB
 *     as a validation issue and auto-deactivates the affected queue row, but
 *     does not attempt reassembly recovery.
 *   - `upload-integrity-monitor` scans ALL videos (not just what's currently
 *     queued) for corrupt/missing blobs, on a slower 30-min cadence.
 * This worker is the one that actively attempts to *heal* (not just flag)
 * gaps for whatever is currently airing/queued, and is what feeds the
 * `storageBlobRecoveryService` stats surfaced on the admin dashboards.
 *
 * Historical note: this worker's body was previously stubbed to a no-op
 * during the HLS→MP4 pipeline migration ("disabled — MP4-only pipeline
 * active") but never replaced with the MP4-native equivalent, leaving the
 * scheduled pass, the manual "storage-reconcile" admin action, and the
 * health-endpoint stats all permanently inert. This rewrite closes that gap.
 */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger as rootLogger } from "../../../infrastructure/logger.js";
import { storageBlobRecoveryService } from "./storage-blob-recovery.service.js";

const logger = rootLogger.child({ module: "storage-reconciliation" });
const queue = schema.broadcastQueueTable;
const videos = schema.videosTable;
const blobs = schema.storageBlobsTable;

const MAX_ITEMS_PER_PASS = 200;

function deriveKey(objectPath: string | null | undefined, localVideoUrl: string | null | undefined): string | null {
  if (objectPath) return objectPath;
  if (!localVideoUrl) return null;
  const m = localVideoUrl.match(/\/(?:api\/v1\/|api\/)?uploads\/(.+)$/);
  return m ? `uploads/${m[1]}` : localVideoUrl.startsWith("uploads/") ? localVideoUrl : null;
}

export const storageReconciliationWorker = {
  async run(): Promise<void> {
    const start = Date.now();
    let itemsChecked = 0;
    let blobsVerified = 0;
    let errored = false;

    try {
      const rows = await db
        .select({
          queueId: queue.id,
          videoId: queue.videoId,
          qLocalUrl: queue.localVideoUrl,
          videoSource: queue.videoSource,
          vObjectPath: videos.objectPath,
          vLocalUrl: videos.localVideoUrl,
        })
        .from(queue)
        .leftJoin(videos, eq(queue.videoId, videos.id))
        .where(eq(queue.isActive, true))
        .limit(MAX_ITEMS_PER_PASS);

      type Entry = { queueId: string; key: string };
      const entries: Entry[] = [];
      for (const row of rows) {
        if (row.videoSource && row.videoSource !== "local") continue; // YouTube/external — not our storage
        const key = deriveKey(row.vObjectPath, row.qLocalUrl ?? row.vLocalUrl);
        if (!key) continue;
        entries.push({ queueId: row.queueId, key });
      }
      itemsChecked = entries.length;

      if (entries.length > 0) {
        const keys = entries.map((e) => e.key);
        const present = await db
          .select({ key: blobs.key })
          .from(blobs)
          .where(inArray(blobs.key, keys));
        const presentSet = new Set(present.map((p) => p.key));
        blobsVerified = presentSet.size;

        const gaps = entries.filter((e) => !presentSet.has(e.key));
        if (gaps.length > 0) {
          logger.warn({ count: gaps.length }, "[storage-reconciliation] blob gaps found on active queue items — running recovery waterfall");
          for (const gap of gaps) {
            await storageBlobRecoveryService.runWaterfall(gap.queueId);
          }
        }
      }

      await storageBlobRecoveryService.scanOrphanedBlobs();
    } catch (err) {
      errored = true;
      logger.warn({ err }, "[storage-reconciliation] pass failed (non-fatal)");
    } finally {
      storageBlobRecoveryService.recordScan(itemsChecked, blobsVerified, Date.now() - start, errored);
      logger.info(
        { itemsChecked, blobsVerified, elapsedMs: Date.now() - start },
        "[storage-reconciliation] pass complete",
      );
    }
  },
};
