import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { broadcastService } from "./broadcast.service.js";
import { ConflictError } from "../../shared/errors.js";

/**
 * Library → Broadcast Queue auto-enqueue pipeline.
 *
 * The broadcast queue must stay populated 24/7 with zero manual operator
 * action. This module is the single source of truth for that contract: any
 * code path that publishes a playable video into `managed_videos` (upload
 * finalize, faststart completion, transcoder completion, YouTube sync, prod
 * mirror, manual import) calls into this service so the row is reflected in
 * `broadcast_queue` exactly once.
 *
 * Design constraints
 *  • Idempotent — safe to call repeatedly for the same video; we de-dup by
 *    `videoId` first (covers local + YT-synced rows, since YT rows get an
 *    `id = "yt-${youtubeId}"`) and by `youtubeId` second (covers any legacy
 *    rows that were inserted with no videoId).
 *  • Crash-safe — every DB call is individually wrapped. A single failed
 *    auto-add never throws back to the upload route or YT sync run.
 *  • Cheap — the scan path uses a NOT EXISTS subquery (single round-trip)
 *    rather than fetching the whole library + queue and diffing in Node.
 *  • Opt-out — `BROADCAST_AUTO_ENQUEUE_DISABLE=1` turns the entire pipeline
 *    off without removing the call sites. Provides an emergency kill-switch.
 *
 * What counts as "playable" for auto-enqueue:
 *  • YouTube  — excluded from broadcast. YouTube content is library-only and
 *    surfaces only through catalog/search endpoints, never the broadcast queue.
 *  • Local    — has hls_master_url (preferred — adaptive bitrate) OR any
 *    non-empty local_video_url. Videos are queued immediately after blob
 *    assembly so the broadcast doesn't wait for faststart or HLS transcoding.
 *    Faststart runs in the background and re-uploads the optimised file to the
 *    same storage key; HLS transcoding produces a separate manifest URL. The
 *    queue-integrity-validator upgrades the queue item's source to HLS once
 *    hls_master_url is set, so the broadcast always airs the best available
 *    source without operator action.
 */

const queueTable = schema.broadcastQueueTable;
const videosTable = schema.videosTable;

export function isAutoEnqueueEnabled(): boolean {
  return !env.BROADCAST_AUTO_ENQUEUE_DISABLE;
}

/**
 * Enqueue a single managed_video row into the broadcast queue if it isn't
 * already present. Returns true when a new row was inserted, false when the
 * video was already queued or auto-enqueue is disabled.
 *
 * `reason` is logged so on-call can grep for "auto-enqueue" and trace which
 * pipeline (upload / yt-sync / library-scan) produced each row.
 */
