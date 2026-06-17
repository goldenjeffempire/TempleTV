/**
 * StorageBlobRecoveryService
 *
 * Canonical 3-tier recovery waterfall for a broadcast queue item whose
 * primary storage blobs are missing.  All callers (reconciliation worker,
 * queue-integrity validator supplement, transcoder dispatcher) should
 * delegate here so the recovery policy is maintained in one place.
 *
 * Tier 1 — HLS segment blobs exist despite missing master.m3u8
 *   • MP4 source blob still present  → re-enqueue transcoding at priority 8
 *     (clears hls_master_url so autoEnqueueMissingHls also picks it up)
 *   • MP4 source absent              → emit ops-alert; let media scanner probe
 *
 * Tier 2 — No HLS blobs but MP4 objectPath blob is present
 *   → Re-enqueue for transcoding (HLS will be rebuilt)
 *
 * Tier 3 — Zero blobs (HLS + MP4 source both gone)
 *   → quarantineVideo() with SOURCE_MISSING; ops-alert; deactivate queue row
 *
 * All operations are non-fatal: errors are caught and logged.  The caller
 * receives a typed result indicating which tier fired (or none for healthy).
 *
 * Stats are accumulated in-process for /health exposure:
 *   storageBlobRecoveryService.getStats() → { lastPassAtMs, healthy, tier1,
 *     tier2, tier3, orphanedBlobs, elapsedMs }
 */

