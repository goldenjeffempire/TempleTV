/**
 * HLS Startup Integrity Scan
 *
 * On server boot, checks every active broadcast_queue item that claims to have
 * an HLS master playlist (hls_master_url IS NOT NULL) by verifying the
 * corresponding master.m3u8 blob actually exists in storage_blobs.
 *
 * Why this matters:
 *   The media integrity scanner runs on a 2-minute interval after a 90-second
 *   initial delay, so broken HLS items can silently reach air on the first
 *   broadcast cycle after a restart.  A startup scan catches:
 *     • HLS that was never fully uploaded (partial-success transcode where only
 *       the managed_videos row was updated but storage_blobs is incomplete).
 *     • Storage migration / blob TTL expiry that deleted HLS content while the
 *       DB row still points at it.
 *     • Operator error: manual DB edits that set hls_master_url without uploading
 *       the corresponding blobs.
 *
 * Behaviour:
 *   1. Queries all active broadcast_queue rows with a non-null hls_master_url.
 *   2. For own-origin HLS URLs (served from this API), derives the storage key
 *      (`transcoded/{videoId}/master.m3u8`) and batch-checks storage_blobs in
 *      a single query.
 *   3. Items with missing master blobs are logged as WARN and trigger an
 *      ops-alert so operators see the problem on the admin dashboard immediately.
 *   4. Items with ZERO HLS content in storage (no master AND no segments) are
 *      proactively deactivated (is_active=false) so the orchestrator never
 *      attempts to air them — preventing dead-air caused by a broken source.
 *
 * Non-fatal: any DB error is logged and swallowed — a broken startup scan
 * must never prevent the server from starting.
 */
import { sql } from "drizzle-orm";
import { db } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";

const MODULE = "[hls-startup-integrity]";

/**
 * Determine if a URL is served by this API instance (own-origin).
 * We can only check storage_blobs for own-origin HLS — external URLs
 * (YouTube, CDN, remote RTMP) have no storage_blobs entry.
 */