export async function enqueueIfMissing(opts: {
  videoId: string;
  reason: "upload-finalize" | "yt-sync" | "library-scan" | "manual-import";
}): Promise<{ enqueued: boolean; queueItemId?: string; skipReason?: string }> {
  if (!isAutoEnqueueEnabled()) {
    return { enqueued: false, skipReason: "auto-enqueue-disabled" };
  }
  try {
    // Fetch the video row + check for existing queue rows in one round-trip
    // via a LEFT JOIN. We need both pieces of information regardless, and
    // running them sequentially burns an extra latency hop on every call
    // from the YouTube sync (which can call this hundreds of times).
    const [row] = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        thumbnailUrl: videosTable.thumbnailUrl,
        duration: videosTable.duration,
        videoSource: videosTable.videoSource,
        youtubeId: videosTable.youtubeId,
        localVideoUrl: videosTable.localVideoUrl,
        hlsMasterUrl: videosTable.hlsMasterUrl,
        transcodingStatus: videosTable.transcodingStatus,
        faststartApplied: videosTable.faststartApplied,
        transcodingErrorCode: videosTable.transcodingErrorCode,
      })
      .from(videosTable)
      .where(eq(videosTable.id, opts.videoId))
      .limit(1);

    if (!row) return { enqueued: false, skipReason: "video-not-found" };
    if (!isPlayableForBroadcast(row)) {
      return { enqueued: false, skipReason: "not-yet-playable" };
    }

    // De-dup against both videoId (canonical) and youtubeId (legacy rows).
    // IMPORTANT: filter to is_active = true only. An inactive queue row means
    // the item was previously dequeued (operator-deactivated, integrity-fix, etc.)
    // and is no longer in broadcast rotation. Treating it as "already queued"
    // would permanently block the video from re-entering the broadcast — the
    // orchestrator only loads is_active = true rows, so inactive rows are
    // effectively invisible to it. The correct behaviour is to insert a fresh
    // active row so the video re-enters rotation.
    const existing = await db
      .select({ id: queueTable.id })
      .from(queueTable)
      .where(
        and(
          eq(queueTable.isActive, true),
          or(
            eq(queueTable.videoId, row.id),
            row.youtubeId ? eq(queueTable.youtubeId, row.youtubeId) : sql`false`,
          ),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return { enqueued: false, skipReason: "already-queued" };
    }

    const durationSecs = Math.max(1, Math.round(parseFloat(row.duration ?? "0")) || 1800);
    const inserted = await broadcastService.addToQueue({
      videoId: row.id,
      youtubeId: row.youtubeId ?? "",
      title: row.title,
      thumbnailUrl: row.thumbnailUrl ?? "",
      durationSecs,
      localVideoUrl: row.localVideoUrl ?? null,
      videoSource: row.videoSource as "youtube" | "local" | "hls",
    });
    logger.info(
      { videoId: row.id, queueItemId: inserted.id, reason: opts.reason },
      "[broadcast] auto-enqueue: video added to broadcast queue",
    );
    return { enqueued: true, queueItemId: inserted.id };
  } catch (err) {
    // Special-case the DB-level unique violation on
    // `uq_broadcast_queue_video_id_active`. That index exists precisely so
    // two concurrent enqueue paths (event-triggered enqueueIfMissing +
    // orchestrator self-heal library scan, or two API replicas) can race
    // safely: the first writer wins, the second sees Postgres 23505. From
    // the caller's perspective this is *not* an error — the video is
    // queued, just not by this call — so emit a debug-level breadcrumb
    // instead of a WARN to avoid alarming operators when the safety net
    // is doing its job.

    // ConflictError from addToQueue's in-transaction pre-check (Layer 1 guard).
    // Semantically identical to the 23505 case: the video is already queued.
    if (err instanceof ConflictError) {
      logger.debug(
        { videoId: opts.videoId, reason: opts.reason },
        "[broadcast] auto-enqueue: duplicate guard fired in addToQueue (already queued)",
      );
      return { enqueued: false, skipReason: "already-queued" };
    }
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      logger.debug(
        { videoId: opts.videoId, reason: opts.reason },
        "[broadcast] auto-enqueue: lost unique-violation race (already queued by concurrent path)",
      );
      return { enqueued: false, skipReason: "already-queued" };
    }
    // Never throw — the caller (upload finalize, YT sync) must continue
    // succeeding even if auto-add hits a transient DB blip. Worst case the
    // library-scan safety net picks the video up within 30 s.
    logger.warn(
      { err, videoId: opts.videoId, reason: opts.reason },
      "[broadcast] auto-enqueue: enqueueIfMissing failed (non-fatal)",
    );
    return { enqueued: false, skipReason: "error" };
  }
}

/**
 * Scan the entire library for playable videos that are NOT in the broadcast
 * queue, and enqueue every one of them. Two call sites:
 *
 *  1. After a YouTube sync run — picks up freshly-imported YT rows in bulk
 *     without us having to thread "inserted vs updated" diffs through the
 *     ingestion pipeline.
 *
 *  2. Orchestrator empty-queue self-heal — if the queue has been empty for
 *     more than one poll interval AND the library has playable content, we
 *     pull that content into the queue automatically so the broadcast can
 *     come back on-air without operator action.
 *
 * Enforces a hard `maxToAdd` cap so a fresh database with 5 000 imported
 * videos doesn't insert 5 000 queue rows in a single transaction. Items are
 * ordered by `imported_at DESC` so newest content airs first, matching the
 * UX users expect from "add to queue" on the library page.
 */
