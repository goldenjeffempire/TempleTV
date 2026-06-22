/**
 * YouTube Catalog Shuffle Fallback
 *
 * Dead-air backstop that activates when the broadcast queue has no locally
 * playable content.  Queries managed_videos for YouTube catalog entries
 * (videoSource='youtube', youtubeId IS NOT NULL), Fisher-Yates shuffles them,
 * and applies a finite-duration YouTube override frame to the orchestrator so
 * viewers see content while local uploads are unavailable.
 *
 * Lifecycle:
 *   activate()   — called by the orchestrator self-heal timer after
 *                  scanLibraryAndEnqueue returns 0 and the queue stays empty.
 *                  Starts the first shuffled video with a 20-minute override.
 *   advance()    — called by the orchestrator self-heal timer when the shuffle
 *                  is active but the running override has ended (natural end).
 *                  Moves to the next playlist position immediately, re-shuffling
 *                  on wraparound for ongoing variety.
 *   deactivate() — called by the orchestrator reloadInner when at least one
 *                  locally-playable queue item is resolved.  Auto-clears the
 *                  running override (only if IDs match — never evicts operator
 *                  overrides).
 *
 * Design constraints:
 *   - No module-init import of broadcastOrchestrator (avoids circular dep).
 *     The orchestrator passes start/stop callbacks at call time.
 *   - Fisher-Yates shuffle for quality randomness with no native dependency.
 *   - Idempotent activate(): silently no-ops when already active or activating.
 *   - Safe advance()/deactivate(): silently no-ops when not active.
 *   - All DB / override calls are try/catch — errors never crash the orchestrator.
 *   - Emits "broadcast-dead-air-fallback" / "broadcast-dead-air-recovered" on
 *     adminEventBus so admin SSE clients and the activity log can surface state.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { env } from "../../../config/env.js";
import type { V2Override } from "../domain/types.js";

/**
 * Parse a managed_videos.duration text value (seconds as a string, e.g. "3600")
 * into milliseconds.  Returns null when the string is empty, non-numeric, or zero.
 */
function parseDurationMs(raw: string | null | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const secs = parseInt(raw.trim(), 10);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return secs * 1000;
}

/**
 * Compute the override window (ms) for a single shuffle-fallback video.
 *
 * Uses the video's actual duration so long sermons play in full instead of
 * being cut at the old hardcoded 20-minute cap.  Applies a configurable
 * minimum floor (YOUTUBE_SHUFFLE_MIN_SLOT_SECS, default 3 min) so very short
 * clips don't cycle the playlist too rapidly.  Falls back to
 * YOUTUBE_SHUFFLE_DEFAULT_DURATION_SECS (default 2 h) when no duration is
 * available.
 */
function computeSlotMs(rawDuration: string | null | undefined): number {
  const actual = parseDurationMs(rawDuration);
  const defaultMs = env.YOUTUBE_SHUFFLE_DEFAULT_DURATION_SECS * 1000;
  const minMs = env.YOUTUBE_SHUFFLE_MIN_SLOT_SECS * 1000;
  const slotMs = actual ?? defaultMs;
  return Math.max(slotMs, minMs);
}

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
  /** Raw duration string from managed_videos.duration (seconds as text). */
  duration: string;
}

export interface YtShuffleFallbackInfo {
  enabled: boolean;
  active: boolean;
  videoId: string | null;
  videoTitle: string | null;
  activatedAtMs: number | null;
  lastDeactivatedAtMs: number | null;
  activateCount: number;
  advanceCount: number;
  deactivateCount: number;
  catalogSize: number;
  playlistIndex: number;
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
  private _advanceCount = 0;
  private _deactivateCount = 0;
  private _lastError: string | null = null;

  /** Full shuffled playlist (populated by activate(), re-shuffled on wraparound). */
  private _shuffledPlaylist: YtVideoEntry[] = [];
  /** Current index in the shuffled playlist. */
  private _playlistIndex = 0;

  get isActive(): boolean { return this._active; }

  /** Override ID applied by this module — used by the orchestrator to check before stopping. */
  get activeOverrideId(): string | null { return this._activeOverrideId; }

