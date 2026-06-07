/**
 * YouTube Live Status Service
 *
 * Subscribes to the ytPoller singleton and keeps the `youtube_live_status`
 * column on `managed_videos` rows consistent with real-time YouTube live state.
 *
 * State machine:
 *   null        ← initial / not applicable (non-YouTube or never went live)
 *   'live'      ← stream is actively airing on YouTube right now
 *   'rebroadcast' ← stream ended; video is available as a VOD/replay
 *
 * Event flow:
 *   ytPoller emits "change" whenever isLive / videoId changes.
 *
 *   • live start  → UPDATE rows WHERE youtube_id = videoId → 'live'
 *                   Also demote any OTHER rows still at 'live' → 'rebroadcast'
 *                   (handles channel switching mid-stream)
 *
 *   • live end    → UPDATE all rows WHERE youtube_live_status = 'live' → 'rebroadcast'
 *
 *   • sweep (2min) → reconcile:
 *       - if NOT live:  any row at 'live' → heal to 'rebroadcast'
 *       - if live:      any row at 'live' WHERE youtube_id ≠ currentVideoId → 'rebroadcast'
 *
 * Wire-in: call installYoutubeLiveStatusService() from broadcast-v2 index.ts
 * after installYouTubeAutoOverride() — both subscribe to the same poller.
 */

import { eq, and, ne } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { ytPoller, type YtLiveState } from "./youtube-live.poller.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";

const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

let installed = false;
let sweepTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;

async function setLive(videoId: string): Promise<void> {
  try {
    // 1. Mark the currently-airing video as 'live'
    const liveResult = await db
      .update(schema.videosTable)
      .set({
        youtubeLiveStatus: "live",
        youtubeLiveStatusUpdatedAt: new Date(),
      })
      .where(eq(schema.videosTable.youtubeId, videoId))
      .returning({ id: schema.videosTable.id });

    // 2. Demote any OTHER video still marked 'live' (channel-switch guard).
    //    This covers "video A was live, video B goes live" without waiting for
    //    a stream-end event from the poller.
    const demoted = await db
      .update(schema.videosTable)
      .set({
        youtubeLiveStatus: "rebroadcast",
        youtubeLiveStatusUpdatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.videosTable.youtubeLiveStatus, "live"),
          ne(schema.videosTable.youtubeId, videoId),
        ),
      )
      .returning({ id: schema.videosTable.id });

    if (liveResult.length === 0) {
      logger.info({ videoId }, "[yt-live-status] no managed_videos row for live videoId — no badge update");
    } else {
      logger.info({ videoId, rows: liveResult.length, demoted: demoted.length }, "[yt-live-status] marked live");
    }

    const changed = liveResult.length > 0 || demoted.length > 0;
    if (changed) {
      adminEventBus.push("youtube-live-status-changed", { status: "live", videoId, rowIds: liveResult.map((r) => r.id) });
      adminEventBus.push("videos-library-updated", { reason: "youtube-live-status-changed" });
      await invalidateVideosCatalogCache().catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, videoId }, "[yt-live-status] setLive failed (non-fatal)");
  }
}

async function setRebroadcast(): Promise<void> {
  try {
    const result = await db
      .update(schema.videosTable)
      .set({
        youtubeLiveStatus: "rebroadcast",
        youtubeLiveStatusUpdatedAt: new Date(),
      })
      .where(eq(schema.videosTable.youtubeLiveStatus, "live"))
      .returning({ id: schema.videosTable.id, youtubeId: schema.videosTable.youtubeId });

    if (result.length === 0) {
      logger.info("[yt-live-status] no rows at 'live' to transition to 'rebroadcast'");
      return;
    }

    logger.info({ rows: result.length }, "[yt-live-status] transitioned 'live' → 'rebroadcast'");
    adminEventBus.push("youtube-live-status-changed", { status: "rebroadcast", rowIds: result.map((r) => r.id) });
    adminEventBus.push("videos-library-updated", { reason: "youtube-live-status-changed" });
    await invalidateVideosCatalogCache().catch(() => {});
  } catch (err) {
    logger.warn({ err }, "[yt-live-status] setRebroadcast failed (non-fatal)");
  }
}

async function runSweep(): Promise<void> {
  try {
    const state = ytPoller.getState();

    if (!state.isLive) {
      // Not live — any row still at 'live' is stale; heal it.
      const staleRows = await db
        .select({ id: schema.videosTable.id })
        .from(schema.videosTable)
        .where(eq(schema.videosTable.youtubeLiveStatus, "live"))
        .limit(100);

      if (staleRows.length > 0) {
        logger.info({ staleRows: staleRows.length }, "[yt-live-status] sweep: found stale 'live' rows — healing to 'rebroadcast'");
        await setRebroadcast();
      }
      return;
    }

    // Live — any row at 'live' with a DIFFERENT youtube_id is a stale row
    // from a previous stream. Demote those to 'rebroadcast'.
    if (state.videoId) {
      const staleRows = await db
        .select({ id: schema.videosTable.id })
        .from(schema.videosTable)
        .where(
          and(
            eq(schema.videosTable.youtubeLiveStatus, "live"),
            ne(schema.videosTable.youtubeId, state.videoId),
          ),
        )
        .limit(100);

      if (staleRows.length > 0) {
        logger.info(
          { staleRows: staleRows.length, currentVideoId: state.videoId },
          "[yt-live-status] sweep: found stale 'live' rows from prior stream — healing to 'rebroadcast'",
        );
        const demoted = await db
          .update(schema.videosTable)
          .set({ youtubeLiveStatus: "rebroadcast", youtubeLiveStatusUpdatedAt: new Date() })
          .where(
            and(
              eq(schema.videosTable.youtubeLiveStatus, "live"),
              ne(schema.videosTable.youtubeId, state.videoId),
            ),
          )
          .returning({ id: schema.videosTable.id });
        if (demoted.length > 0) {
          adminEventBus.push("youtube-live-status-changed", { status: "rebroadcast", rowIds: demoted.map((r) => r.id) });
          adminEventBus.push("videos-library-updated", { reason: "youtube-live-status-changed" });
          await invalidateVideosCatalogCache().catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "[yt-live-status] sweep failed (non-fatal)");
  }
}

function onPollerChange(state: YtLiveState): void {
  if (state.isLive && state.videoId) {
    void (async () => {
      try { await setLive(state.videoId!); } catch { /* handled inside */ }
    })();
  } else if (!state.isLive) {
    void (async () => {
      try { await setRebroadcast(); } catch { /* handled inside */ }
    })();
  }
}

export function installYoutubeLiveStatusService(): void {
  if (installed) return;
  installed = true;

  unsubscribe = ytPoller.subscribe((state) => {
    onPollerChange(state);
  });

  sweepTimer = setInterval(() => {
    void runSweep();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  void runSweep();

  logger.info("[yt-live-status] service installed — watching ytPoller for live status transitions");
}

export function uninstallYoutubeLiveStatusService(): void {
  if (!installed) return;
  installed = false;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