export async function scanLibraryAndEnqueue(opts: {
  reason: "yt-sync" | "self-heal-empty" | "self-heal-all-blocked" | "manual";
  maxToAdd?: number;
}): Promise<{ scanned: number; enqueued: number; skipped: number }> {
  if (!isAutoEnqueueEnabled()) {
    return { scanned: 0, enqueued: 0, skipped: 0 };
  }
  const limit = opts.maxToAdd ?? 200;
  try {
    // Single query: managed_videos LEFT ANTI JOIN broadcast_queue. Returns
    // only library rows that aren't represented in the queue by either
    // videoId or youtubeId. Ordered newest-first so the broadcast leads
    // with the freshest content the moment the queue is hydrated.
    //
    const candidates = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        thumbnailUrl: videosTable.thumbnailUrl,
        duration: videosTable.duration,
        videoSource: videosTable.videoSource,
        youtubeId: videosTable.youtubeId,
        localVideoUrl: videosTable.localVideoUrl,
        hlsMasterUrl: videosTable.hlsMasterUrl,
        transcodingStatus: videosTable.transcodingStatus,
        faststartApplied: videosTable.faststartApplied,
        transcodingErrorCode: videosTable.transcodingErrorCode,
      })
      .from(videosTable)
      .where(
        and(
          // YouTube is library-only — never enters the broadcast queue.
          ne(videosTable.videoSource, "youtube"),
          // Must have at least one local-playback source. The per-row
          // isPlayableForBroadcast() check below confirms the video is ready.
          or(
            isNotNull(videosTable.hlsMasterUrl),
            isNotNull(videosTable.localVideoUrl),
          ),
          // Pre-filter: exclude unrecoverable uploads at the SQL level to avoid
          // wasting a roundtrip per row inside isPlayableForBroadcast.
          // CORRUPT_SOURCE = moov atom absent; SOURCE_MISSING = source blob gone
          // from storage. Both require a fresh re-upload.
          sql`(${videosTable.transcodingErrorCode} IS NULL OR ${videosTable.transcodingErrorCode} NOT IN ('CORRUPT_SOURCE', 'SOURCE_MISSING'))`,
          // Pre-filter: exclude raw MP4s that are known-unplayable (failed
          // transcoding + faststart never applied + no HLS manifest).
          sql`NOT (
            ${videosTable.transcodingStatus} = 'failed'
            AND (${videosTable.faststartApplied} = false OR ${videosTable.faststartApplied} IS NULL)
            AND ${videosTable.hlsMasterUrl} IS NULL
          )`,
          // NOT EXISTS subquery — keeps the JOIN cheap and the candidate set
          // small; the dedupe inside enqueueIfMissing is the authoritative
          // backstop for the race where two concurrent scans run at once.
          //
          // IMPORTANT: restrict to is_active = true. An inactive queue row
          // means the video was previously dequeued and is no longer in
          // broadcast rotation. Without this filter the scan would treat
          // videos with only inactive rows as "already queued" and never
          // re-add them, silently blocking re-entry into the broadcast.
          sql`NOT EXISTS (
            SELECT 1 FROM ${queueTable}
            WHERE ${queueTable.isActive} = true
              AND (${queueTable.videoId} = ${videosTable.id}
                   OR (${videosTable.youtubeId} IS NOT NULL
                       AND ${queueTable.youtubeId} = ${videosTable.youtubeId}))
          )`,
        ),
      )
      .orderBy(desc(videosTable.importedAt))
      .limit(limit);

    let enqueued = 0;
    let skipped = 0;
    for (const row of candidates) {
      if (!isPlayableForBroadcast(row)) {
        skipped += 1;
        continue;
      }
      const res = await enqueueIfMissing({
        videoId: row.id,
        reason: opts.reason === "yt-sync" ? "yt-sync" : "library-scan",
      });
      if (res.enqueued) enqueued += 1;
      else skipped += 1;
    }
    if (enqueued > 0) {
      logger.info(
        { reason: opts.reason, scanned: candidates.length, enqueued, skipped },
        "[broadcast] auto-enqueue: library scan completed",
      );
    }
    return { scanned: candidates.length, enqueued, skipped };
  } catch (err) {
    logger.warn(
      { err, reason: opts.reason },
      "[broadcast] auto-enqueue: scanLibraryAndEnqueue failed (non-fatal)",
    );
    return { scanned: 0, enqueued: 0, skipped: 0 };
  }
}

/**
 * Bulk variant: enqueue a known set of video ids (e.g. the rows newly
 * inserted by an admin batch import). De-duped per-id inside enqueueIfMissing
 * so this is safe to call with any mix of new + existing ids.
 */