  /**
   * Activate the YouTube shuffle fallback.
   *
   * Queries managed_videos for YouTube catalog entries, Fisher-Yates shuffles
   * them, and starts the first video with a 20-minute finite-duration override.
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
          duration: videosTable.duration,
        })
        .from(videosTable)
        .where(
          and(
            eq(videosTable.videoSource, "youtube"),
            isNotNull(videosTable.youtubeId),
          ),
        );

      const entries: YtVideoEntry[] = rows.filter(
        (r): r is { youtubeId: string; title: string; duration: string } =>
          typeof r.youtubeId === "string" && r.youtubeId.length > 0,
      );

      if (entries.length === 0) {
        logger.info(
          "[yt-shuffle] no YouTube catalog entries found — YouTube shuffle fallback inactive",
        );
        return;
      }

      this._shuffledPlaylist = fisherYatesShuffle(entries);
      this._playlistIndex = 0;
      const pick = this._shuffledPlaylist[0]!;
      const slotMs = computeSlotMs(pick.duration);

      const override = await startOverride({
        kind: "youtube",
        url: buildYouTubeUrl(pick.youtubeId),
        title: pick.title,
        endsAtMs: Date.now() + slotMs,
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
          playlistIndex: 0,
        },
        "[yt-shuffle] YouTube shuffle fallback ACTIVATED — queue empty, cycling YouTube catalog",
      );

      adminEventBus.push("broadcast-dead-air-fallback", {
        kind: "youtube-shuffle",
        videoId: pick.youtubeId,
        title: pick.title,
        catalogSize: entries.length,
        playlistIndex: 0,
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
   * Advance to the next video in the shuffled playlist.
   *
   * Called by the orchestrator self-heal timer when the shuffle fallback is
   * active but the running override has naturally ended (endsAtMs expired +
   * this.override === null).  Starts the next video immediately with a new
   * 20-minute finite override, re-shuffling the full catalog on wraparound.
   *
   * Idempotent: silently no-ops when not active or already activating.
   */
  async advance(startOverride: StartOverrideFn): Promise<void> {
    if (!this._active || this._activating) return;
    if (env.YOUTUBE_SHUFFLE_FALLBACK_DISABLE) {
      // Disabled mid-session — treat as deactivate without stopOverride since
      // the override already ended naturally (this.override === null).
      this._active = false;
      this._activeOverrideId = null;
      this._currentVideoId = null;
      this._currentVideoTitle = null;
      this._lastDeactivatedAtMs = Date.now();
      return;
    }

    this._activating = true;
    try {
      if (this._shuffledPlaylist.length === 0) {
        // Playlist was lost (e.g. after a hot-reload) — fall back to activate()
        // which re-queries the catalog and re-shuffles.
        this._activating = false;
        this._active = false; // Allow activate() to run
        await this.activate(startOverride);
        return;
      }

      this._playlistIndex += 1;
      if (this._playlistIndex >= this._shuffledPlaylist.length) {
        // Reached the end — re-shuffle for ongoing variety without repetition
        this._shuffledPlaylist = fisherYatesShuffle(this._shuffledPlaylist);
        this._playlistIndex = 0;
      }

      const pick = this._shuffledPlaylist[this._playlistIndex]!;
      const slotMs = computeSlotMs(pick.duration);

      const override = await startOverride({
        kind: "youtube",
        url: buildYouTubeUrl(pick.youtubeId),
        title: pick.title,
        endsAtMs: Date.now() + slotMs,
        resumeQueueOnEnd: true,
      });

      this._activeOverrideId = override.id;
      this._currentVideoId = pick.youtubeId;
      this._currentVideoTitle = pick.title;
      this._advanceCount += 1;
      this._lastError = null;

      logger.info(
        {
          videoId: pick.youtubeId,
          title: pick.title,
          overrideId: override.id,
          catalogSize: this._shuffledPlaylist.length,
          playlistIndex: this._playlistIndex,
          slotMins: Math.round(slotMs / 60_000),
        },
        "[yt-shuffle] YouTube shuffle fallback ADVANCED — next catalog video started",
      );

      adminEventBus.push("broadcast-dead-air-fallback", {
        kind: "youtube-shuffle",
        videoId: pick.youtubeId,
        title: pick.title,
        catalogSize: this._shuffledPlaylist.length,
        playlistIndex: this._playlistIndex,
        activatedAtMs: this._activatedAtMs,
      });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "[yt-shuffle] advance() failed to start next YouTube video (non-fatal)");
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
    this._shuffledPlaylist = [];
    this._playlistIndex = 0;
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

  /**
   * Refresh the in-memory YouTube catalog playlist after a sync has added or
   * updated videos.  Called by youtube-sync.service after a successful sync.
   *
   * Behaviour:
   *   - Not active: silently no-ops; activate() already queries fresh on activation.
   *   - Active + activating: no-op to avoid concurrent catalog loads.
   *   - Active: queries the full YouTube catalog from DB, finds entries not
   *     already in the shuffled playlist (by youtubeId), and inserts them at
   *     a random position AFTER the current playlistIndex.  Current playback
   *     is not interrupted.  On the next wraparound the full catalog is
   *     re-shuffled, so new videos naturally enter the rotation.
   */
  async refreshCatalog(): Promise<void> {
    if (!this._active || this._activating) return;
    if (env.YOUTUBE_SHUFFLE_FALLBACK_DISABLE) return;

    try {
      const videosTable = schema.videosTable;
      const rows = await db
        .select({ youtubeId: videosTable.youtubeId, title: videosTable.title, duration: videosTable.duration })
        .from(videosTable)
        .where(and(eq(videosTable.videoSource, "youtube"), isNotNull(videosTable.youtubeId)));

      const freshEntries: YtVideoEntry[] = rows.filter(
        (r): r is { youtubeId: string; title: string; duration: string } =>
          typeof r.youtubeId === "string" && r.youtubeId.length > 0,
      );

      if (freshEntries.length === 0) return;

      const existingIds = new Set(this._shuffledPlaylist.map((e) => e.youtubeId));
      const newEntries = freshEntries.filter((e) => !existingIds.has(e.youtubeId));

      if (newEntries.length === 0) return;

      // Insert new entries at a random position after the current index so they
      // enter the rotation without disturbing the currently-playing slot.
      const insertAfter = Math.max(
        this._playlistIndex,
        Math.floor(Math.random() * (this._shuffledPlaylist.length - this._playlistIndex)) +
          this._playlistIndex,
      );
      this._shuffledPlaylist.splice(insertAfter + 1, 0, ...fisherYatesShuffle(newEntries));

      logger.info(
        { newEntries: newEntries.length, totalCatalog: this._shuffledPlaylist.length },
        "[yt-shuffle] catalog refreshed after YouTube sync — new videos added to rotation",
      );
    } catch (err) {
      logger.warn({ err }, "[yt-shuffle] refreshCatalog() failed (non-fatal)");
    }
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
      advanceCount: this._advanceCount,
      deactivateCount: this._deactivateCount,
      catalogSize: this._shuffledPlaylist.length,
      playlistIndex: this._playlistIndex,
      lastError: this._lastError,
    };
  }
}

export const ytShuffleFallback = new YtShuffleFallback();
