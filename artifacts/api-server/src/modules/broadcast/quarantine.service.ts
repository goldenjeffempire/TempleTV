/**
 * Corrupt-upload quarantine service.
 *
 * When a video is confirmed unplayable (CORRUPT_SOURCE, SOURCE_MISSING, or any
 * other terminal upload failure), this service atomically:
 *
 *   1. Deactivates every active broadcast_queue row referencing the video.
 *   2. Removes every playlist_videos row referencing the video.
 *   3. Writes a structured entry to media_audit_log for auditability.
 *   4. Fires adminEventBus events so the orchestrator reloads and the admin
 *      panel refreshes immediately.
 *   5. Emits a corrupt-media-detected ops-alert so dashboard widgets update live.
 *
 * Designed to be idempotent — calling it twice for the same videoId is safe.
 * All DB operations run inside a single transaction so a partial failure
 * rolls back fully.
 */
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { sendBroadcastWebhook } from "../broadcast-v2/webhook/webhook.service.js";

export interface QuarantineOptions {
  /** Machine-readable reason code (e.g. CORRUPT_SOURCE, SOURCE_MISSING, MOOV_ABSENT). */
  errorCode: string;
  /** Human-readable description of why the video is being quarantined. */
  reason: string;
  /** What triggered this quarantine (finalize-route, integrity-validator, manual). */
  triggeredBy?: string;
  /** Extra key/value metadata stored in the audit log JSON column. */
  metadata?: Record<string, unknown>;
}

export interface QuarantineResult {
  queueItemsDeactivated: number;
  playlistEntriesRemoved: number;
  auditLogId: string | null;
}

/**
 * Quarantine a corrupt/unplayable video.
 *
 * Safe to call from background tasks — never throws; all errors are logged
 * and swallowed so a quarantine failure does not crash the calling process.
 */
export async function quarantineVideo(
  videoId: string,
  opts: QuarantineOptions,
): Promise<QuarantineResult> {
  const { errorCode, reason, triggeredBy = "system", metadata } = opts;
  const result: QuarantineResult = {
    queueItemsDeactivated: 0,
    playlistEntriesRemoved: 0,
    auditLogId: null,
  };

  try {
    const auditId = randomUUID();

    await db.transaction(async (tx) => {
      const queueUpdate = await tx
        .update(schema.broadcastQueueTable)
        .set({
          isActive: false,
          validatorDeactivatedReason: "corrupt_upload",
        })
        .where(
          sql`${schema.broadcastQueueTable.videoId} = ${videoId} AND ${schema.broadcastQueueTable.isActive} = true`,
        )
        .returning({ id: schema.broadcastQueueTable.id });

      result.queueItemsDeactivated = queueUpdate.length;

      const playlistDelete = await tx
        .delete(schema.playlistVideosTable)
        .where(eq(schema.playlistVideosTable.videoId, videoId))
        .returning({ id: schema.playlistVideosTable.videoId });

      result.playlistEntriesRemoved = playlistDelete.length;

      await tx.insert(schema.mediaAuditLogTable).values({
        id: auditId,
        videoId,
        action: "QUARANTINE",
        reason,
        errorCode,
        triggeredBy,
        metadata: metadata ?? null,
        createdAt: new Date(),
      });

      result.auditLogId = auditId;
    });

    logger.error(
      {
        videoId,
        errorCode,
        reason,
        triggeredBy,
        queueItemsDeactivated: result.queueItemsDeactivated,
        playlistEntriesRemoved: result.playlistEntriesRemoved,
      },
      "[quarantine] video quarantined — removed from broadcast queue and playlists",
    );

    adminEventBus.push("broadcast-queue-updated", {
      reason: "quarantine-corrupt-upload",
      videoId,
      errorCode,
    });
    adminEventBus.push("videos-library-updated", {
      reason: "quarantine-corrupt-upload",
      videoId,
      errorCode,
    });
    adminEventBus.push("corrupt-media-detected", {
      videoId,
      errorCode,
      reason,
      triggeredBy,
      queueItemsRemoved: result.queueItemsDeactivated,
      playlistsAffected: result.playlistEntriesRemoved,
    });

    sendBroadcastWebhook("item_deactivated", "main", {
      reason: "corrupt_upload",
      videoId,
      errorCode,
      count: result.queueItemsDeactivated,
    });

    void import("../../infrastructure/sentry.js")
      .then(({ captureEvent }) =>
        captureEvent(
          `Video quarantined: ${errorCode} — ${reason} (videoId: ${videoId})`,
          "warning",
          { videoId, errorCode, reason, triggeredBy, ...result },
        ),
      )
      .catch(() => {});
  } catch (err) {
    logger.error(
      { err, videoId, errorCode, reason },
      "[quarantine] quarantine transaction failed (non-fatal) — will be cleaned up by integrity validator",
    );
  }

  return result;
}

