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
import { env } from "../../../config/env.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { quarantineVideo } from "../../broadcast/quarantine.service.js";
import { enqueueTranscode } from "../../transcoder/transcoder.queue.js";

export type RecoveryTier = "healthy" | "tier1_promoted" | "tier1_retranscode" | "tier1_alert_only" | "tier2_retranscode" | "tier3_quarantine" | "error";

/**
 * Known HLS tier metadata keyed by rendition name (e.g. "360p").
 * Values match the HLS_TIERS constants in transcoder.service.ts.
 * Used by the Tier-1b promote path to reconstruct a master.m3u8 from
 * existing variant playlists when the MP4 source has been deleted.
 */
const HLS_TIER_META: Readonly<Record<string, { bandwidth: number; resolution: string; codecs: string }>> = {
  "240p": { bandwidth:   364_000, resolution: "426x240",  codecs: "avc1.4d4015,mp4a.40.2" },
  "360p": { bandwidth:   596_000, resolution: "640x360",  codecs: "avc1.4d401e,mp4a.40.2" },
  "480p": { bandwidth: 1_128_000, resolution: "854x480",  codecs: "avc1.4d401f,mp4a.40.2" },
  "720p": { bandwidth: 2_660_000, resolution: "1280x720", codecs: "avc1.64001f,mp4a.40.2" },
} as const;

export interface RecoveryResult {
  tier: RecoveryTier;
  videoId: string;
  message: string;
}