export async function enqueueManyIfMissing(
  videoIds: string[],
  reason: "yt-sync" | "manual-import",
): Promise<number> {
  if (!isAutoEnqueueEnabled() || videoIds.length === 0) return 0;
  let enqueued = 0;
  // Process in chunks to bound the rate of DB writes from a single caller —
  // a 1000-row YT sync would otherwise fire 1000 sequential addToQueue +
  // engine reload pairs. The reload coalesces via single-flight, but the
  // insert volume still benefits from chunking.
  const CHUNK = 50;
  for (let i = 0; i < videoIds.length; i += CHUNK) {
    const chunk = videoIds.slice(i, i + CHUNK);
    for (const id of chunk) {
      const res = await enqueueIfMissing({ videoId: id, reason });
      if (res.enqueued) enqueued += 1;
    }
  }
  return enqueued;
}

function isPlayableForBroadcast(row: {
  videoSource: string;
  youtubeId: string | null;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  transcodingStatus?: string | null;
  faststartApplied?: boolean | null;
  transcodingErrorCode?: string | null;
}): boolean {
  // YouTube is library-only — excluded from broadcast entirely.
  if (row.videoSource === "youtube") return false;

  // HLS is the gold standard (adaptive bitrate, CDN-friendly, moov equivalent
  // is baked into the playlist manifest). Always safe to broadcast.
  if (row.hlsMasterUrl && row.hlsMasterUrl.trim() !== "") return true;

  // Unrecoverable upload: CORRUPT_SOURCE = the source file has no moov atom (or
  // the moov is so broken that FFmpeg cannot remux it) — the raw MP4 cannot be
  // streamed via HTTP range requests. SOURCE_MISSING = the source blob no longer
  // exists in storage. Either way, re-uploading the source file is the only fix.
  if (row.transcodingErrorCode === "CORRUPT_SOURCE" || row.transcodingErrorCode === "SOURCE_MISSING") return false;

  // Raw local MP4 (no HLS yet): safe to broadcast ONLY when the moov atom is
  // positioned at byte 0 (faststartApplied = true). If transcoding permanently
  // failed (status = 'failed') and faststart was never applied (false/null),
  // the moov is at EOF — browsers buffer the entire file before playing.
  // That means the raw URL will stall or error in the player. Exclude it.
  if (row.localVideoUrl && row.localVideoUrl.trim() !== "") {
    if (
      row.transcodingStatus === "failed" &&
      !row.faststartApplied
    ) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * List which managed_videos rows are currently NOT in the broadcast queue.
 * Exposed for diagnostics / admin "scan now" buttons; the orchestrator
 * never calls this directly.
 */
export async function listMissingFromQueue(limit = 50): Promise<
  Array<{ id: string; title: string; videoSource: string; reason: string }>
> {
  try {
    const rows = await db
      .select({
        id: videosTable.id,
        title: videosTable.title,
        videoSource: videosTable.videoSource,
        youtubeId: videosTable.youtubeId,
        localVideoUrl: videosTable.localVideoUrl,
        hlsMasterUrl: videosTable.hlsMasterUrl,
      })
      .from(videosTable)
      .where(
        // IMPORTANT: restrict NOT EXISTS to is_active = true so we surface
        // videos whose only queue entry is inactive (deactivated/orphaned).
        // Without this filter, videos with inactive rows appear "queued" to
        // the diagnostics endpoint while the orchestrator never plays them.
        sql`NOT EXISTS (
          SELECT 1 FROM ${queueTable}
          WHERE ${queueTable.isActive} = true
            AND (${queueTable.videoId} = ${videosTable.id}
                 OR (${videosTable.youtubeId} IS NOT NULL
                     AND ${queueTable.youtubeId} = ${videosTable.youtubeId}))
        )`,
      )
      .orderBy(desc(videosTable.importedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      videoSource: r.videoSource,
      reason: isPlayableForBroadcast(r) ? "ready" : "not-yet-playable",
    }));
  } catch (err) {
    logger.warn({ err }, "[broadcast] auto-enqueue: listMissingFromQueue failed");
    return [];
  }
}

// Re-export for callers that want to inspect helpers without a separate import.
export { inArray };
