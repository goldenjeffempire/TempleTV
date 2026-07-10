/**
 * Midnight Prayers Scheduler
 *
 * Server-driven replacement for the old client-side "shadow engine" that
 * polled `/api/midnight-prayers/config` and swapped its base API URL between
 * `/api/broadcast-v2` and `/api/midnight-prayers`. That approach bypassed the
 * orchestrator entirely, was not integrated with the dual-buffer gapless
 * preload system, and was the root cause of blank screens / reloads at the
 * window boundary.
 *
 * This scheduler instead drives the orchestrator's queue-swap engine
 * (`activateMidnightPrayers` / `deactivateMidnightPrayers`): while the
 * configured window is open, the orchestrator's `this.items` IS the
 * Midnight Prayers rotation, so every viewer gets the exact same
 * dual-buffer preload, checkpoint/resume, self-healing, and dead-air
 * protection the primary broadcast already relies on — no bespoke logic.
 *
 * Polled frequently (every 10 s) so the window boundary is hit within a few
 * seconds in either direction, and so a just-uploaded/just-fixed video can
 * join an already-open window promptly.
 */

import { and, eq, inArray, isNotNull, isNull, not, or } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { broadcastOrchestrator } from "./broadcast-orchestrator.js";
import { queueRepo, type RawQueueRow } from "../repository/queue.repo.js";
import { midnightPrayersService } from "../../midnight-prayers/midnight-prayers.service.js";
import { isWindowActive } from "../../midnight-prayers/window-utils.js";

const CHANNEL_ID = "midnight-prayers";

/**
 * Mirrors auto-enqueue.service.ts / midnight-prayers.service.ts: local MP4s
 * that permanently failed assembly/integrity can never be re-tried and must
 * never enter rotation.
 */
const TERMINAL_ERROR_CODES = ["ASSEMBLY_FAILED", "CORRUPT_SOURCE", "SOURCE_MISSING"] as const;

let bootReconciliationDone = false;

/**
 * Loads every currently-eligible Midnight Prayers video from managed_videos,
 * ordered deterministically (imported_at, then id as a tiebreaker), and
 * resolves each into an orchestrator-ready CachedQueueItem via the SAME
 * per-row resolution path (`queueRepo.toItem`) reloadInner() uses for the
 * primary queue — guaranteeing identical source-resolution, URL-proxying,
 * and localhost-warning behavior.
 */
async function loadEligibleMpItems(): Promise<ReturnType<typeof queueRepo.toItem>[]> {
  const rows = await db
    .select({
      id: schema.videosTable.id,
      title: schema.videosTable.title,
      thumbnailUrl: schema.videosTable.thumbnailUrl,
      duration: schema.videosTable.duration,
      localVideoUrl: schema.videosTable.localVideoUrl,
      hlsMasterUrl: schema.videosTable.hlsMasterUrl,
      youtubeId: schema.videosTable.youtubeId,
    })
    .from(schema.videosTable)
    .where(
      and(
        eq(schema.videosTable.category, CHANNEL_ID),
        or(
          isNotNull(schema.videosTable.hlsMasterUrl),
          and(
            isNotNull(schema.videosTable.localVideoUrl),
            isNotNull(schema.videosTable.s3MirroredAt),
            or(
              isNull(schema.videosTable.transcodingErrorCode),
              not(inArray(schema.videosTable.transcodingErrorCode, [...TERMINAL_ERROR_CODES])),
            ),
          ),
        ),
      ),
    )
    .orderBy(schema.videosTable.importedAt, schema.videosTable.id);

  const resolved: ReturnType<typeof queueRepo.toItem>[] = [];
  for (const r of rows) {
    const durSecs = (() => {
      const parsed = typeof r.duration === "string" ? parseInt(r.duration, 10) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1800;
    })();
    const raw: RawQueueRow = {
      id: r.id,
      videoId: r.id,
      youtubeId: r.youtubeId ?? "",
      title: r.title ?? "Midnight Prayers",
      thumbnailUrl: r.thumbnailUrl ?? null,
      durationSecs: durSecs,
      localVideoUrl: r.localVideoUrl ?? r.hlsMasterUrl ?? null,
      videoDuration: r.duration ?? null,
      sourceQuality: "mp4",
    };
    const item = queueRepo.toItem(raw, 0);
    if (item) resolved.push(item);
  }
  return resolved;
}

/**
 * Single scan tick: reconciles the orchestrator's Midnight Prayers state
 * with the configured window. Called every 10 s by the supervised worker.
 */
export async function midnightPrayersSchedulerScan(): Promise<void> {
  const config = midnightPrayersService.getConfig();
  const active = isWindowActive(Date.now(), config);

  // Boot-time reconciliation (runs once): if the process crashed/restarted
  // while a Midnight Prayers checkpoint was pending, resolve it now. If the
  // window is still open we simply re-activate below with a fresh video
  // fetch (activateMidnightPrayers persists a brand-new, still-correct
  // checkpoint). If the window already closed while the process was down,
  // apply the stale checkpoint directly so the main queue resumes exactly
  // where it paused instead of restarting from item 0.
  if (!bootReconciliationDone) {
    bootReconciliationDone = true;
    if (!active && !broadcastOrchestrator.isMidnightPrayersActive) {
      try {
        await broadcastOrchestrator.resolvePendingMidnightPrayersCheckpoint();
      } catch (err) {
        logger.warn({ err }, "[midnight-prayers] boot reconciliation failed (non-fatal)");
      }
    }
  }

  if (active && !broadcastOrchestrator.isMidnightPrayersActive) {
    let items: ReturnType<typeof queueRepo.toItem>[] = [];
    try {
      items = await loadEligibleMpItems();
    } catch (err) {
      logger.error({ err }, "[midnight-prayers] failed to load eligible videos — will retry next tick");
      return;
    }
    if (items.length === 0) {
      logger.warn(
        "[midnight-prayers] window is open but no eligible videos are available — main broadcast continues, will retry",
      );
      return;
    }
    const cachedItems = items.map((it) => ({
      id: it!.id,
      videoId: it!.id,
      title: it!.title,
      thumbnailUrl: it!.thumbnailUrl,
      durationSecs: it!.durationSecs,
      primaryUrl: it!.source.url,
      source: it!.source,
      failoverSource: it!.failoverSource as { kind: "mp4"; url: string } | null,
      sourceQuality: "mp4" as const,
    }));
    await broadcastOrchestrator.activateMidnightPrayers(cachedItems);
    adminEventBus.push("midnight-prayers-status", {
      active: true,
      itemCount: cachedItems.length,
      ts: Date.now(),
    });
  } else if (!active && broadcastOrchestrator.isMidnightPrayersActive) {
    await broadcastOrchestrator.deactivateMidnightPrayers();
    adminEventBus.push("midnight-prayers-status", { active: false, itemCount: 0, ts: Date.now() });
  }
}
