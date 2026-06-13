/**
 * YouTube Catalog Shuffle Fallback
 *
 * Dead-air backstop that activates when the broadcast queue has no locally
 * playable content.  Queries managed_videos for YouTube catalog entries
 * (videoSource='youtube', youtubeId IS NOT NULL), shuffles them, and applies
 * a YouTube override frame to the orchestrator so viewers see content while
 * local uploads are unavailable.
 *
 * Lifecycle:
 *   activate()   — called by the orchestrator self-heal timer after
 *                  scanLibraryAndEnqueue returns 0 and the queue stays empty.
 *   deactivate() — called by the orchestrator reloadInner when at least one
 *                  locally-playable queue item is resolved.
 *
 * Design constraints:
 *   - No module-init import of broadcastOrchestrator (avoids circular dep).
 *     The orchestrator passes start/stop callbacks at call time.
 *   - Fisher-Yates shuffle for quality randomness with no native dependency.
 *   - Idempotent activate(): silently no-ops when already active or activating.
 *   - Safe deactivate(): silently no-ops when not active.
 *   - All DB / override calls are try/catch — errors never crash the orchestrator.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { env } from "../../../config/env.js";
import type { V2Override } from "../domain/types.js";

type StartOverrideFn = (opts: {
  kind: V2Override["kind"];
  url: string;
  title: string;
  endsAtMs: number | null;
  resumeQueueOnEnd: boolean;
}) => Promise<V2Override>;

type StopOverrideFn = () => Promise<void>;

interface YtVideoEntry {
  youtubeId: string;
  title: string;
}

export interface YtShuffleFallbackInfo {
  enabled: boolean;
  active: boolean;
  videoId: string | null;
  videoTitle: string | null;
  activatedAtMs: number | null;
  lastDeactivatedAtMs: number | null;
  activateCount: number;
  deactivateCount: number;
  catalogSize: number;
  lastError: string | null;
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

class YtShuffleFallback {
  private _active = false;
  private _activating = false;
  private _activeOverrideId: string | null = null;
  private _currentVideoId: string | null = null;
  private _currentVideoTitle: string | null = null;
  private _activatedAtMs: number | null = null;
  private _lastDeactivatedAtMs: number | null = null;
  private _activateCount = 0;
  private _deactivateCount = 0;
  private _lastError: string | null = null;
  private _catalogSize = 0;

  get isActive(): boolean { return this._active; }

  /** Override ID applied by this module — used by the orchestrator to check before stopping. */
  get activeOverrideId(): string | null { return this._activeOverrideId; }

  /**
   * Activate the YouTube shuffle fallback.
   *
   * Queries managed_videos for YouTube catalog entries, picks a random one, and
   * applies a YouTube override on the orchestrator via the provided callback.
   * Idempotent: silently no-ops when already active or when YOUTUBE_SHUFFLE_FALLBACK_DISABLE=true.
   */
  async activate(startOverride: StartOverrideFn): Promise<void> {
    if (this._active || this._activating) return;
    if (env.YOUTUBE_SHUFFLE_FALLBACK_DISABLE) return;

    this._activating = true;
    try {
      const videosTable = schema.videosTable;
      const rows = await db
        .select({
          youtubeId: videosTable.youtubeId,
          title: videosTable.title,
        })
        .from(videosTable)
        .where(
          and(
            eq(videosTable.videoSource, "youtube"),
            isNotNull(videosTable.youtubeId),
          ),
        );

      const entries: YtVideoEntry[] = rows.filter(
        (r): r is { youtubeId: string; title: string } =>
          typeof r.youtubeId === "string" && r.youtubeId.length > 0,
      );

      this._catalogSize = entries.length;

      if (entries.length === 0) {
        logger.info(
          "[yt-shuffle] no YouTube catalog entries found — YouTube shuffle fallback inactive",
        );
        return;
      }

      const shuffled = fisherYatesShuffle(entries);
      const pick = shuffled[0]!;

      const override = await startOverride({
        kind: "youtube",
        url: buildYouTubeUrl(pick.youtubeId),
        title: pick.title,
        endsAtMs: null,
        resumeQueueOnEnd: true,
      });

      this._active = true;
      this._activeOverrideId = override.id;
      this._currentVideoId = pick.youtubeId;
      this._currentVideoTitle = pick.title;
      this._activatedAtMs = Date.now();
      this._activateCount += 1;
      this._lastError = null;

      logger.warn(
        {
          videoId: pick.youtubeId,
          title: pick.title,
          overrideId: override.id,
          catalogSize: entries.length,
        },
        "[yt-shuffle] YouTube shuffle fallback ACTIVATED — queue empty, cycling YouTube catalog",
      );

      adminEventBus.push("broadcast-dead-air-fallback", {
        kind: "youtube-shuffle",
        videoId: pick.youtubeId,
        title: pick.title,
        catalogSize: entries.length,
        activatedAtMs: this._activatedAtMs,
      });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "[yt-shuffle] failed to activate YouTube shuffle fallback (non-fatal)");
    } finally {
      this._activating = false;
    }
  }

  /**
   * Deactivate the YouTube shuffle fallback and stop the override.
   * Idempotent: silently no-ops when not active.
   * Calls the provided stopOverride callback — caller should guard this with an
   * override-ID check so operator-applied overrides are never stopped.
   */
  async deactivate(stopOverride: StopOverrideFn): Promise<void> {
    if (!this._active) return;

    const prevVideoId = this._currentVideoId;
    const prevOverrideId = this._activeOverrideId;

    this._active = false;
    this._activeOverrideId = null;
    this._currentVideoId = null;
    this._currentVideoTitle = null;
    this._lastDeactivatedAtMs = Date.now();
    this._deactivateCount += 1;

    try {
      await stopOverride();
      logger.info(
        { prevVideoId, prevOverrideId },
        "[yt-shuffle] YouTube shuffle fallback DEACTIVATED — local queue recovered",
      );
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "[yt-shuffle] YouTube shuffle fallback stopOverride failed (non-fatal)");
    }

    adminEventBus.push("broadcast-dead-air-recovered", {
      kind: "youtube-shuffle",
      prevVideoId,
      recoveredAtMs: this._lastDeactivatedAtMs,
    });
  }

  /** Snapshot for the /health endpoint and admin observability. */
  getInfo(): YtShuffleFallbackInfo {
    return {
      enabled: !env.YOUTUBE_SHUFFLE_FALLBACK_DISABLE,
      active: this._active,
      videoId: this._currentVideoId,
      videoTitle: this._currentVideoTitle,
      activatedAtMs: this._activatedAtMs,
      lastDeactivatedAtMs: this._lastDeactivatedAtMs,
      activateCount: this._activateCount,
      deactivateCount: this._deactivateCount,
      catalogSize: this._catalogSize,
      lastError: this._lastError,
    };
  }
}

export const ytShuffleFallback = new YtShuffleFallback();