export interface RecoveryStats {
  lastRunAt: number | null;
  lastPassElapsedMs: number | null;
  itemsChecked: number;
  blobsVerified: number;
  gapsFound: number;
  recoveries: number;
  orphanedBlobCount: number;
  deletedOrphanBlobCount: number;
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
    lastRunAt: null,
    lastPassElapsedMs: null,
    itemsChecked: 0,
    blobsVerified: 0,
    gapsFound: 0,
    recoveries: 0,
    orphanedBlobCount: 0,
    deletedOrphanBlobCount: 0,
    consecutiveErrors: 0,
  };

  // Internal per-waterfall counters (not in public interface)
  private _checked = 0;
  private _healthy = 0;
  private _tier1Retranscode = 0;
  private _tier1Alert = 0;
  private _tier2 = 0;
  private _tier3 = 0;

  getStats(): Readonly<RecoveryStats> {
    return { ...this.stats };
  }

  recordPassStart() {
    this.stats.lastRunAt = Date.now();
  }

  /**
   * Called by the reconciliation worker at the end of each batch pass.
   * Accumulates the pass-level metrics into the public stats object.
   */
  recordPassEnd(elapsedMs: number, itemsChecked = 0, blobsVerified = 0, gapsFound = 0, recoveries = 0) {
    this.stats.lastPassElapsedMs = elapsedMs;
    this.stats.itemsChecked += itemsChecked;
    this.stats.blobsVerified += blobsVerified;
    this.stats.gapsFound += gapsFound;
    this.stats.recoveries += recoveries;
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
    this._checked += 1;

    try {
      // ── Step 1: Check HLS master.m3u8 blob ─────────────────────────────────
      const masterKey = `transcoded/${videoId}/master.m3u8`;
      const masterHead = await storage().headObject(masterKey);
      if (masterHead.exists) {
        // HLS master blob is confirmed present — always promote to HLS.
        // Set hlsMasterUrl and hls_ready status unconditionally: this clears any
        // stale MP4-URL-only state left from a failed faststart or partial recovery,
        // and ensures the orchestrator snapshot picks up the correct source.
        const restoredUrl = `/api/hls/${videoId}/master.m3u8`;
        const needsUpdate = !hlsUrl || hlsUrl !== restoredUrl;
        if (needsUpdate) {
          await db.update(schema.videosTable)
            .set({ hlsMasterUrl: restoredUrl, transcodingStatus: "hls_ready" })
            .where(eq(schema.videosTable.id, videoId))
            .catch((err) => {
              logger.warn({ err, videoId }, `[storage-blob-recovery] failed to promote hlsMasterUrl on healthy item (non-fatal)`);
            });
          adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-hls-promoted", videoId });
        }
        this._healthy += 1;
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
          this._tier1Retranscode += 1;
          this.stats.consecutiveErrors = 0;
          return { tier: "tier1_retranscode", videoId, message: `${segmentCount} HLS segment blob(s) found, MP4 present — re-transcoding` };
        } else {
          // Tier 1b: No MP4 source — but segment blobs exist. Before quarantining,
          // try to promote existing HLS output by synthesizing a master.m3u8 from
          // any variant playlists (e.g. transcoded/{id}/360p/playlist.m3u8) that
          // are already in storage. This path recovers items whose transcoding
          // finished successfully but whose master.m3u8 was lost (e.g. a partial
          // storage delete) while the actual per-segment data survived intact.
          const variantResult = await db.execute<{ key: string }>(sql`
            SELECT key FROM storage_blobs
            WHERE key LIKE ${"transcoded/" + videoId + "/%/playlist.m3u8"}
            ORDER BY key
          `).catch(() => ({ rows: [] as { key: string }[] }));

          // Build master.m3u8 content from found variant playlists.
          const variantLines: string[] = [];
          for (const row of variantResult.rows) {
            // key = transcoded/{videoId}/{tierName}/playlist.m3u8
            const tierName = row.key.split("/")[2];
            const meta = tierName ? HLS_TIER_META[tierName] : undefined;
            if (!meta) continue; // skip unrecognised tier names
            variantLines.push(
              `#EXT-X-STREAM-INF:BANDWIDTH=${meta.bandwidth},RESOLUTION=${meta.resolution},CODECS="${meta.codecs}"`,
              `${tierName}/playlist.m3u8`,
            );
          }

          if (variantLines.length > 0) {
            // Synthesise and upload a minimal master.m3u8 pointing to the survivors.
            const masterContent = [
              "#EXTM3U",
              "#EXT-X-VERSION:3",
              "#EXT-X-INDEPENDENT-SEGMENTS",
              ...variantLines,
            ].join("\n") + "\n";

            await storage().putObject({
              key: masterKey,
              body: Buffer.from(masterContent, "utf-8"),
              contentType: "application/vnd.apple.mpegurl",
            });

            const restoredUrl = `/api/hls/${videoId}/master.m3u8`;
            await db.update(schema.videosTable)
              .set({ hlsMasterUrl: restoredUrl, transcodingStatus: "hls_ready" })
              .where(eq(schema.videosTable.id, videoId))
              .catch((err) => {
                logger.warn({ err, videoId }, "[storage-blob-recovery] tier1b-promote: failed to set hlsMasterUrl (non-fatal)");
              });
            adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-tier1b-promoted", videoId });
            adminEventBus.push("ops-alert", {
              level: "warn",
              component: triggeredBy,
              message:
                `"${title}" (videoId: ${videoId}): HLS master.m3u8 was missing but ` +
                `${variantResult.rows.length} variant playlist(s) survived in storage. ` +
                "Synthesised and uploaded a new master.m3u8 — item promoted back to broadcast.",
              videoId,
              queueId,
              variantCount: variantResult.rows.length,
            });
            this._tier1Retranscode += 1;
            this.stats.consecutiveErrors = 0;
            return { tier: "tier1_promoted", videoId, message: `master.m3u8 synthesised from ${variantResult.rows.length} variant playlist(s)` };
          }

          // No recoverable variant playlists — permanently unplayable.
          // Deactivate the queue item and quarantine the video.
          if (queueId) {
            await db.update(schema.broadcastQueueTable)
              .set({ isActive: false, validatorDeactivatedReason: "hls_master_missing_no_source" })
              .where(eq(schema.broadcastQueueTable.id, queueId))
              .catch((err) => {
                logger.warn({ err, videoId, queueId }, "[storage-blob-recovery] tier1b: failed to deactivate queue item (non-fatal)");
              });
          }
          await quarantineVideo(videoId, {
            errorCode: "SOURCE_MISSING",
            reason:
              `HLS master.m3u8 and all variant playlists missing; ${segmentCount} orphaned segment blob(s) found with no MP4 source. ` +
              "Re-upload the source video to restore.",
            triggeredBy,
            metadata: { segmentCount, hlsUrl, objectPath, detectedAtMs: Date.now() },
          }).catch((err) => {
            logger.warn({ err, videoId }, "[storage-blob-recovery] tier1b: quarantine call failed (non-fatal)");
          });
          adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-tier1b-deactivated", videoId, queueId });
          adminEventBus.push("ops-alert", {
            level: "error",
            component: triggeredBy,
            message:
              `"${title}" (videoId: ${videoId}) is missing HLS master.m3u8 and all variant playlists ` +
              `but has ${segmentCount} segment blob(s) in storage and no MP4 source blob. ` +
              "Video deactivated from broadcast queue. Operator action required: re-upload the source video.",
            videoId,
            queueId,
            segmentCount,
          });
          this._tier1Alert += 1;
          this.stats.consecutiveErrors = 0;
          return { tier: "tier1_alert_only", videoId, message: `${segmentCount} HLS segment blob(s) found but no variant playlists or MP4 source — deactivated` };
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
        this._tier2 += 1;
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

      this._tier3 += 1;
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
   * `transcoded/{videoId}/` or `uploads/{key}` but whose videoId / upload
   * has no corresponding managed_videos row.  These accumulate after hard-
   * deletes, failed imports, or abandoned upload sessions.
   *
   * When ORPHAN_BLOB_AUTO_DELETE=true (default) blobs older than
   * ORPHAN_BLOB_MIN_AGE_HOURS (default 168 h = 7 days) are automatically
   * deleted in batches.  The age guard prevents accidental deletion of blobs
   * belonging to in-progress uploads or recently removed videos whose row
   * deletion has not yet propagated through all caches.
   *
   * Returns the total count of orphaned blob prefixes detected.
   */
  async scanOrphanedBlobs(): Promise<number> {
    const autoDelete = env.ORPHAN_BLOB_AUTO_DELETE;
    const minAgeHours = env.ORPHAN_BLOB_MIN_AGE_HOURS;
    const cutoff = new Date(Date.now() - minAgeHours * 60 * 60_000);

    try {
      // ── Phase 1: Scan transcoded/ orphaned prefixes ────────────────────────
      // Each distinct video_id under transcoded/ that has no managed_videos row
      // is an orphaned HLS output set (typically from a hard-deleted video).
      // We fetch each orphan's newest blob timestamp so the age gate can apply
      // per-prefix rather than per-blob, avoiding partial-deletion of a prefix
      // that just received a new segment during an in-progress transcode.
      const transcodedOrphansResult = await db.execute<{
        video_id: string;
        newest_blob_at: string;
        blob_count: number;
      }>(sql`
        WITH distinct_prefixes AS (
          SELECT
            regexp_replace(key, '^transcoded/([^/]+)/.*$', '\\1') AS video_id,
            MAX(updated_at) AS newest_blob_at,
            COUNT(*)::int   AS blob_count
          FROM storage_blobs
          WHERE key LIKE 'transcoded/%'
          GROUP BY 1
        )
        SELECT video_id, newest_blob_at::text AS newest_blob_at, blob_count
        FROM distinct_prefixes dp
        WHERE NOT EXISTS (
          SELECT 1 FROM managed_videos mv WHERE mv.id = dp.video_id
        )
        ORDER BY newest_blob_at
        LIMIT 200
      `);

      const allOrphanedTranscoded = transcodedOrphansResult.rows;
      const transcodedCount = allOrphanedTranscoded.length;

      // Age-gate: only delete prefixes whose NEWEST blob is older than the
      // threshold (i.e. no blob has been written recently, so the prefix is
      // genuinely abandoned — not an in-progress transcode).
      const deletableTranscoded = autoDelete
        ? allOrphanedTranscoded.filter((r) => new Date(r.newest_blob_at) < cutoff)
        : [];

      let deletedTranscoded = 0;
      for (const row of deletableTranscoded) {
        try {
          const del = await db.execute(sql`
            DELETE FROM storage_blobs
            WHERE key LIKE ${"transcoded/" + row.video_id + "/%"}
          `);
          const affected = (del as unknown as { rowCount?: number }).rowCount ?? 0;
          deletedTranscoded += affected;
          logger.debug(
            { videoId: row.video_id, blobs: affected, newestAt: row.newest_blob_at },
            "[storage-blob-recovery] deleted orphaned transcoded HLS blobs",
          );
        } catch (delErr) {
          logger.warn(
            { err: delErr, videoId: row.video_id },
            "[storage-blob-recovery] failed to delete orphaned transcoded prefix (non-fatal)",
          );
        }
      }

      // ── Phase 2: Scan uploads/ orphaned blobs ─────────────────────────────
      // Blobs in uploads/ not referenced by any managed_videos objectPath or
      // localVideoUrl accumulate from failed imports, test uploads, and
      // sessions that were initiated but never finalized.
      const uploadsOrphansResult = await db.execute<{ orphaned_count: number }>(sql`
        SELECT COUNT(*)::int AS orphaned_count
        FROM storage_blobs sb
        WHERE sb.key LIKE 'uploads/%'
          AND NOT EXISTS (
            SELECT 1 FROM managed_videos mv
            WHERE mv.object_path = sb.key
               OR mv.local_video_url LIKE '%' || sb.key
          )
      `);
      const uploadsCount = Number(uploadsOrphansResult.rows[0]?.orphaned_count ?? 0);

      let deletedUploads = 0;
      if (autoDelete && uploadsCount > 0) {
        try {
          const delResult = await db.execute(sql`
            DELETE FROM storage_blobs
            WHERE key IN (
              SELECT sb.key FROM storage_blobs sb
              WHERE sb.key LIKE 'uploads/%'
                AND sb.updated_at < ${cutoff}
                AND NOT EXISTS (
                  SELECT 1 FROM managed_videos mv
                  WHERE mv.object_path = sb.key
                     OR mv.local_video_url LIKE '%' || sb.key
                )
              ORDER BY sb.updated_at
              LIMIT 500
            )
          `);
          deletedUploads = (delResult as unknown as { rowCount?: number }).rowCount ?? 0;
          if (deletedUploads > 0) {
            logger.info(
              { deletedUploads, minAgeHours },
              "[storage-blob-recovery] auto-deleted orphaned upload blobs",
            );
          }
        } catch (delErr) {
          logger.warn(
            { err: delErr },
            "[storage-blob-recovery] failed to delete orphaned upload blobs (non-fatal)",
          );
        }
      }

      // ── Metrics + alerting ─────────────────────────────────────────────────
      const totalOrphaned = transcodedCount + uploadsCount;
      const totalDeleted = deletedTranscoded + deletedUploads;
      const belowAgeThreshold = transcodedCount - deletableTranscoded.length;

      this.stats.orphanedBlobCount = totalOrphaned;
      this.stats.deletedOrphanBlobCount += totalDeleted;

      if (totalOrphaned > 0) {
        logger.warn(
          {
            orphanedTranscodedPrefixes: transcodedCount,
            orphanedUploadBlobs: uploadsCount,
            deletedTranscoded,
            deletedUploads,
            belowAgeThresholdPrefixes: belowAgeThreshold,
            minAgeHours,
            autoDelete,
          },
          "[storage-blob-recovery] orphaned blob scan complete",
        );
      }

      if (totalDeleted > 0) {
        adminEventBus.push("ops-alert", {
          level: "info",
          component: "storage-blob-recovery",
          message:
            `Auto-deleted ${totalDeleted} orphaned storage blob(s): ` +
            `${deletedTranscoded} HLS segment blob(s) from ${deletableTranscoded.length} abandoned video prefix(es), ` +
            `${deletedUploads} orphaned upload blob(s). ` +
            `All deleted blobs had no managed_videos row and were older than ${minAgeHours} h.` +
            (belowAgeThreshold > 0
              ? ` ${belowAgeThreshold} transcoded prefix(es) are still within the age quarantine window — they will be deleted on the next pass once they age out.`
              : ""),
          deletedTranscoded,
          deletedUploads,
          retainedBelowAgeThreshold: belowAgeThreshold,
          minAgeHours,
        });
      } else if (totalOrphaned > 0 && !autoDelete) {
        adminEventBus.push("ops-alert", {
          level: "warn",
          component: "storage-blob-recovery",
          message:
            `${totalOrphaned} orphaned blob entries detected in storage_blobs ` +
            `(${transcodedCount} transcoded HLS prefix(es), ${uploadsCount} upload blob(s)) ` +
            "with no corresponding managed_videos row. " +
            "Set ORPHAN_BLOB_AUTO_DELETE=true to enable automatic cleanup " +
            "(default: enabled; blobs are only deleted after ORPHAN_BLOB_MIN_AGE_HOURS = " +
            `${minAgeHours} h).`,
          orphanedTranscodedPrefixes: transcodedCount,
          orphanedUploadBlobs: uploadsCount,
          total: totalOrphaned,
        });
      }

      return totalOrphaned;
    } catch (err) {
      logger.warn({ err }, "[storage-blob-recovery] orphaned blob scan failed (non-fatal)");
      return 0;
    }
  }
}

export const storageBlobRecoveryService = new StorageBlobRecoveryServiceImpl();
