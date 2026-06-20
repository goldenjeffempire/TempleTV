/**
 * Auto Queue Refill
 *
 * When the broadcast queue's estimated remaining duration falls below
 * QUEUE_REFILL_TRIGGER_MS (default 30 min), this worker automatically
 * adds up to QUEUE_REFILL_BATCH (default 5) library videos that have a
 * playable source (localVideoUrl OR hlsMasterUrl) but are not currently
 * active in the broadcast queue.
 *
 * Selection criteria (MP4-first policy — HLS-gate removed):
 *   1. Videos with localVideoUrl OR hlsMasterUrl (raw MP4 is admitted immediately)
 *   2. Excludes YouTube-sourced videos (served via ytShuffleFallback override)
 *   3. Ordered by imported_at DESC — newest content first
 *
 * Enrollment is delegated to enqueueIfMissing() which correctly handles
 * id generation, localVideoUrl/hlsMasterUrl population, duplicate detection,
 * and the broadcast-queue-updated event.
 *
 * YouTube-only library handling: when all library videos are YouTube-sourced,
 * the refill query returns no candidates (YouTube videos are served via the
 * ytShuffleFallback override mechanism and must NOT be inserted directly into
 * broadcast_queue).  In this case the worker logs an INFO-level explanation
 * and does NOT emit a warn/critical ops-alert — the channel is ON AIR via the
 * YouTube shuffle fallback.
 *
 * Disabled via QUEUE_REFILL_DISABLE=1 env var.
 */
import { db } from "../../../infrastructure/db.js";
import { sql } from "drizzle-orm";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { queueAutoRefillTotal } from "../../../infrastructure/metrics.js";
import { enqueueIfMissing } from "../../broadcast/auto-enqueue.service.js";

const TRIGGER_MS = Number(process.env["QUEUE_REFILL_TRIGGER_MS"] ?? 30 * 60 * 1000);
const BATCH = Math.max(1, Math.min(20, Number(process.env["QUEUE_REFILL_BATCH"] ?? 5)));
const INTERVAL_MS = 90_000;
const COOLDOWN_MS = 5 * 60 * 1000;

export interface AutoRefillStatus {
  enabled: boolean;
  lastRunAtMs: number | null;
  lastRefillAtMs: number | null;
  lastRefillCount: number;
  totalRefilled: number;
  /** Populated when all library videos are YouTube-sourced (no local candidates). */
  libraryIsYouTubeOnly: boolean;
  libraryYouTubeCount: number;
  libraryLocalCount: number;
}

let _status: AutoRefillStatus = {
  enabled: !process.env["QUEUE_REFILL_DISABLE"],
  lastRunAtMs: null,
  lastRefillAtMs: null,
  lastRefillCount: 0,
  totalRefilled: 0,
  libraryIsYouTubeOnly: false,
  libraryYouTubeCount: 0,
  libraryLocalCount: 0,
};
let _timer: NodeJS.Timeout | null = null;
let _lastRefillAtMs = 0;

export function getAutoRefillStatus(): AutoRefillStatus {
  return { ..._status };
}

/**
 * Lazily queries the orchestrator for the current override state.
 * Used to suppress false-positive ops-alerts when broadcast is ON AIR via override.
 */