import { eq, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { storage } from "../../../infrastructure/storage.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { quarantineVideo } from "../../broadcast/quarantine.service.js";
import { enqueueTranscode } from "../../transcoder/transcoder.queue.js";

export type RecoveryTier = "healthy" | "tier1_retranscode" | "tier1_alert_only" | "tier2_retranscode" | "tier3_quarantine" | "error";

export interface RecoveryResult {
  tier: RecoveryTier;
  videoId: string;
  message: string;
}

export interface RecoveryStats {
  lastPassAtMs: number | null;
  lastPassElapsedMs: number | null;
  checked: number;
  healthy: number;
  tier1RetranscodeTotal: number;
  tier1AlertTotal: number;
  tier2Total: number;
  tier3Total: number;
  orphanedBlobsTotal: number;
  consecutiveErrors: number;
}

/** Derive a bare storage key from objectPath (strips URL prefixes). */
function toStorageKey(objectPath: string): string {
  if (/^https?:\/\//i.test(objectPath)) return "";
  if (objectPath.startsWith("/")) {
    return objectPath.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
  }
  return objectPath;
}

class StorageBlobRecoveryServiceImpl {
  private stats: RecoveryStats = {
    lastPassAtMs: null,
    lastPassElapsedMs: null,
    checked: 0,
    healthy: 0,
    tier1RetranscodeTotal: 0,
    tier1AlertTotal: 0,
    tier2Total: 0,
    tier3Total: 0,
    orphanedBlobsTotal: 0,
    consecutiveErrors: 0,
  };

  getStats(): Readonly<RecoveryStats> {
    return { ...this.stats };
  }

  recordPassStart() {
    this.stats.lastPassAtMs = Date.now();
  }

  recordPassEnd(elapsedMs: number) {
    this.stats.lastPassElapsedMs = elapsedMs;
  }

  /**
   * Run the 3-tier recovery waterfall for a single video.
   *
   * @param videoId     - managed_videos.id
   * @param queueId     - broadcast_queue.id (used for deactivation in tier 3)
   * @param title       - display title for logging
   * @param objectPath  - managed_videos.object_path (MP4 source storage key)
   * @param hlsUrl      - current HLS master URL (used to infer transcoded prefix)
   * @param triggeredBy - component name for audit trail
   */
  async runWaterfall(opts: {
    videoId: string;
    queueId: string;
    title: string;
    objectPath: string | null | undefined;
    hlsUrl: string | null | undefined;
    triggeredBy: string;
  }): Promise<RecoveryResult> {
    const { videoId, queueId, title, objectPath, hlsUrl, triggeredBy } = opts;
    this.stats.checked += 1;

    try {
      // ── Step 1: Check HLS master.m3u8 blob ─────────────────────────────────
      const masterKey = `transcoded/${videoId}/master.m3u8`;
      const masterHead = await storage().headObject(masterKey);
      if (masterHead.exists) {
        // HLS master blob is present — item is healthy.  If hlsUrl is unset
        // on the video row, restore it so the orchestrator can serve it.
        if (!hlsUrl) {
          const restoredUrl = `/api/hls/${videoId}/master.m3u8`;
          await db.update(schema.videosTable)
            .set({ hlsMasterUrl: restoredUrl, transcodingStatus: "hls_ready" })
            .where(eq(schema.videosTable.id, videoId))
            .catch((err) => {
              logger.warn({ err, videoId }, `[storage-blob-recovery] failed to restore hlsMasterUrl on healthy item (non-fatal)`);
            });
          adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-restored-hls", videoId });
        }
        this.stats.healthy += 1;
        this.stats.consecutiveErrors = 0;
        return { tier: "healthy", videoId, message: "HLS master.m3u8 present" };
      }

      // master.m3u8 missing — count segment blobs under the transcoded prefix.
      const segmentCountResult = await db.execute<{ cnt: number }>(sql`
        SELECT COUNT(*)::int AS cnt FROM storage_blobs
        WHERE key LIKE ${"transcoded/" + videoId + "/%"}
      `);
      const segmentCount = Number(segmentCountResult.rows[0]?.cnt ?? 0);

      if (segmentCount > 0) {
        // ── Tier 1: HLS segment blobs exist but master is missing ────────────
        // A previous transcode partially completed.  Best recovery: re-transcode
        // from the MP4 source (if still present) at elevated priority so a fresh
        // master.m3u8 + all variant playlists are written atomically.
        const rawKey = objectPath ? toStorageKey(objectPath) : "";
        const mp4Exists = rawKey ? (await storage().headObject(rawKey)).exists : false;

        if (mp4Exists) {
          // Tier 1a: MP4 source present → re-transcode at priority 8.
          // Clear hlsMasterUrl so autoEnqueueMissingHls also picks it up.
          await db.update(schema.videosTable)
            .set({ hlsMasterUrl: null })
            .where(eq(schema.videosTable.id, videoId))
            .catch(() => { /* non-fatal */ });
          await enqueueTranscode({ videoId, videoPath: rawKey, priority: 8 });
          adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-tier1", videoId });
          adminEventBus.push("ops-alert", {
            level: "warn",
            component: triggeredBy,
            message:
              `"${title}" (videoId: ${videoId}) had ${segmentCount} HLS segment blob(s) but no master.m3u8. ` +
              "MP4 source blob found — re-enqueued for transcoding at priority 8.",
            videoId,
            queueId,
            segmentCount,
          });
          this.stats.tier1RetranscodeTotal += 1;
          this.stats.consecutiveErrors = 0;
          return { tier: "tier1_retranscode", videoId, message: `${segmentCount} HLS segment blob(s) found, MP4 present — re-transcoding` };
        } else {
          // Tier 1b: No MP4 source — segments exist but we can't re-transcode.
          // Surface to operators; let media integrity scanner probe the segments.
          adminEventBus.push("ops-alert", {
            level: "warn",
            component: triggeredBy,
            message:
              `"${title}" (videoId: ${videoId}) is missing HLS master.m3u8 ` +
              `but has ${segmentCount} segment blob(s) in storage and no MP4 source blob. ` +
              "Manual recovery required: re-upload the source video.",
            videoId,
            queueId,
            segmentCount,
          });
          this.stats.tier1AlertTotal += 1;
          this.stats.consecutiveErrors = 0;
          return { tier: "tier1_alert_only", videoId, message: `${segmentCount} HLS segment blob(s) found but no MP4 source — operator action required` };
        }
      }

      // ── Tier 2: Check MP4 objectPath blob ──────────────────────────────────
      const rawKey = objectPath ? toStorageKey(objectPath) : "";
      const mp4Exists = rawKey ? (await storage().headObject(rawKey)).exists : false;

      if (mp4Exists) {
        await enqueueTranscode({ videoId, videoPath: rawKey, priority: 5 });
        adminEventBus.push("transcoding-update", { videoId, status: "queued", progress: 0 });
        adminEventBus.push("ops-alert", {
          level: "warn",
          component: triggeredBy,
          message:
            `"${title}" (videoId: ${videoId}) had no HLS output in storage. ` +
            "MP4 source blob found — re-enqueued for transcoding.",
          videoId,
          queueId,
        });
        this.stats.tier2Total += 1;
        this.stats.consecutiveErrors = 0;
        return { tier: "tier2_retranscode", videoId, message: "No HLS blobs; MP4 source present — re-transcoding" };
      }

      // ── Tier 3: No blobs at all — quarantine ───────────────────────────────
      logger.error(
        { videoId, queueId, title, objectPath, triggeredBy },
        "[storage-blob-recovery] ZERO blobs in storage (HLS + MP4) — quarantining as SOURCE_MISSING",
      );

      await db.update(schema.videosTable)
        .set({
          transcodingStatus: "failed",
          transcodingErrorCode: "SOURCE_MISSING",
          transcodingErrorMessage:
            "All storage blobs missing (detected by storage reconciliation). " +
            "Re-upload the source video to restore.",
        })
        .where(eq(schema.videosTable.id, videoId))
        .catch((err) => {
          logger.warn({ err, videoId }, "[storage-blob-recovery] failed to mark SOURCE_MISSING on video row (non-fatal)");
        });

      await quarantineVideo(videoId, {
        errorCode: "SOURCE_MISSING",
        reason:
          "All storage blobs (HLS and MP4 source) are missing from storage_blobs. " +
          "The video is permanently unplayable until the source file is re-uploaded.",
        triggeredBy,
        metadata: { hlsUrl, objectPath, detectedAtMs: Date.now() },
      });

      this.stats.tier3Total += 1;
      this.stats.consecutiveErrors = 0;
      return { tier: "tier3_quarantine", videoId, message: "ZERO blobs — quarantined as SOURCE_MISSING" };
    } catch (err) {
      this.stats.consecutiveErrors += 1;
      logger.warn({ err, videoId, queueId }, "[storage-blob-recovery] waterfall error (non-fatal)");
      return { tier: "error", videoId, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Scan storage_blobs for orphaned entries — blobs whose prefix matches
   * `transcoded/{videoId}/` but whose videoId has no corresponding
   * managed_videos row.  These accumulate after hard-deletes or failed imports.
   *
   * Returns the count of orphaned blob prefixes found and pushes an ops-alert
   * if any are detected.  Does NOT delete blobs — deletion is left to the
   * storage cleanup worker; this pass only surfaces them.
   *
   * @param limit Maximum distinct videoId prefixes to scan per call (default 200)
   */
  async scanOrphanedBlobs(limit = 200): Promise<number> {
    try {
      const result = await db.execute<{ orphaned_prefix_count: number }>(sql`
        WITH distinct_prefixes AS (
          SELECT DISTINCT
            regexp_replace(key, '^transcoded/([^/]+)/.*$', '\\1') AS video_id
          FROM storage_blobs
          WHERE key LIKE 'transcoded/%'
          LIMIT ${limit}
        )
        SELECT COUNT(*)::int AS orphaned_prefix_count
        FROM distinct_prefixes dp
        WHERE NOT EXISTS (
          SELECT 1 FROM managed_videos mv WHERE mv.id = dp.video_id
        )
      `);
      const count = Number(result.rows[0]?.orphaned_prefix_count ?? 0);
      this.stats.orphanedBlobsTotal = count;
      if (count > 0) {
        logger.warn(
          { orphanedPrefixCount: count },
          "[storage-blob-recovery] orphaned HLS blob prefixes detected (no managed_videos row) — storage cleanup worker will GC these",
        );
        adminEventBus.push("ops-alert", {
          level: "warn",
          component: "storage-blob-recovery",
          message:
            `${count} orphaned HLS blob prefix(es) found in storage_blobs with no corresponding managed_videos row. ` +
            "The storage cleanup worker will garbage-collect these on its next pass.",
          orphanedCount: count,
        });
      }
      return count;
    } catch (err) {
      logger.warn({ err }, "[storage-blob-recovery] orphaned blob scan failed (non-fatal)");
      return 0;
    }
  }
}

export const storageBlobRecoveryService = new StorageBlobRecoveryServiceImpl();
