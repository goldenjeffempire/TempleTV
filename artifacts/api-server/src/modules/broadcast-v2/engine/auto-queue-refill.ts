/**
 * Auto Queue Refill
 *
 * When the broadcast queue's estimated remaining duration falls below
 * QUEUE_REFILL_TRIGGER_MS (default 30 min), this worker automatically
 * activates up to QUEUE_REFILL_BATCH (default 5) library videos that
 * have been transcoded (hlsMasterUrl IS NOT NULL) but are not currently
 * active in the broadcast queue.
 *
 * Selection criteria:
 *   1. Videos with hlsMasterUrl AND transcoding_status = 'hls_ready' only
 *      (raw MP4 uploads without HLS are excluded — HLS-gate policy)
 *   2. Ordered by imported_at DESC — newest content first
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

    // Find library videos that are transcoded/uploadable but NOT currently active in queue.
    // Excludes YouTube-sourced videos — those are served through the ytShuffleFallback
    // override mechanism (activated when the local queue is empty) and should never be
    // inserted into the broadcast_queue directly.
    const candidates = await db.execute<{ id: string; title: string }>(sql`
      SELECT mv.id, mv.title
      FROM managed_videos mv
      WHERE
        mv.transcoding_status = 'hls_ready'
        AND mv.hls_master_url IS NOT NULL
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

    let added = 0;
    for (const row of rows) {
      try {
        // Re-activate existing inactive queue row OR insert a new one.
        await db.execute(sql`
          INSERT INTO broadcast_queue (video_id, title, duration_secs, is_active, created_at, updated_at)
          SELECT
            mv.id,
            mv.title,
            COALESCE(mv.duration::float, 1800),
            true,
            NOW(),
            NOW()
          FROM managed_videos mv
          WHERE mv.id = ${row.id}
          ON CONFLICT (video_id) DO UPDATE
            SET is_active = true, updated_at = NOW()
          WHERE broadcast_queue.is_active = false
        `);
        added++;
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
