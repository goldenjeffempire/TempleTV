import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";
import { syncYouTubeChannel, setNextSyncAt, restoreQuota, isSyncInProgress } from "./youtube-sync.service.js";

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
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  get intervalMs(): number {
    return env.YOUTUBE_SYNC_INTERVAL_MINS * 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;

    const apiKey = env.YOUTUBE_API_KEY;
    const source = apiKey ? "YouTube Data API v3" : "RSS feed (no YOUTUBE_API_KEY set)";
    logger.info({ intervalMins: this.intervalMs / 60_000, source }, "youtube-sync dispatcher started");

    restoreQuota().catch((err) => {
      logger.warn({ err }, "youtube-sync: quota restore on startup failed (non-fatal)");
    });

    // Kick off first sync 30 s after boot so the server is fully ready.
    this.scheduleNext(30_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    const nextAt = new Date(Date.now() + delayMs);
    setNextSyncAt(nextAt);
    this.timer = setTimeout(() => void this.runOnce(), delayMs);
  }

  private async runOnce(): Promise<void> {
    if (this.stopped) return;
    // Use the service-level semaphore rather than a local `running` flag so the
    // manual-trigger path (`triggerNow`) and this scheduled path share the same
    // guard and can never run concurrently.
    if (isSyncInProgress()) {
      logger.warn("youtube-sync dispatcher: sync already in progress, skipping scheduled run");
      this.scheduleNext(this.intervalMs);
      return;
    }
    try {
      await syncYouTubeChannel("scheduler");
    } catch (err) {
      logger.warn({ err }, "youtube-sync dispatcher: sync failed (will retry next interval)");
    } finally {
      this.scheduleNext(this.intervalMs);
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
      throw new Error("A YouTube sync is already in progress");
    }
    return syncYouTubeChannel("manual");
  }
}

export const youtubeSyncDispatcher = new YouTubeSyncDispatcher();
