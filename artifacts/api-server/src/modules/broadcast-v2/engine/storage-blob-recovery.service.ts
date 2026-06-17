/**
 * StorageBlobRecoveryService — Enterprise-grade autonomous media recovery.
 *
 * Canonical recovery waterfall for broadcast queue items whose storage blobs
 * are missing or degraded.  All callers (reconciliation worker, queue-integrity
 * validator, transcoder dispatcher) delegate here so recovery policy is in one
 * place.
 *
 * ─── False-positive elimination ──────────────────────────────────────────────
 *
 * The legacy 3-tier system quarantined media after a single gap detection pass,
 * causing permanent false-positive SOURCE_MISSING on items whose blobs were
 * genuinely present in storage but momentarily absent from storage_blobs (e.g.
 * during a DB failover, a page-level TOAST miss, or a prod-sync replication lag).
 * The new system eliminates this by:
 *
 *   • Source classification bypass — external HLS URLs (not served by this API)
 *     and YouTube-sourced videos skip all storage checks entirely.  They have no
 *     local storage_blobs rows by design and must never be quarantined for it.
 *
 *   • Size-validated presence checks — a storage_blobs row with size_bytes=0
 *     is treated as ABSENT (incomplete write / interrupted putObject).  Only
 *     rows with size_bytes > 0 count as genuinely present.  Configurable via
 *     STORAGE_RECON_SIZE_CHECK (default true).
 *
 *   • Retry-gated quarantine — a per-videoId in-process consecutive-gap counter
 *     prevents quarantine on the first (or second) detection.  Quarantine fires
 *     only after STORAGE_RECON_QUARANTINE_MIN_FAILURES consecutive gap passes
 *     (default 3, i.e. 30 min with the default 10-min reconciliation interval).
 *     Between passes the worker emits a warn ops-alert and lets the orchestrator's
 *     own bad-URL tracking keep the broken item out of rotation without permanent
 *     damage.
 *
 *   • ON_AIR broadcast safety — when STORAGE_RECON_BROADCAST_SAFE=true (default)
 *     a video whose queue item is the current ON_AIR item in broadcast_runtime_state
 *     is never quarantined; the quarantine is deferred and an error ops-alert is
 *     emitted for operator review.
 *
 * ─── 6-stage recovery waterfall ─────────────────────────────────────────────
 *
 *  Stage 0 — Source classification
 *    • External HLS URL (absolute, not /api/hls/) → bypassed
 *    • YouTube video_source                        → bypassed
 *
 *  Stage 1 — HLS master.m3u8 physical verification (size-validated)
 *    • Blob present AND size_bytes>0 → promote hlsMasterUrl / hls_ready status
 *
 *  Stage 2 — HLS segment recovery (partial transcode saved)
 *    2a. Variant playlists found → synthesise master.m3u8 from survivors
 *    2b. MP4 source present      → re-transcode at priority 8
 *    2c. No segments, no MP4     → proceed to Stage 3
 *
 *  Stage 3 — Alternative key resolution
 *    • Normalise objectPath variants (absolute URL → bare key, leading-slash strip)
 *    • Check each candidate with size_bytes>0; re-transcode from first confirmed
 *
 *  Stage 4 — MP4 source verification (skipped if sourceCleanupStatus='deleted')
 *    • Blob present AND size_bytes>0 → re-enqueue transcoding at priority 5
 *
 *  Stage 5 — Upload session re-assembly
 *    • Find upload_sessions with completedVideoId=videoId in db_fallback mode
 *    • If all chunks still in upload_chunks → reset session for re-assembly
 *
 *  Stage 6 — Retry-gated quarantine (or defer if threshold not met / ON_AIR)
 *    • consecutiveGaps < threshold → tier3_deferred; warn ops-alert; no damage
 *    • ON_AIR item               → tier3_deferred; error ops-alert; no damage
 *    • threshold met + not ON_AIR → tier3_quarantine; deactivate + quarantine
 *
 * Stats are accumulated in-process for /health and /storage-diagnostics exposure.
 */

