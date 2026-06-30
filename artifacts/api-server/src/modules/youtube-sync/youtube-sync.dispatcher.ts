import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";
import { syncYouTubeChannel, setNextSyncAt, restoreQuota, isSyncInProgress } from "./youtube-sync.service.js";
import { ConflictError } from "../../shared/errors.js";
import { workerSupervisor } from "../broadcast-v2/engine/worker-supervisor.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";

/**
 * Background YouTube channel sync dispatcher.
 *
 * Runs at a configurable interval (YOUTUBE_SYNC_INTERVAL_MINS env var,
 * default 15 minutes). Fetches all videos from the @TEMPLETVJCTM channel
 * via YouTube Data API v3 (RSS fallback when no API key is set) and
 * upserts them into the managed_videos table so every platform (TV,
 * mobile, admin) sees fresh content automatically.
 *
 * The PubSubHubbub webhook (youtube-webhook.routes.ts) supplements this
 * by triggering an immediate sync when YouTube notifies us of a new upload,
 * giving near-instant propagation without relying solely on the interval.
 * With the webhook active, 15-minute polling is purely a safety net —
 * new videos appear within seconds of the YouTube notification.
 */
class YouTubeSyncDispatcher {
  get intervalMs(): number {
    return env.YOUTUBE_SYNC_INTERVAL_MINS * 60_000;
  }

  /**
   * Single sync pass — called by the supervisor on each interval tick.
   *
   * Uses the service-level semaphore (`isSyncInProgress`) so the scheduled
   * path and the manual `triggerNow` path share the same concurrency guard
   * and can never run simultaneously. Errors are re-thrown so the supervisor
   * can count consecutive failures for circuit-breaking; the warn log here
   * provides structured context before the supervisor adds its own entry.
   */
  async runOnce(): Promise<void> {
    if (isSyncInProgress()) {
      logger.warn("youtube-sync dispatcher: sync already in progress, skipping scheduled run");
      return;
    }
    try {
      await syncYouTubeChannel("scheduler");
    } catch (err) {
      logger.warn({ err }, "youtube-sync dispatcher: sync failed (will retry next interval)");
      throw err;
    } finally {
      // Keep the admin UI "Next sync at" indicator accurate regardless of outcome.
      setNextSyncAt(new Date(Date.now() + this.intervalMs));
    }
  }

  /**
   * Trigger an immediate out-of-band sync (e.g. from the admin panel or
   * a PubSubHubbub webhook notification for a new upload).
   * Throws if a sync is already running (caller should check isSyncInProgress()
   * first or catch the error and surface it as a 409).
   */
  async triggerNow(): Promise<Awaited<ReturnType<typeof syncYouTubeChannel>>> {
    // Concurrency guard: triggerNow() previously bypassed the running check,
    // allowing a manual trigger and the scheduler to run simultaneously.
    // Two concurrent syncs would race on the same batch, producing duplicate-key
    // errors and corrupted inserted/updated statistics.
    if (isSyncInProgress()) {
      throw new ConflictError("A YouTube sync is already in progress — try again once the current sync completes");
    }
    return syncYouTubeChannel("manual");
  }
}

export const youtubeSyncDispatcher = new YouTubeSyncDispatcher();

/**
 * Register the YouTube sync dispatcher with WorkerSupervisor.
 *
 * Called from startSupervisedWorkers() in broadcast-v2/index.ts when
 * YOUTUBE_SYNC_DISABLE is not set. The supervisor provides circuit breaking
 * (5 consecutive failures → 10-min open), deadman timeouts, and health
 * metrics — replacing the old manual setTimeout approach.
 */
export function startYoutubeSyncDispatcher(): void {
  const intervalMs = env.YOUTUBE_SYNC_INTERVAL_MINS * 60_000;
  const source = env.YOUTUBE_API_KEY ? "YouTube Data API v3" : "RSS feed (no YOUTUBE_API_KEY set)";

  // Restore quota tracking state from DB so the daily-quota guard survives
  // process restarts — without this, a freshly-booted server would burn quota
  // on API calls even if the quota was already exhausted before the restart.
  restoreQuota().catch((err) => {
    logger.warn({ err }, "youtube-sync: quota restore on startup failed (non-fatal)");
  });

  workerSupervisor.spawn({
    name: "youtube-sync-dispatcher",
    fn: () => youtubeSyncDispatcher.runOnce(),
    intervalMs,
    initialDelayMs: 30_000,
    backoffMs: [30_000, 60_000, 5 * 60_000],
    onCircuitOpen: (name, consecutiveFailures) => {
      try {
        adminEventBus.push("ops-alert", {
          level: "warn",
          title: "YouTube Sync Suspended",
          message: `YouTube sync dispatcher circuit opened after ${consecutiveFailures} consecutive failures — automatic channel sync is paused. Auto-reset in 10 min.`,
          detail: "Check Diagnostics → Workers for recent error details.",
          timestamp: new Date().toISOString(),
          source: "youtube-sync-dispatcher",
          workerName: name,
        });
      } catch { /* non-fatal */ }
    },
  });

  logger.info(
    { intervalMins: intervalMs / 60_000, source },
    "youtube-sync dispatcher registered with supervisor",
  );
}
