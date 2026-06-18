/**
 * Auto Queue Refill
 *
 * When the broadcast queue's estimated remaining duration falls below
 * QUEUE_REFILL_TRIGGER_MS (default 30 min), this worker automatically
 * activates up to QUEUE_REFILL_BATCH (default 5) library videos that
 * have been transcoded (hlsMasterUrl IS NOT NULL) but are not currently
 * active in the broadcast queue.
 *
 * Selection criteria (in order of preference):
 *   1. Videos with hlsMasterUrl (HLS transcoded) — best quality
 *   2. Videos with localVideoUrl (raw MP4 upload) — acceptable fallback
 *   3. Ordered by created_at DESC — newest content first
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
}

let _status: AutoRefillStatus = {
  enabled: !process.env["QUEUE_REFILL_DISABLE"],
  lastRunAtMs: null,
  lastRefillAtMs: null,
  lastRefillCount: 0,
  totalRefilled: 0,
};
let _timer: NodeJS.Timeout | null = null;
let _lastRefillAtMs = 0;

export function getAutoRefillStatus(): AutoRefillStatus {
  return { ..._status };
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
        mv.transcoding_status IN ('ready', 'hls_ready', 'none')
        AND (mv.hls_master_url IS NOT NULL OR mv.local_video_url IS NOT NULL)
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
      logger.warn("[auto-refill] no eligible library videos to add — queue may go empty");
      return;
    }

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