/**
 * Write a PURGE entry to media_audit_log when an admin hard-deletes a video.
 */
export async function logPurge(
  videoId: string,
  opts: {
    reason: string;
    triggeredBy: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(schema.mediaAuditLogTable).values({
      id: randomUUID(),
      videoId,
      action: "PURGE",
      reason: opts.reason,
      errorCode: null,
      triggeredBy: opts.triggeredBy,
      metadata: opts.metadata ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err, videoId }, "[quarantine] logPurge write failed (non-fatal)");
  }
}

/**
 * Query corrupt-media inventory for the admin API.
 */
export async function getCorruptMediaInventory(opts: {
  page?: number;
  limit?: number;
  errorCode?: string;
}): Promise<{
  items: Array<{
    videoId: string | null;
    title: string | null;
    originalFilename: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    transcodingStatus: string | null;
    detectedAt: string | null;
    auditId: string;
    reason: string | null;
    triggeredBy: string;
    queueItemsRemoved: number;
    playlistEntriesRemoved: number;
  }>;
  total: number;
  page: number;
  limit: number;
}> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = (page - 1) * limit;

  try {
    const errorCodeFilter = opts.errorCode
      ? sql`AND mal.error_code = ${opts.errorCode}`
      : sql``;

    const rows = await db.execute<{
      audit_id: string;
      video_id: string | null;
      title: string | null;
      original_filename: string | null;
      error_code: string | null;
      error_message: string | null;
      transcoding_status: string | null;
      detected_at: Date | null;
      reason: string | null;
      triggered_by: string;
      metadata: Record<string, unknown> | null;
    }>(sql`
      SELECT
        mal.id            AS audit_id,
        mal.video_id,
        mv.title,
        mv.original_filename,
        mal.error_code,
        mv.transcoding_error_message AS error_message,
        mv.transcoding_status,
        mal.created_at    AS detected_at,
        mal.reason,
        mal.triggered_by,
        mal.metadata
      FROM media_audit_log mal
      LEFT JOIN managed_videos mv ON mv.id = mal.video_id
      WHERE mal.action = 'QUARANTINE'
      ${errorCodeFilter}
      ORDER BY mal.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const countResult = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM media_audit_log
      WHERE action = 'QUARANTINE'
      ${errorCodeFilter}
    `);
    const countRow = countResult.rows[0];

    return {
      items: rows.rows.map((r) => ({
        videoId: r.video_id,
        title: r.title,
        originalFilename: r.original_filename,
        errorCode: r.error_code,
        errorMessage: r.error_message,
        transcodingStatus: r.transcoding_status,
        detectedAt: r.detected_at ? new Date(r.detected_at).toISOString() : null,
        auditId: r.audit_id,
        reason: r.reason,
        triggeredBy: r.triggered_by,
        queueItemsRemoved: Number((r.metadata as Record<string, number> | null)?.queueItemsRemoved ?? 0),
        playlistEntriesRemoved: Number((r.metadata as Record<string, number> | null)?.playlistEntriesRemoved ?? 0),
      })),
      total: Number(countRow?.n ?? 0),
      page,
      limit,
    };
  } catch (err) {
    logger.warn({ err }, "[quarantine] getCorruptMediaInventory failed");
    return { items: [], total: 0, page, limit };
  }
}

/**
 * Get a corruptMedia health summary for the /health endpoint.
 */
export async function getCorruptMediaHealthSummary(): Promise<{
  last24h: number;
  quarantinedTotal: number;
  lastDetectedAt: string | null;
}> {
  try {
    const healthResult = await db.execute<{
      last24h: number;
      total: number;
      last_detected_at: Date | null;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') ::int AS last24h,
        COUNT(*)::int AS total,
        MAX(created_at) AS last_detected_at
      FROM media_audit_log
      WHERE action = 'QUARANTINE'
    `);
    const row = healthResult.rows[0];

    return {
      last24h: Number(row?.last24h ?? 0),
      quarantinedTotal: Number(row?.total ?? 0),
      lastDetectedAt: row?.last_detected_at ? new Date(row.last_detected_at).toISOString() : null,
    };
  } catch {
    return { last24h: 0, quarantinedTotal: 0, lastDetectedAt: null };
  }
}
