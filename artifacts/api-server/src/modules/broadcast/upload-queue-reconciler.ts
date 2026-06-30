/**
 * Upload Queue Reconciler — final safety-net for the upload→queue pipeline.
 *
 * PROBLEM: the primary enqueue path (chunked-upload finalize background task)
 * handles ~99% of uploads correctly. The remaining 1% can slip through due to:
 *   • Transient DB pool exhaustion at enqueue time (enqueueIfMissing returns
 *     skipReason:"error" and gives up — no retry scheduled)
 *   • s3MirroredAt stamp silently failing (Promise.all .catch swallows the
 *     error; video stays s3MirroredAt=NULL; isPlayableForBroadcast rejects it)
 *   • Process crash / SIGTERM arriving between blob commit and enqueue call
 *   • s3MirroredAt update racing with enqueueIfMissing in the same ms window
 *   • Legacy S3 finalize path (media-uploads.routes.ts) missing enqueueIfMissing
 *
 * SOLUTION: this worker runs every 60 seconds with a 30 s initial delay. It:
 *   1. Runs repairMissingS3MirroredAt() first — stamps any confirmed blobs
 *      whose post-assembly DB update silently failed, making them visible to
 *      the s3MirroredAt IS NOT NULL filter below.
 *   2. Scans for local videos uploaded in the last 24 hours that have a
 *      confirmed blob (s3MirroredAt IS NOT NULL) but NO active queue row.
 *   3. Calls enqueueIfMissing() for each — idempotent, safe to call repeatedly.
 *   4. Fires broadcast-queue-updated + orchestrator reload so the newly-queued
 *      video is available for broadcast immediately.
 *
 * This worker is the final backstop. The primary path handles the fast case;
 * this worker guarantees correctness within 60 seconds in all other cases.
 * No operator action is ever required to recover a missed enqueue.
 */

import { and, desc, gt, isNotNull, ne, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { enqueueIfMissing, repairMissingS3MirroredAt } from "./auto-enqueue.service.js";

const videosTable = schema.videosTable;
const queueTable = schema.broadcastQueueTable;

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_PER_SCAN = 50;

export const uploadQueueReconciler = {
  async scan(): Promise<{ scanned: number; enqueued: number; repaired: number }> {
    try {
      const { repaired } = await repairMissingS3MirroredAt();

      const cutoff = new Date(Date.now() - LOOKBACK_MS);

      const candidates = await db
        .select({
          id: videosTable.id,
          title: videosTable.title,
          validationStatus: videosTable.validationStatus,
          importedAt: videosTable.importedAt,
        })
        .from(videosTable)
        .where(
          and(
            ne(videosTable.videoSource, "youtube"),
            ne(videosTable.category, "midnight-prayers"),
            isNotNull(videosTable.localVideoUrl),
            isNotNull(videosTable.s3MirroredAt),
            gt(videosTable.importedAt, cutoff),
            sql`NOT EXISTS (
              SELECT 1 FROM ${queueTable}
              WHERE ${queueTable.isActive} = true
                AND ${queueTable.videoId} = ${videosTable.id}
            )`,
          ),
        )
        .orderBy(desc(videosTable.importedAt))
        .limit(MAX_PER_SCAN);

      if (candidates.length === 0) {
        if (repaired > 0) {
          logger.info(
            { repaired },
            "[upload-queue-reconciler] stamped missing s3MirroredAt for confirmed blobs — will enqueue on next scan",
          );
        }
        return { scanned: 0, enqueued: 0, repaired };
      }

      let enqueued = 0;
      for (const row of candidates) {
        if (row.validationStatus === "failed") continue;

        const res = await enqueueIfMissing({ videoId: row.id, reason: "upload-finalize" });
        if (res.enqueued) {
          enqueued += 1;
          logger.info(
            { videoId: row.id, title: row.title, queueItemId: res.queueItemId },
            "[upload-queue-reconciler] enrolled missed upload in broadcast queue",
          );
        }
      }

      if (enqueued > 0) {
        adminEventBus.push("broadcast-queue-updated", {
          reason: "upload-queue-reconciler",
          enqueued,
          scanned: candidates.length,
        });
        logger.info(
          { scanned: candidates.length, enqueued, repaired },
          "[upload-queue-reconciler] reconciliation complete — enrolled missed uploads into broadcast queue",
        );
      }

      return { scanned: candidates.length, enqueued, repaired };
    } catch (err) {
      logger.warn({ err }, "[upload-queue-reconciler] scan failed (non-fatal)");
      return { scanned: 0, enqueued: 0, repaired: 0 };
    }
  },
};