function isOwnOriginHls(url: string): boolean {
  if (!url) return false;
  // Relative path (no scheme) — always own-origin.
  if (url.startsWith("/")) return true;

  const ownOrigins = [
    env.API_ORIGIN,
    process.env["RENDER_EXTERNAL_URL"],
    process.env["REPLIT_DEV_DOMAIN"],
    // Always treat localhost variants as own-origin.
    "http://127.0.0.1",
    "http://localhost",
  ].filter(Boolean) as string[];

  try {
    const u = new URL(url);
    return ownOrigins.some((origin) => {
      try {
        const o = new URL(/^https?:\/\//i.test(origin) ? origin : `https://${origin}`);
        return u.hostname === o.hostname;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Extract the videoId from an own-origin HLS master URL.
 * URL pattern: /api/hls/{videoId}/master.m3u8
 */
function extractVideoIdFromHlsUrl(url: string): string | null {
  // Match both /api/hls/{id}/master.m3u8 and /api/v1/hls/{id}/master.m3u8
  const match = url.match(/\/api(?:\/v1)?\/hls\/([^/?#]+)\/master\.m3u8/);
  return match?.[1] ?? null;
}

type QueueRow = {
  queueId: string;
  videoId: string | null;
  title: string;
  hlsMasterUrl: string;
};

type BlobCountRow = {
  videoId: string;
  blobCount: number;
};

export async function runHlsStartupIntegrityScan(): Promise<void> {
  const startMs = Date.now();
  logger.info(`${MODULE} starting HLS startup integrity scan`);

  let rows: QueueRow[];
  try {
    const result = await db.execute<QueueRow>(sql`
      SELECT
        bq.id        AS "queueId",
        bq.video_id  AS "videoId",
        bq.title,
        bq.hls_master_url AS "hlsMasterUrl"
      FROM broadcast_queue bq
      WHERE bq.is_active = true
        AND bq.hls_master_url IS NOT NULL
        AND bq.hls_master_url <> ''
      ORDER BY bq.sort_order ASC, bq.added_at ASC
    `);
    rows = (result.rows as QueueRow[]) ?? [];
  } catch (err) {
    logger.warn({ err }, `${MODULE} DB query failed — skipping startup scan (non-fatal)`);
    return;
  }

  if (rows.length === 0) {
    logger.info(`${MODULE} no active HLS queue items to check — scan complete`);
    return;
  }

  // Split into own-origin (checkable via storage_blobs) vs external (skip).
  const ownOriginRows = rows.filter((r) => isOwnOriginHls(r.hlsMasterUrl));
  const externalCount = rows.length - ownOriginRows.length;

  if (ownOriginRows.length === 0) {
    logger.info(
      { total: rows.length, external: externalCount },
      `${MODULE} all active HLS items are external URLs — no storage_blobs check needed`,
    );
    return;
  }

  // Build videoId→queueId map for own-origin items.
  // The video ID is either on the queue row itself, or extractable from the URL.
  const videoIdToRow = new Map<string, QueueRow>();
  for (const row of ownOriginRows) {
    const vid = row.videoId ?? extractVideoIdFromHlsUrl(row.hlsMasterUrl);
    if (vid) {
      videoIdToRow.set(vid, row);
    }
  }

  if (videoIdToRow.size === 0) {
    logger.warn(
      { ownOriginCount: ownOriginRows.length },
      `${MODULE} could not extract videoId from any own-origin HLS URL — skipping storage check`,
    );
    return;
  }

  // Batch-query storage_blobs: count blobs per videoId under 'transcoded/{videoId}/'.
  // A master blob exists as 'transcoded/{videoId}/master.m3u8'.
  // Any blob under the prefix indicates at least partial HLS output.
  const videoIds = [...videoIdToRow.keys()];

  let blobCounts: BlobCountRow[];
  try {
    // Count blobs per video prefix in one round-trip.
    // LIKE ANY(array::text[]) is safe: videoIds are DB-sourced UUIDs and are
    // parameterized via the Drizzle sql template — no string interpolation.
    const likePatterns = videoIds.map((id) => `transcoded/${id}/%`);
    const result = await db.execute<BlobCountRow>(sql`
      SELECT
        regexp_replace(key, '^transcoded/([^/]+)/.*$', '\\1') AS "videoId",
        COUNT(*) AS "blobCount"
      FROM storage_blobs
      WHERE key LIKE ANY(${likePatterns}::text[])
      GROUP BY 1
    `);
    blobCounts = (result.rows as BlobCountRow[]) ?? [];
  } catch (err) {
    logger.warn({ err }, `${MODULE} storage_blobs check failed — skipping (non-fatal)`);
    return;
  }

  // Build a map of videoId → blob count.
  const blobCountByVideoId = new Map<string, number>();
  for (const row of blobCounts) {
    blobCountByVideoId.set(row.videoId, Number(row.blobCount));
  }

  // Separately check for the master.m3u8 blob.
  const masterKeys = videoIds.map((id) => `transcoded/${id}/master.m3u8`);
  let masterExists: Set<string>;
  try {
    const result = await db.execute<{ key: string }>(sql`
      SELECT key FROM storage_blobs WHERE key = ANY(${masterKeys}::text[])
    `);
    masterExists = new Set((result.rows as { key: string }[]).map((r) => r.key));
  } catch (err) {
    logger.warn({ err }, `${MODULE} master.m3u8 existence check failed — skipping (non-fatal)`);
    return;
  }

  // Classify items.
  const missingMaster: Array<{ videoId: string; queueId: string; title: string; hlsMasterUrl: string }> = [];
  const totallyMissing: string[] = []; // videoIds with ZERO blobs

  for (const videoId of videoIds) {
    const row = videoIdToRow.get(videoId)!;
    const masterKey = `transcoded/${videoId}/master.m3u8`;
    const hasMaster = masterExists.has(masterKey);
    const blobCount = blobCountByVideoId.get(videoId) ?? 0;

    if (!hasMaster) {
      missingMaster.push({
        videoId,
        queueId: row.queueId,
        title: row.title,
        hlsMasterUrl: row.hlsMasterUrl,
      });
      if (blobCount === 0) {
        totallyMissing.push(videoId);
      }
    }
  }

  const elapsedMs = Date.now() - startMs;
  const checkedCount = videoIdToRow.size;

  if (missingMaster.length === 0) {
    logger.info(
      { checked: checkedCount, external: externalCount, elapsedMs },
      `${MODULE} all active HLS items verified — no missing master playlists`,
    );
    return;
  }

  // Log every broken item.
  for (const item of missingMaster) {
    const blobCount = blobCountByVideoId.get(item.videoId) ?? 0;
    logger.warn(
      {
        videoId: item.videoId,
        queueId: item.queueId,
        title: item.title,
        hlsMasterUrl: item.hlsMasterUrl,
        blobCount,
        isCompletelyMissing: blobCount === 0,
      },
      `${MODULE} active broadcast queue item claims HLS but master.m3u8 is MISSING from storage`,
    );
  }

  // Emit ops-alert so the admin dashboard surfaces the problem immediately.
  adminEventBus.push("ops-alert", {
    level: "error",
    component: "hls-startup-integrity",
    message:
      `${missingMaster.length} active broadcast queue item(s) have a missing HLS master playlist in storage. ` +
      `${totallyMissing.length > 0 ? `${totallyMissing.length} item(s) have ZERO HLS blobs (will be deactivated). ` : ""}` +
      `Affected: ${missingMaster.map((i) => `"${i.title}"`).join(", ")}. ` +
      `These items will cause dead air when they air. Re-transcode or remove them from the queue.`,
    missingCount: missingMaster.length,
    totallyMissingCount: totallyMissing.length,
    affectedItems: missingMaster.map((i) => ({
      videoId: i.videoId,
      queueId: i.queueId,
      title: i.title,
    })),
  });

  // Deactivate items with ZERO HLS blobs — these can never play and will
  // cause repeated auto-skip cycles and dead air if left active.
  // Items with some blobs (partial transcode) are left active so the
  // media integrity scanner can probe them and they can self-heal via
  // the orchestrator's bad-URL circuit breaker.
  if (totallyMissing.length > 0) {
    try {
      await db.execute(sql`
        UPDATE broadcast_queue
        SET is_active = false,
            updated_at = now()
        WHERE video_id = ANY(${totallyMissing}::text[])
          AND is_active = true
          AND hls_master_url IS NOT NULL
      `);
      logger.warn(
        { deactivatedVideoIds: totallyMissing },
        `${MODULE} deactivated ${totallyMissing.length} queue item(s) with zero HLS blobs to prevent dead air`,
      );
      adminEventBus.push("broadcast-queue-updated", {
        reason: "hls-startup-integrity-deactivation",
        deactivatedVideoIds: totallyMissing,
      });
    } catch (err) {
      logger.warn(
        { err, videoIds: totallyMissing },
        `${MODULE} failed to deactivate zero-blob HLS items (non-fatal — media scanner will catch them)`,
      );
    }
  }

  logger.warn(
    {
      checked: checkedCount,
      missingMaster: missingMaster.length,
      totallyMissing: totallyMissing.length,
      deactivated: totallyMissing.length,
      elapsedMs,
    },
    `${MODULE} startup scan complete — ${missingMaster.length} broken HLS item(s) detected`,
  );
}