async function getActiveOverride(): Promise<{ kind: string; title: string; isYtShuffle: boolean } | null> {
  try {
    const { broadcastOrchestrator } = await import("../index.js");
    return broadcastOrchestrator.getOverrideState();
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  if (process.env["QUEUE_REFILL_DISABLE"]) return;

  const now = Date.now();
  _status.lastRunAtMs = now;

  try {
    // Compute total remaining duration of active queue items.
    const durationRows = await db.execute<{ total_secs: string }>(sql`
      SELECT COALESCE(SUM(duration_secs), 0)::text AS total_secs
      FROM broadcast_queue
      WHERE is_active = true
    `);
    const durationRow = durationRows.rows?.[0] ?? durationRows[0];
    const totalSecs = parseFloat(String(durationRow?.total_secs ?? "0"));
    const timeToEmptyMs = totalSecs * 1000;

    if (timeToEmptyMs >= TRIGGER_MS) return;
    if (now - _lastRefillAtMs < COOLDOWN_MS) return;

    logger.info(
      { timeToEmptyMs, triggerMs: TRIGGER_MS, batch: BATCH },
      "[auto-refill] queue running low — attempting auto-refill",
    );

    // Find library videos with a playable source (MP4 or HLS) that are NOT currently
    // active in the broadcast queue.  MP4-first policy: raw MP4 uploads (localVideoUrl)
    // are admitted immediately — HLS is an async upgrade, not a gate.
    // Excludes YouTube-sourced videos — those are served through the ytShuffleFallback
    // override mechanism (activated when the local queue is empty) and should never be
    // inserted into the broadcast_queue directly.
    const candidates = await db.execute<{ id: string; title: string }>(sql`
      SELECT mv.id, mv.title
      FROM managed_videos mv
      WHERE
        (mv.hls_master_url IS NOT NULL OR mv.local_video_url IS NOT NULL)
        AND mv.video_source != 'youtube'
        AND NOT EXISTS (
          SELECT 1 FROM broadcast_queue bq
          WHERE bq.video_id = mv.id AND bq.is_active = true
        )
      ORDER BY mv.imported_at DESC
      LIMIT ${BATCH}
    `);

    const rows: { id: string; title: string }[] = Array.isArray(candidates.rows)
      ? candidates.rows
      : (candidates as unknown as { id: string; title: string }[]);

    if (!rows.length) {
      // Before logging an alert, determine WHY there are no candidates.
      // If every video in the library is YouTube-sourced, this is expected behaviour
      // — the ytShuffleFallback handles broadcast continuity automatically.
      const libraryRows = await db.execute<{ youtube_cnt: string; local_cnt: string }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE video_source = 'youtube')::text  AS youtube_cnt,
          COUNT(*) FILTER (WHERE video_source != 'youtube')::text AS local_cnt
        FROM managed_videos
      `);
      const libRow = libraryRows.rows?.[0] ?? libraryRows[0] as { youtube_cnt: string; local_cnt: string } | undefined;
      const youtubeCount = parseInt(String(libRow?.youtube_cnt ?? "0"), 10);
      const localCount   = parseInt(String(libRow?.local_cnt  ?? "0"), 10);

      _status.libraryYouTubeCount = youtubeCount;
      _status.libraryLocalCount   = localCount;
      _status.libraryIsYouTubeOnly = localCount === 0 && youtubeCount > 0;

      if (_status.libraryIsYouTubeOnly) {
        // All videos are YouTube-sourced.  The ytShuffleFallback override
        // (activated by the orchestrator's self-heal loop) will handle broadcast
        // continuity.  No ops-alert — this is normal operation for a YouTube-only
        // deployment.
        const override = await getActiveOverride();
        logger.info(
          {
            youtubeCount,
            localCount,
            overrideActive: override !== null,
            overrideKind: override?.kind ?? null,
            overrideTitle: override?.title ?? null,
            overrideIsYtShuffle: override?.isYtShuffle ?? false,
          },
          "[auto-refill] library contains only YouTube videos — ytShuffleFallback handles broadcast continuity; no local videos to add to queue",
        );
      } else {
        // There are some local videos but none are eligible (all may be in the
        // queue already or have missing source URLs).
        logger.warn(
          { youtubeCount, localCount },
          "[auto-refill] no eligible local library videos to add — queue may go empty",
        );
        const override = await getActiveOverride();
        if (!override) {
          adminEventBus.push("ops-alert", {
            level: "warn",
            code: "auto-refill-no-candidates",
            message: `Auto-refill found no eligible library videos (${localCount} local, ${youtubeCount} YouTube). Queue may go empty.`,
            context: { youtubeCount, localCount },
          });
        }
      }
      return;
    }

    // Reset YouTube-only flag since we found candidates.
    _status.libraryIsYouTubeOnly = false;

    // Delegate enrollment to enqueueIfMissing() — it handles id generation,
    // localVideoUrl/hlsMasterUrl population, duplicate detection (23505 guard),
    // and the broadcast-queue-updated event.  The raw-SQL INSERT previously used
    // here was missing the `id` PK field, silently failing for new videos.
    let added = 0;
    for (const row of rows) {
      try {
        const result = await enqueueIfMissing({ videoId: row.id, reason: "library-scan" });
        if (result.enqueued) added++;
      } catch (err) {
        logger.warn({ err, videoId: row.id }, "[auto-refill] failed to enqueue video (non-fatal)");
      }
    }

    if (added > 0) {
      _lastRefillAtMs = now;
      _status.lastRefillAtMs = now;
      _status.lastRefillCount = added;
      _status.totalRefilled += added;

      queueAutoRefillTotal.inc(
        { service: "temple-tv-api", env: process.env["NODE_ENV"] ?? "development" },
        added,
      );

      adminEventBus.push("ops-alert", {
        level: "info",
        message: `Auto-refill added ${added} video(s) to the broadcast queue (${Math.floor(timeToEmptyMs / 60000)} min remaining before trigger).`,
        context: { added, timeToEmptyMs },
      });
      // enqueueIfMissing already fires broadcast-queue-updated per item;
      // emit one more coalesced event so the admin SSE channel sees a single refresh.
      adminEventBus.push("broadcast-queue-updated");

      logger.info({ added, timeToEmptyMs }, "[auto-refill] refill complete");
    }
  } catch (err) {
    logger.warn({ err }, "[auto-refill] run failed (non-fatal)");
  }
}

export function startAutoQueueRefill(): void {
  if (_timer) return;
  if (process.env["QUEUE_REFILL_DISABLE"]) {
    logger.info("[auto-refill] disabled via QUEUE_REFILL_DISABLE");
    return;
  }
  _status.enabled = true;
  void run();
  _timer = setInterval(() => { void run(); }, INTERVAL_MS);
  _timer.unref?.();
  logger.info({ triggerMs: TRIGGER_MS, batch: BATCH }, "[auto-refill] worker started");
}

export function stopAutoQueueRefill(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