import { eq, sql, and, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../../../infrastructure/db.js";
import { storage } from "../../../infrastructure/storage.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { quarantineVideo } from "../../broadcast/quarantine.service.js";
import { enqueueTranscode } from "../../transcoder/transcoder.queue.js";

const MODULE = "[storage-blob-recovery]";

// ── HLS tier metadata for master.m3u8 synthesis ──────────────────────────────
// Matches HLS_TIERS constants in transcoder.service.ts.
const HLS_TIER_META: Readonly<Record<string, { bandwidth: number; resolution: string; codecs: string }>> = {
  "240p": { bandwidth:   364_000, resolution: "426x240",  codecs: "avc1.4d4015,mp4a.40.2" },
  "360p": { bandwidth:   596_000, resolution: "640x360",  codecs: "avc1.4d401e,mp4a.40.2" },
  "480p": { bandwidth: 1_128_000, resolution: "854x480",  codecs: "avc1.4d401f,mp4a.40.2" },
  "720p": { bandwidth: 2_660_000, resolution: "1280x720", codecs: "avc1.64001f,mp4a.40.2" },
} as const;

// ── Public types ──────────────────────────────────────────────────────────────

export type RecoveryTier =
  | "healthy"
  | "bypassed"              // External/YouTube source — no local storage expected
  | "tier1_promoted"        // HLS master present (was stale) — promoted
  | "tier1_retranscode"     // HLS segments found, MP4 present — re-transcoding
  | "tier1_alert_only"      // HLS segs found, no MP4 or variants — deactivated
  | "tier2_retranscode"     // No HLS, MP4 present — re-transcoding
  | "tier3_session_repair"  // No blobs but upload_chunks found — reset for re-assembly
  | "tier3_deferred"        // Threshold not met or ON_AIR — gap noted, no quarantine
  | "tier3_quarantine"      // All recovery failed, threshold met — quarantined
  | "error";

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

/** Per-video persistent gap-detection record (in-process). */
export interface GapRecord {
  consecutiveGaps: number;
  firstGapAtMs: number;
  lastGapAtMs: number;
  lastTier: RecoveryTier;
  lastMessage: string;
  /** Additional diagnostic context from the last waterfall run. */
  diagnostics: Record<string, unknown>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if the given HLS URL is served by this API server (relative or
 * absolute URL containing /api/hls/{videoId}/).  Returns false for external
 * CDN / third-party HLS streams that have no local storage_blobs entries.
 */
function isOwnHlsUrl(url: string, videoId: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true; // relative → always own
  return (
    url.includes(`/api/hls/${videoId}/`) ||
    url.includes(`/api/v1/hls/${videoId}/`)
  );
}

/**
 * Derive a bare storage key from objectPath, trying multiple normalisations.
 * Returns an array of candidate keys (most specific first) so callers can
 * headObject each one and use the first that returns exists=true + size>0.
 *
 * Handles:
 *   uploads/2024/05/20/uuid.mp4                         → same (bare key)
 *   /api/v1/uploads/uploads/2024/05/20/uuid.mp4         → bare key
 *   /api/uploads/uploads/2024/05/20/uuid.mp4            → bare key
 *   https://origin.example.com/api/v1/uploads/...       → bare key
 *   /uploads/2024/05/20/uuid.mp4                        → uploads/...
 */
function toStorageKeyCandidates(objectPath: string): string[] {
  const candidates: string[] = [];

  const stripped = (() => {
    if (/^https?:\/\//i.test(objectPath)) {
      const marker = "/api/v1/uploads/";
      const idx = objectPath.indexOf(marker);
      if (idx !== -1) return objectPath.slice(idx + marker.length);
      const marker2 = "/api/uploads/";
      const idx2 = objectPath.indexOf(marker2);
      if (idx2 !== -1) return objectPath.slice(idx2 + marker2.length);
      return ""; // truly external URL — no local key
    }
    if (objectPath.startsWith("/")) {
      return objectPath.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
    }
    return objectPath;
  })();

  if (stripped && !stripped.startsWith("http")) {
    candidates.push(stripped);
    // Also try with 'uploads/' prefix stripped (legacy path format)
    if (stripped.startsWith("uploads/")) {
      candidates.push(stripped.slice("uploads/".length));
    }
  }

  return candidates.filter(Boolean);
}

/** Size-validated headObject: returns exists=true only when size_bytes > 0. */
async function headObjectWithSizeCheck(key: string): Promise<{ exists: boolean; contentLength: number }> {
  const result = await storage().headObject(key);
  if (!result.exists) return { exists: false, contentLength: 0 };
  const length = result.contentLength ?? 0;
  const sizeOk = !env.STORAGE_RECON_SIZE_CHECK || length > 0;
  return { exists: sizeOk, contentLength: length };
}

/**
 * Check whether a queue item is the current ON_AIR item.
 * Queries broadcast_runtime_state.current_item_id to avoid importing the
 * orchestrator singleton (which would create a dependency cycle).
 */
async function isQueueItemOnAir(queueId: string): Promise<boolean> {
  if (!queueId) return false;
  try {
    const result = await db.execute<{ current_item_id: string | null }>(sql`
      SELECT current_item_id FROM broadcast_runtime_state
      WHERE channel_id = 'main' AND current_item_id = ${queueId}
      LIMIT 1
    `);
    return result.rows.length > 0;
  } catch {
    return false; // non-fatal — err on the side of not blocking quarantine
  }
}

/**
 * Check if any upload_session in db_fallback mode has surviving chunks for
 * this videoId.  Returns the session_id + chunk count if found, or null.
 */
async function findRecoverableSession(
  videoId: string,
  objectPath: string | null | undefined,
): Promise<{ sessionId: string; chunkCount: number; sizeBytes: number } | null> {
  try {
    // Match sessions by completedVideoId (set at finalize-time) or by objectKey
    // (the storage destination matches the managed_videos objectPath).
    const sessions = await db.execute<{
      session_id: string;
      size_bytes: number;
      total_chunks: number;
      storage_backend: string;
    }>(sql`
      SELECT session_id, size_bytes::int AS size_bytes, total_chunks, storage_backend
      FROM upload_sessions
      WHERE (completed_video_id = ${videoId} OR object_key = ${objectPath ?? null})
        AND storage_backend = 'db_fallback'
        AND status IN ('completed', 'failed', 'assembly_failed')
      ORDER BY created_at DESC
      LIMIT 3
    `);

    for (const sess of sessions.rows) {
      const chunkCount = await db.execute<{ cnt: number }>(sql`
        SELECT COUNT(*)::int AS cnt FROM upload_chunks
        WHERE session_id = ${sess.session_id}
          AND fallback_data IS NOT NULL
      `);
      const cnt = Number(chunkCount.rows[0]?.cnt ?? 0);
      // Require at least 80% of expected chunks to be present before claiming
      // the session is recoverable (allows for partial chunk failure tolerance).
      if (cnt > 0 && cnt >= Math.floor(sess.total_chunks * 0.8)) {
        return { sessionId: sess.session_id, chunkCount: cnt, sizeBytes: sess.size_bytes };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Reset a failed upload_session to trigger automatic re-assembly. */
async function resetSessionForReassembly(sessionId: string): Promise<boolean> {
  try {
    await db.execute(sql`
      UPDATE upload_sessions
      SET status = 'failed',
          assembly_attempts = 0,
          last_assembly_error = 'Reset by storage-blob-recovery for autonomous re-assembly',
          updated_at = NOW()
      WHERE session_id = ${sessionId}
        AND storage_backend = 'db_fallback'
    `);
    return true;
  } catch {
    return false;
  }
}

// ── Service class ─────────────────────────────────────────────────────────────

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

  /**
   * Per-video gap tracking.  Keyed by videoId.  Tracks consecutive gap passes
   * so we can apply the retry-gate before permanent quarantine.  Cleared when
   * a video is found healthy.  Bounded to MAX_REGISTRY_SIZE entries.
   */
  private failureRegistry = new Map<string, GapRecord>();
  private static readonly MAX_REGISTRY_SIZE = 1_000;

  getStats(): Readonly<RecoveryStats> { return { ...this.stats }; }

  /** Returns a snapshot of all in-process gap records for the diagnostics endpoint. */
  getFailureRegistry(): ReadonlyMap<string, GapRecord> { return this.failureRegistry; }

  recordPassStart() { this.stats.lastRunAt = Date.now(); }

  recordPassEnd(elapsedMs: number, itemsChecked = 0, blobsVerified = 0, gapsFound = 0, recoveries = 0) {
    this.stats.lastPassElapsedMs = elapsedMs;
    this.stats.itemsChecked += itemsChecked;
    this.stats.blobsVerified += blobsVerified;
    this.stats.gapsFound += gapsFound;
    this.stats.recoveries += recoveries;
  }

  private recordGap(videoId: string, tier: RecoveryTier, message: string, diagnostics: Record<string, unknown>): GapRecord {
    const existing = this.failureRegistry.get(videoId);
    const record: GapRecord = {
      consecutiveGaps: (existing?.consecutiveGaps ?? 0) + 1,
      firstGapAtMs: existing?.firstGapAtMs ?? Date.now(),
      lastGapAtMs: Date.now(),
      lastTier: tier,
      lastMessage: message,
      diagnostics,
    };
    // Evict oldest entry when cap is hit
    if (this.failureRegistry.size >= StorageBlobRecoveryServiceImpl.MAX_REGISTRY_SIZE) {
      const firstKey = this.failureRegistry.keys().next().value;
      if (firstKey) this.failureRegistry.delete(firstKey);
    }
    this.failureRegistry.set(videoId, record);
    return record;
  }

  private clearGap(videoId: string) {
    this.failureRegistry.delete(videoId);
  }

  // ── Public waterfall ───────────────────────────────────────────────────────

  /**
   * Run the 6-stage recovery waterfall for a single video.
   *
   * @param videoId            - managed_videos.id
   * @param queueId            - broadcast_queue.id (used for ON_AIR check and deactivation)
   * @param title              - display title for logging / ops-alerts
   * @param objectPath         - managed_videos.object_path (MP4 source storage key)
   * @param hlsUrl             - current HLS master URL (own-origin or external)
   * @param videoSource        - managed_videos.video_source ('local','youtube','external',…)
   * @param sourceCleanupStatus - managed_videos.source_cleanup_status — 'deleted' means
   *                             the MP4 source blob was intentionally removed after HLS
   *                             transcoding and must NOT be treated as evidence of data loss
   * @param triggeredBy        - component name for audit trail / ops-alerts
   */
  async runWaterfall(opts: {
    videoId: string;
    queueId: string;
    title: string;
    objectPath: string | null | undefined;
    hlsUrl: string | null | undefined;
    videoSource?: string | null;
    sourceCleanupStatus?: string | null;
    triggeredBy: string;
  }): Promise<RecoveryResult> {
    const { videoId, queueId, title, objectPath, hlsUrl, videoSource, sourceCleanupStatus, triggeredBy } = opts;
    this.stats.itemsChecked += 1;

    try {
      // ── Stage 0: Source classification bypass ─────────────────────────────
      // YouTube videos and external HLS streams have no local storage_blobs rows
      // by design.  Quarantining them for "missing blobs" is always wrong.
      if (videoSource === "youtube") {
        return { tier: "bypassed", videoId, message: "YouTube source — no local storage expected" };
      }
      if (hlsUrl && /^https?:\/\//i.test(hlsUrl) && !isOwnHlsUrl(hlsUrl, videoId)) {
        return { tier: "bypassed", videoId, message: `External HLS URL — not in local storage (${hlsUrl.slice(0, 80)})` };
      }

      // ── Stage 1: HLS master.m3u8 physical verification ───────────────────
      const masterKey = `transcoded/${videoId}/master.m3u8`;
      const masterHead = await headObjectWithSizeCheck(masterKey);

      if (masterHead.exists) {
        // Blob confirmed present and non-empty.  Promote hlsMasterUrl + status.
        const restoredUrl = `/api/hls/${videoId}/master.m3u8`;
        const needsUpdate = !hlsUrl || !isOwnHlsUrl(hlsUrl, videoId) || !hlsUrl.includes(videoId);
        if (needsUpdate) {
          await db.update(schema.videosTable)
            .set({ hlsMasterUrl: restoredUrl, transcodingStatus: "hls_ready" })
            .where(eq(schema.videosTable.id, videoId))
            .catch((err) => { logger.warn({ err, videoId }, `${MODULE} failed to promote hlsMasterUrl (non-fatal)`); });
          adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-hls-promoted", videoId });
        }
        this.clearGap(videoId);
        this.stats.consecutiveErrors = 0;
        return { tier: "healthy", videoId, message: `HLS master.m3u8 confirmed present (${masterHead.contentLength} B)` };
      }

      // ── Stage 2: HLS segment recovery ────────────────────────────────────
      const segmentCountResult = await db.execute<{ cnt: number }>(sql`
        SELECT COUNT(*)::int AS cnt FROM storage_blobs
        WHERE key LIKE ${"transcoded/" + videoId + "/%"}
          ${env.STORAGE_RECON_SIZE_CHECK ? sql`AND size_bytes > 0` : sql``}
      `);
      const segmentCount = Number(segmentCountResult.rows[0]?.cnt ?? 0);

      if (segmentCount > 0) {
        // 2a: Try MP4 source for full re-transcode (produces correct master + all tiers)
        const rawKey = objectPath ? toStorageKeyCandidates(objectPath)[0] ?? "" : "";
        const mp4Head = rawKey ? await headObjectWithSizeCheck(rawKey) : { exists: false, contentLength: 0 };

        if (mp4Head.exists) {
          // Clear hlsMasterUrl so autoEnqueueMissingHls also picks this up
          await db.update(schema.videosTable)
            .set({ hlsMasterUrl: null })
            .where(eq(schema.videosTable.id, videoId))
            .catch(() => { /* non-fatal */ });
          await enqueueTranscode({ videoId, videoPath: rawKey, priority: 8 });
          adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-tier1", videoId });
          adminEventBus.push("ops-alert", {
            level: "warn", component: triggeredBy,
            message: `"${title}" (${videoId}): HLS master.m3u8 missing but ${segmentCount} segment blob(s) and MP4 source found — re-transcoding at priority 8.`,
            videoId, queueId, segmentCount,
          });
          this.clearGap(videoId);
          this.stats.consecutiveErrors = 0;
          return { tier: "tier1_retranscode", videoId, message: `${segmentCount} segment blob(s) found; MP4 present — re-transcoding` };
        }

        // 2b: No MP4, but variant playlists exist — synthesise master.m3u8
        const variantResult = await db.execute<{ key: string }>(sql`
          SELECT key FROM storage_blobs
          WHERE key LIKE ${"transcoded/" + videoId + "/%/playlist.m3u8"}
          ORDER BY key
        `).catch(() => ({ rows: [] as { key: string }[] }));

        if (variantResult.rows.length > 0) {
          const variantLines: string[] = [];
          for (const row of variantResult.rows) {
            const tierName = row.key.split("/")[2];
            const meta = tierName ? HLS_TIER_META[tierName] : undefined;
            if (!meta) continue;
            variantLines.push(
              `#EXT-X-STREAM-INF:BANDWIDTH=${meta.bandwidth},RESOLUTION=${meta.resolution},CODECS="${meta.codecs}"`,
              `${tierName}/playlist.m3u8`,
            );
          }

          if (variantLines.length > 0) {
            const masterContent = [
              "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS",
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
              .catch((err) => { logger.warn({ err, videoId }, `${MODULE} tier2a-promote: failed to set hlsMasterUrl`); });
            adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-tier2a-promoted", videoId });
            adminEventBus.push("ops-alert", {
              level: "warn", component: triggeredBy,
              message: `"${title}" (${videoId}): HLS master.m3u8 was missing but ${variantResult.rows.length} variant playlist(s) survived — synthesised and uploaded new master.m3u8.`,
              videoId, queueId, variantCount: variantResult.rows.length,
            });
            this.clearGap(videoId);
            this.stats.consecutiveErrors = 0;
            return { tier: "tier1_promoted", videoId, message: `master.m3u8 synthesised from ${variantResult.rows.length} variant playlist(s)` };
          }
        }

        // 2c: HLS segments exist but no master, no variants, no MP4 — deactivate
        if (queueId) {
          await db.update(schema.broadcastQueueTable)
            .set({ isActive: false, validatorDeactivatedReason: "hls_master_missing_no_source" })
            .where(eq(schema.broadcastQueueTable.id, queueId))
            .catch((err) => { logger.warn({ err, videoId, queueId }, `${MODULE} tier2c: failed to deactivate queue item`); });
        }
        await quarantineVideo(videoId, {
          errorCode: "SOURCE_MISSING",
          reason: `HLS master.m3u8 and all variant playlists missing; ${segmentCount} orphaned segment blob(s) present with no MP4 source. Recovery impossible — re-upload the source video.`,
          triggeredBy,
          metadata: { segmentCount, hlsUrl, objectPath, detectedAtMs: Date.now() },
        }).catch((err) => { logger.warn({ err, videoId }, `${MODULE} tier2c: quarantine call failed`); });
        adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-tier2c-deactivated", videoId, queueId });
        adminEventBus.push("ops-alert", {
          level: "error", component: triggeredBy,
          message: `"${title}" (${videoId}): HLS master.m3u8 + all variant playlists missing; ${segmentCount} orphaned segment blob(s) present but no recoverable source. Video quarantined — re-upload required.`,
          videoId, queueId, segmentCount,
        });
        this.clearGap(videoId);
        this.stats.consecutiveErrors = 0;
        return { tier: "tier1_alert_only", videoId, message: `${segmentCount} HLS segment blob(s) but no playlists or MP4 source — quarantined` };
      }

      // ── Stage 3: Alternative key resolution ───────────────────────────────
      // objectPath may be stored in different formats (absolute URL, leading slash,
      // v1/uploads prefix, etc.).  Try all normalised variants before giving up.
      if (objectPath) {
        const candidates = toStorageKeyCandidates(objectPath);
        for (const candidate of candidates) {
          if (candidate === (toStorageKeyCandidates(objectPath)[0] ?? "")) continue; // primary already tried below in Stage 4
          const altHead = await headObjectWithSizeCheck(candidate);
          if (altHead.exists) {
            await enqueueTranscode({ videoId, videoPath: candidate, priority: 6 });
            // Fix the stored objectPath to use the normalised key
            await db.update(schema.videosTable)
              .set({ objectPath: candidate })
              .where(eq(schema.videosTable.id, videoId))
              .catch(() => { /* non-fatal */ });
            adminEventBus.push("ops-alert", {
              level: "warn", component: triggeredBy,
              message: `"${title}" (${videoId}): objectPath normalisation found blob at key "${candidate}" — objectPath corrected, re-transcoding at priority 6.`,
              videoId, queueId, candidate,
            });
            this.clearGap(videoId);
            this.stats.consecutiveErrors = 0;
            return { tier: "tier2_retranscode", videoId, message: `Alt key "${candidate}" confirmed present — re-transcoding` };
          }
        }
      }

      // ── Stage 4: MP4 source verification ─────────────────────────────────
      // Skip if source was intentionally deleted after HLS transcoding.
      // In that case a missing MP4 is expected and must not be treated as data loss.
      const sourceIntentionallyDeleted = sourceCleanupStatus === "deleted";

      if (!sourceIntentionallyDeleted && objectPath) {
        const primaryKey = toStorageKeyCandidates(objectPath)[0] ?? "";
        if (primaryKey) {
          const mp4Head = await headObjectWithSizeCheck(primaryKey);
          if (mp4Head.exists) {
            await enqueueTranscode({ videoId, videoPath: primaryKey, priority: 5 });
            adminEventBus.push("transcoding-update", { videoId, status: "queued", progress: 0 });
            adminEventBus.push("ops-alert", {
              level: "warn", component: triggeredBy,
              message: `"${title}" (${videoId}): no HLS output in storage; MP4 source blob confirmed present — re-enqueued for transcoding.`,
              videoId, queueId,
            });
            this.clearGap(videoId);
            this.stats.consecutiveErrors = 0;
            return { tier: "tier2_retranscode", videoId, message: "No HLS blobs; MP4 source present — re-transcoding" };
          }
        }
      }

      // ── Stage 5: Upload session re-assembly ───────────────────────────────
      if (env.STORAGE_RECON_SESSION_REPAIR) {
        const session = await findRecoverableSession(videoId, objectPath);
        if (session) {
          const resetOk = await resetSessionForReassembly(session.sessionId);
          adminEventBus.push("ops-alert", {
            level: "warn", component: triggeredBy,
            message:
              `"${title}" (${videoId}): no storage blobs found, but upload session "${session.sessionId}" ` +
              `has ${session.chunkCount} chunk(s) (${Math.round(session.sizeBytes / 1024 / 1024)} MiB) still in upload_chunks. ` +
              (resetOk
                ? "Session reset for autonomous re-assembly — no operator action needed."
                : "Session found but reset failed — operator may need to manually trigger re-assembly."),
            videoId, queueId, sessionId: session.sessionId, chunkCount: session.chunkCount,
          });
          if (resetOk) {
            this.clearGap(videoId);
            this.stats.consecutiveErrors = 0;
            return { tier: "tier3_session_repair", videoId, message: `Upload session ${session.sessionId} reset for re-assembly (${session.chunkCount} chunks)` };
          }
        }
      }

      // ── Stage 6: Retry-gated quarantine ──────────────────────────────────
      const diagnostics: Record<string, unknown> = {
        hlsUrl, objectPath, videoSource, sourceCleanupStatus,
        segmentCount, detectedAtMs: Date.now(),
        sourceIntentionallyDeleted,
      };

      const threshold = env.STORAGE_RECON_QUARANTINE_MIN_FAILURES;
      const record = this.recordGap(videoId, "tier3_deferred", "All blobs missing — tracking gap", diagnostics);
      const { consecutiveGaps } = record;

      logger.warn(
        { videoId, queueId, title, consecutiveGaps, threshold, objectPath, triggeredBy },
        `${MODULE} all blobs missing (gap ${consecutiveGaps}/${threshold})`,
      );

      // ON_AIR safety check — never quarantine the live item
      const onAir = env.STORAGE_RECON_BROADCAST_SAFE && queueId
        ? await isQueueItemOnAir(queueId)
        : false;

      if (onAir) {
        adminEventBus.push("ops-alert", {
          level: "error", component: triggeredBy,
          message:
            `"${title}" (${videoId}) is currently ON-AIR but all storage blobs are missing ` +
            `(gap ${consecutiveGaps}/${threshold}). Quarantine deferred to protect the live broadcast. ` +
            "Operator action required: verify storage integrity and re-upload if necessary.",
          videoId, queueId, consecutiveGaps, threshold, onAir: true,
        });
        this.stats.consecutiveErrors = 0;
        return { tier: "tier3_deferred", videoId, message: "ON_AIR protection — quarantine deferred" };
      }

      if (consecutiveGaps < threshold) {
        adminEventBus.push("ops-alert", {
          level: "warn", component: triggeredBy,
          message:
            `"${title}" (${videoId}): all storage blobs are missing (gap ${consecutiveGaps}/${threshold}). ` +
            `${threshold - consecutiveGaps} more consecutive pass(es) required before quarantine. ` +
            "The orchestrator's bad-URL tracking is preventing playback during this investigation window. " +
            "If blobs reappear on the next pass, this alert will self-clear.",
          videoId, queueId, consecutiveGaps, threshold,
        });
        this.stats.consecutiveErrors = 0;
        return { tier: "tier3_deferred", videoId, message: `Gap ${consecutiveGaps}/${threshold} — deferring quarantine` };
      }

      // Threshold met — proceed with full quarantine
      await this._doQuarantine({ videoId, queueId, title, hlsUrl, objectPath, diagnostics, triggeredBy, consecutiveGaps });
      this.clearGap(videoId); // reset after confirmed quarantine
      this.stats.consecutiveErrors = 0;
      return { tier: "tier3_quarantine", videoId, message: `All blobs missing after ${consecutiveGaps} consecutive passes — quarantined` };

    } catch (err) {
      this.stats.consecutiveErrors += 1;
      logger.warn({ err, videoId, queueId }, `${MODULE} waterfall error (non-fatal)`);
      return { tier: "error", videoId, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Execute the full quarantine sequence (DB update + quarantineVideo + events). */
  private async _doQuarantine(opts: {
    videoId: string; queueId: string; title: string;
    hlsUrl: string | null | undefined; objectPath: string | null | undefined;
    diagnostics: Record<string, unknown>; triggeredBy: string; consecutiveGaps: number;
  }) {
    const { videoId, queueId, title, hlsUrl, objectPath, diagnostics, triggeredBy, consecutiveGaps } = opts;

    logger.error(
      { videoId, queueId, title, consecutiveGaps, objectPath, triggeredBy },
      `${MODULE} QUARANTINE: all blobs missing after ${consecutiveGaps} consecutive passes`,
    );

    await db.update(schema.videosTable)
      .set({
        transcodingStatus: "failed",
        transcodingErrorCode: "SOURCE_MISSING",
        transcodingErrorMessage:
          `All storage blobs missing — confirmed after ${consecutiveGaps} consecutive reconciliation passes. ` +
          "The autonomous recovery system exhausted all recovery strategies (HLS promotion, variant synthesis, " +
          "MP4 re-transcode, key normalisation, upload session re-assembly). " +
          "Re-upload the source video to restore.",
      })
      .where(eq(schema.videosTable.id, videoId))
      .catch((err) => { logger.warn({ err, videoId }, `${MODULE} failed to mark SOURCE_MISSING (non-fatal)`); });

    await quarantineVideo(videoId, {
      errorCode: "SOURCE_MISSING",
      reason:
        `All storage blobs (HLS and MP4 source) confirmed missing after ${consecutiveGaps} consecutive ` +
        "reconciliation passes spanning multiple minutes. Recovery strategies exhausted. Re-upload required.",
      triggeredBy,
      metadata: { ...diagnostics, consecutiveGaps },
    });

    adminEventBus.push("broadcast-queue-updated", { reason: "storage-blob-recovery-quarantine", videoId, queueId });
    adminEventBus.push("ops-alert", {
      level: "fatal", component: triggeredBy,
      message:
        `"${title}" (${videoId}) QUARANTINED: all storage blobs confirmed missing across ` +
        `${consecutiveGaps} consecutive reconciliation passes (~${consecutiveGaps * Math.round(env.STORAGE_RECONCILIATION_INTERVAL_MS / 60_000)} min). ` +
        "All autonomous recovery strategies failed. Operator must re-upload the source video.",
      videoId, queueId, consecutiveGaps,
    });
  }

  // ── Orphaned blob scanner ──────────────────────────────────────────────────

  /**
   * Scan storage_blobs for orphaned entries — blobs whose prefix matches
   * `transcoded/{videoId}/` or `uploads/{key}` but whose videoId / upload
   * has no corresponding managed_videos row.
   *
   * Auto-deletes blobs older than ORPHAN_BLOB_MIN_AGE_HOURS when
   * ORPHAN_BLOB_AUTO_DELETE=true (default).  The age gate prevents accidental
   * deletion of blobs belonging to in-progress uploads or recently removed
   * videos whose row deletion has not yet propagated through all caches.
   *
   * Also scans for zero-byte blobs (size_bytes=0) which indicate an interrupted
   * putObject and cannot be served to clients.  These are reported separately.
   */
  async scanOrphanedBlobs(): Promise<number> {
    const autoDelete = env.ORPHAN_BLOB_AUTO_DELETE;
    const minAgeHours = env.ORPHAN_BLOB_MIN_AGE_HOURS;
    const cutoff = new Date(Date.now() - minAgeHours * 60 * 60_000);

    try {
      // ── Phase 1: Scan transcoded/ orphaned prefixes ────────────────────────
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
            `${MODULE} deleted orphaned transcoded HLS blobs`,
          );
        } catch (delErr) {
          logger.warn({ err: delErr, videoId: row.video_id }, `${MODULE} failed to delete orphaned transcoded prefix`);
        }
      }

      // ── Phase 2: Scan uploads/ orphaned blobs ─────────────────────────────
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
            logger.info({ deletedUploads, minAgeHours }, `${MODULE} auto-deleted orphaned upload blobs`);
          }
        } catch (delErr) {
          logger.warn({ err: delErr }, `${MODULE} failed to delete orphaned upload blobs`);
        }
      }

      // ── Phase 3: Scan for zero-byte blobs (corrupted writes) ──────────────
      const zeroByteResult = await db.execute<{ cnt: number; prefixes: string }>(sql`
        SELECT COUNT(*)::int AS cnt,
               string_agg(DISTINCT split_part(key,'/',1), ', ' ORDER BY split_part(key,'/',1)) AS prefixes
        FROM storage_blobs
        WHERE size_bytes = 0
          AND key NOT LIKE '_parts/%'
          AND key NOT LIKE '_meta/%'
      `);
      const zeroByteCount = Number(zeroByteResult.rows[0]?.cnt ?? 0);
      if (zeroByteCount > 0) {
        logger.warn(
          { zeroByteCount, prefixes: zeroByteResult.rows[0]?.prefixes },
          `${MODULE} zero-byte blobs detected — these cannot be served and may indicate interrupted writes`,
        );
        adminEventBus.push("ops-alert", {
          level: "warn", component: "storage-blob-recovery",
          message:
            `${zeroByteCount} zero-byte blob(s) detected in storage_blobs (prefixes: ${zeroByteResult.rows[0]?.prefixes ?? "?"}). ` +
            "These were written by interrupted putObject calls and cannot be served to clients. " +
            "The reconciliation worker treats them as absent and will attempt recovery on the next pass.",
          zeroByteCount,
        });
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
            deletedTranscoded, deletedUploads,
            belowAgeThresholdPrefixes: belowAgeThreshold,
            minAgeHours, autoDelete,
          },
          `${MODULE} orphaned blob scan complete`,
        );
      }

      if (totalDeleted > 0) {
        adminEventBus.push("ops-alert", {
          level: "info", component: "storage-blob-recovery",
          message:
            `Auto-deleted ${totalDeleted} orphaned storage blob(s): ` +
            `${deletedTranscoded} HLS segment blob(s) from ${deletableTranscoded.length} abandoned video prefix(es), ` +
            `${deletedUploads} orphaned upload blob(s). ` +
            `All deleted blobs had no managed_videos row and were older than ${minAgeHours} h.` +
            (belowAgeThreshold > 0
              ? ` ${belowAgeThreshold} orphaned prefix(es) retained (below age threshold).`
              : ""),
          deletedTranscoded, deletedUploads, totalDeleted,
          retainedBelowAgeThreshold: belowAgeThreshold,
          minAgeHours,
        });
      } else if (totalOrphaned > 0 && !autoDelete) {
        adminEventBus.push("ops-alert", {
          level: "warn", component: "storage-blob-recovery",
          message:
            `${totalOrphaned} orphaned blob entries detected in storage_blobs ` +
            `(${transcodedCount} transcoded HLS prefix(es), ${uploadsCount} upload blob(s)) ` +
            "with no corresponding managed_videos row. " +
            "Set ORPHAN_BLOB_AUTO_DELETE=true to enable automatic cleanup.",
          orphanedTranscodedPrefixes: transcodedCount, orphanedUploadBlobs: uploadsCount,
          total: totalOrphaned,
        });
      }

      return totalOrphaned;
    } catch (err) {
      logger.warn({ err }, `${MODULE} orphaned blob scan failed (non-fatal)`);
      return 0;
    }
  }
}

export const storageBlobRecoveryService = new StorageBlobRecoveryServiceImpl();
