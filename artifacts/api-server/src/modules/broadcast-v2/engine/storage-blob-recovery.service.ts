/**
 * Storage blob recovery service — MP4-only pipeline.
 *
 * Provides on-demand, single-item ("waterfall") recovery for a video/queue
 * item whose blob is missing from `storage_blobs`, plus the accumulated
 * telemetry surfaced on the admin storage-health dashboards.
 *
 * This is a thin, focused layer on top of the same lossless
 * verify-then-reassemble strategy used by the periodic
 * `upload-integrity-monitor` scan (see `findReassemblyContext`): if the
 * original upload's parts are still staged in `storage_upload_parts`, the
 * session is re-enrolled into the normal reassembly-reconciliation path so
 * the blob is rebuilt byte-for-byte and fully re-validated. Only when no
 * parts remain to recover from does this fall back to deactivating the
 * queue reference (last resort — never silent).
 *
 * Historical note: an earlier version of this service targeted the old
 * HLS/S3 pipeline (redownload from CDN, tiered variant recovery) and was
 * stubbed out to `{ok:false}` when that pipeline was removed. This rewrite
 * replaces the stub with the MP4-only equivalent instead of leaving the
 * admin "repair" action and health telemetry permanently dead.
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger as rootLogger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { findReassemblyContext } from "../../media-uploads/upload-integrity-monitor.js";

const logger = rootLogger.child({ module: "storage-blob-recovery" });
const videos = schema.videosTable;
const queue = schema.broadcastQueueTable;
const blobs = schema.storageBlobsTable;

const QUERY_TIMEOUT_MS = 10_000;
const MAX_ORPHAN_SCAN = 50;

export type RecoveryTier = "already_present" | "reassembly_reenrolled" | "deactivated" | "not_found";
export interface RecoveryResult {
  ok: boolean;
  tier?: RecoveryTier;
  reason?: string;
}
export interface RecoveryStats {
  attempted: number;
  recovered: number;
  failed: number;
  itemsChecked: number;
  blobsVerified: number;
  gapsFound: number;
  recoveries: number;
  orphanedBlobCount: number;
  deletedOrphanBlobCount: number;
  consecutiveErrors: number;
  lastRunAt: number | null;
  lastPassElapsedMs: number | null;
}
export interface GapRecord {
  queueId: string;
  videoId: string | null;
  reason: string;
}
export interface FailureRecord {
  consecutiveGaps: number;
  lastGapAtMs: number | null;
  reason: string | null;
}

function freshStats(): RecoveryStats {
  return {
    attempted: 0,
    recovered: 0,
    failed: 0,
    itemsChecked: 0,
    blobsVerified: 0,
    gapsFound: 0,
    recoveries: 0,
    orphanedBlobCount: 0,
    deletedOrphanBlobCount: 0,
    consecutiveErrors: 0,
    lastRunAt: null,
    lastPassElapsedMs: null,
  };
}

/** Extract rows from a Drizzle execute() result regardless of driver version. */
function extractRows<T>(result: unknown): T[] {
  if (!result) return [];
  const r = result as { rows?: T[] } | T[];
  if (Array.isArray(r)) return r as T[];
  return (r as { rows?: T[] }).rows ?? [];
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]).then((r) => {
      if (r === null) logger.warn({ label }, "[storage-blob-recovery] query timed out");
      return r;
    });
  } catch (err) {
    logger.warn({ err, label }, "[storage-blob-recovery] query failed");
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deriveKey(objectPath: string | null, localVideoUrl: string | null): string | null {
  if (objectPath) return objectPath;
  if (!localVideoUrl) return null;
  const m = localVideoUrl.match(/\/(?:api\/v1\/|api\/)?uploads\/(.+)$/);
  return m ? `uploads/${m[1]}` : localVideoUrl.startsWith("uploads/") ? localVideoUrl : null;
}

class StorageBlobRecoveryServiceImpl {
  private stats: RecoveryStats = freshStats();
  private failures = new Map<string, FailureRecord>();

  /**
   * Attempt recovery for a single video or active-queue-item id.
   * Accepts either a `videos.id` or a `broadcast_queue.id` — whichever
   * resolves is used.
   */
  async runWaterfall(idOrQueueId: string): Promise<RecoveryResult> {
    this.stats.attempted += 1;
    try {
      let video = await withTimeout(
        db
          .select({ id: videos.id, objectPath: videos.objectPath, localVideoUrl: videos.localVideoUrl })
          .from(videos)
          .where(eq(videos.id, idOrQueueId))
          .limit(1)
          .then((r) => r[0] ?? null),
        QUERY_TIMEOUT_MS,
        `recovery-find-video:${idOrQueueId}`,
      );

      let queueRow: { id: string; videoId: string | null; localVideoUrl: string | null } | null = null;
      if (!video) {
        queueRow = await withTimeout(
          db
            .select({ id: queue.id, videoId: queue.videoId, localVideoUrl: queue.localVideoUrl })
            .from(queue)
            .where(eq(queue.id, idOrQueueId))
            .limit(1)
            .then((r) => r[0] ?? null),
          QUERY_TIMEOUT_MS,
          `recovery-find-queue:${idOrQueueId}`,
        );
        if (queueRow?.videoId) {
          video = await withTimeout(
            db
              .select({ id: videos.id, objectPath: videos.objectPath, localVideoUrl: videos.localVideoUrl })
              .from(videos)
              .where(eq(videos.id, queueRow.videoId))
              .limit(1)
              .then((r) => r[0] ?? null),
            QUERY_TIMEOUT_MS,
            `recovery-find-video-via-queue:${idOrQueueId}`,
          );
        }
      }

      if (!video) {
        this.stats.failed += 1;
        return { ok: false, tier: "not_found", reason: "no matching video or queue item" };
      }

      const key = deriveKey(video.objectPath, video.localVideoUrl ?? queueRow?.localVideoUrl ?? null);
      if (!key) {
        this.stats.failed += 1;
        return { ok: false, reason: "video has no derivable storage key (external source?)" };
      }

      const present = await withTimeout(
        db
          .select({ key: blobs.key })
          .from(blobs)
          .where(eq(blobs.key, key))
          .limit(1)
          .then((r) => r.length > 0),
        QUERY_TIMEOUT_MS,
        `recovery-check-blob:${key}`,
      );

      if (present) {
        this.failures.delete(video.id);
        this.stats.recovered += 1;
        return { ok: true, tier: "already_present", reason: "blob already present" };
      }

      // ── Gap confirmed — record it ──────────────────────────────────────
      this.stats.gapsFound += 1;
      const prior = this.failures.get(video.id);
      this.failures.set(video.id, {
        consecutiveGaps: (prior?.consecutiveGaps ?? 0) + 1,
        lastGapAtMs: Date.now(),
        reason: "blob missing from storage_blobs",
      });

      const recovery = await findReassemblyContext(video.id);
      if (recovery?.recoverable) {
        const resetResult = await withTimeout(
          db.execute<{ session_id: string }>(sql`
            UPDATE upload_sessions
            SET status = 'uploading',
                assembly_attempts = 1,
                updated_at = NOW() - INTERVAL '1 hour'
            WHERE session_id = ${recovery.sessionId}
              AND status = 'completed'
            RETURNING session_id
          `),
          QUERY_TIMEOUT_MS,
          `recovery-reset-session:${recovery.sessionId}`,
        );
        const claimed = extractRows<{ session_id: string }>(resetResult).length > 0;
        if (claimed) {
          await withTimeout(
            db
              .update(videos)
              .set({ s3MirroredAt: null, transcodingStatus: "none", transcodingErrorCode: null, transcodingErrorMessage: null })
              .where(eq(videos.id, video.id)),
            QUERY_TIMEOUT_MS,
            `recovery-reset-video:${video.id}`,
          );
          adminEventBus.push("videos-library-updated", { videoId: video.id, reason: "manual-storage-repair-reenroll" });
          this.stats.recovered += 1;
          this.stats.recoveries += 1;
          logger.info({ videoId: video.id, key }, "[storage-blob-recovery] re-enrolled session for reassembly");
          return { ok: true, tier: "reassembly_reenrolled", reason: "upload parts still staged — reassembly re-enrolled" };
        }
      }

      // ── Not recoverable — deactivate the queue reference so it stops
      // being selected for air, but never silently drop the video row. ──
      let deactivated = false;
      if (queueRow) {
        const res = await withTimeout(
          db.update(queue).set({ isActive: false }).where(eq(queue.id, queueRow.id)),
          QUERY_TIMEOUT_MS,
          `recovery-deactivate-queue:${queueRow.id}`,
        );
        deactivated = res !== null;
      } else {
        const res = await withTimeout(
          db.update(queue).set({ isActive: false }).where(eq(queue.videoId, video.id)),
          QUERY_TIMEOUT_MS,
          `recovery-deactivate-queue-by-video:${video.id}`,
        );
        deactivated = res !== null;
      }

      this.stats.failed += 1;
      logger.warn({ videoId: video.id, key, deactivated }, "[storage-blob-recovery] unrecoverable gap — deactivated queue reference");
      return {
        ok: false,
        tier: deactivated ? "deactivated" : undefined,
        reason: "blob missing and no staged upload parts remain — re-upload required",
      };
    } catch (err) {
      this.stats.failed += 1;
      this.stats.consecutiveErrors += 1;
      logger.warn({ err, id: idOrQueueId }, "[storage-blob-recovery] runWaterfall failed");
      return { ok: false, reason: "internal error during recovery" };
    }
  }

  async runBulkWaterfall(queueIds: string[]): Promise<RecoveryStats> {
    const start = Date.now();
    for (const id of queueIds) {
      await this.runWaterfall(id);
    }
    await this.scanOrphanedBlobs();
    this.stats.lastRunAt = Date.now();
    this.stats.lastPassElapsedMs = Date.now() - start;
    return { ...this.stats };
  }

  /**
   * Track blob-existence checks driven by an external caller (e.g. the
   * periodic storage-reconciliation worker) so the dashboard stats reflect
   * activity even when no gap requires waterfall recovery.
   */
  recordScan(itemsChecked: number, blobsVerified: number, elapsedMs: number, errored: boolean): void {
    this.stats.itemsChecked += itemsChecked;
    this.stats.blobsVerified += blobsVerified;
    this.stats.lastRunAt = Date.now();
    this.stats.lastPassElapsedMs = elapsedMs;
    this.stats.consecutiveErrors = errored ? this.stats.consecutiveErrors + 1 : 0;
  }

  /**
   * Bounded scan for storage_blobs rows with no referencing videos.objectPath.
   * Read-only telemetry only — does not delete (deletion is handled by the
   * dedicated orphaned-parts/blob GC passes in upload-integrity-monitor).
   */
  async scanOrphanedBlobs(): Promise<void> {
    try {
      const result = await withTimeout(
        db.execute<{ cnt: string }>(sql`
          SELECT COUNT(*)::text AS cnt
          FROM storage_blobs sb
          WHERE NOT EXISTS (
            SELECT 1 FROM managed_videos v WHERE v.object_path = sb.key
          )
          LIMIT ${MAX_ORPHAN_SCAN}
        `),
        QUERY_TIMEOUT_MS,
        "recovery-scan-orphaned-blobs",
      );
      const [row] = extractRows<{ cnt: string }>(result);
      const cnt = parseInt(row?.cnt ?? "0", 10);
      this.stats.orphanedBlobCount = Number.isFinite(cnt) ? cnt : this.stats.orphanedBlobCount;
    } catch (err) {
      logger.warn({ err }, "[storage-blob-recovery] scanOrphanedBlobs failed (non-fatal)");
    }
  }

  getStats(): RecoveryStats {
    return { ...this.stats };
  }

  getFailureRegistry(): Map<string, FailureRecord> {
    return new Map(this.failures);
  }
}

export const storageBlobRecoveryService = new StorageBlobRecoveryServiceImpl();
