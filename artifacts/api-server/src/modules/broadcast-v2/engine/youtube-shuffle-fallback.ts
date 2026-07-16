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

import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { env } from "../../../config/env.js";
import { runtimeRepo, type PersistedYtShuffleState } from "../repository/runtime.repo.js";
import type { V2Override } from "../domain/types.js";

/** Channel this singleton drives — always the main broadcast channel. */
const CHANNEL_ID = "main";

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
  resumeSeconds?: number;
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
  /** Wall-clock ms when the currently-playing video started (set on activate/advance). */
  currentVideoStartedAtMs: number | null;
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

/**
 * How long (ms) to suppress repeat activate() DB queries after the catalog
 * was found empty.  The selfHealEmptyTimer calls activate() every 5 s; without
 * this cooldown an empty-catalog deployment runs 12 SELECT queries/min that
 * never return rows — unnecessary DB load and heap pressure from Drizzle query
 * builder object churn.  60 s is long enough to react to a fresh YouTube sync
 * while being short enough to miss at most one YouTube override advancement.
 */
const EMPTY_CATALOG_RECHECK_MS = 60_000;

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
  /**
   * Wall-clock ms when the currently-playing video started.
   * Set in both activate() and advance(). Used by the /yt-playback-error
   * handler to enforce a minimum-play-time guard before triggering an advance,
   * preventing cascade skips through buffering or briefly-unresolvable videos.
   */
  private _currentVideoStartedAtMs: number | null = null;
  /**
   * Timestamp (ms) of the last activate() call that found an empty catalog.
   * Used to enforce EMPTY_CATALOG_RECHECK_MS cooldown and suppress repeat
   * no-op DB queries on every self-heal-empty tick.
   */
  private _catalogEmptyLastCheckedMs: number | null = null;

  /** Full shuffled playlist (populated by activate(), re-shuffled on wraparound). */
  private _shuffledPlaylist: YtVideoEntry[] = [];
  /** Current index in the shuffled playlist. */
  private _playlistIndex = 0;

  /**
   * Persisted state loaded by hydrate() at boot. Consumed exactly once by the
   * first activate() call after a restart — either it produces a successful
   * resume (same video, correct elapsed position) or it is discarded and a
   * normal fresh activation proceeds.
   */
  private _hydratedState: PersistedYtShuffleState | null = null;
  private _hydrateAttempted = false;

  get isActive(): boolean { return this._active; }

  /**
   * True when hydrate() loaded valid persisted shuffle state that has not yet
   * been consumed by activate(). The orchestrator uses this at boot to decide
   * whether to fast-path into yt-shuffle activation immediately (skipping the
   * 30-75 s empty-poll accumulation cycle) so a YouTube-only deployment resumes
   * broadcasting within milliseconds of daemon restart instead of going dark.
   */
  get hasHydratedState(): boolean { return this._hydratedState !== null; }

  /**
   * Load the persisted shuffle-fallback state from the DB. Called once during
   * orchestrator boot, before the first activate(). Never throws — a failed
   * load just means the next activate() starts a fresh shuffle, which is the
   * pre-existing (safe) behaviour.
   */
  async hydrate(): Promise<void> {
    if (this._hydrateAttempted) return;
    this._hydrateAttempted = true;
    try {
      const state = await runtimeRepo.loadYtShuffleState(CHANNEL_ID);
      if (state && state.currentVideoId && state.playlist.length > 0 && state.currentVideoStartedAtMs != null) {
        this._hydratedState = state;
        logger.info(
          {
            videoId: state.currentVideoId,
            playlistIndex: state.playlistIndex,
            catalogSize: state.playlist.length,
            ageMs: Date.now() - state.savedAtMs,
          },
          "[yt-shuffle] hydrate: loaded persisted shuffle state — will attempt resume on next activation",
        );
      }
    } catch (err) {
      logger.warn({ err }, "[yt-shuffle] hydrate: failed to load persisted state (non-fatal)");
    }
  }

  /**
   * Persist the current shuffle-fallback state so a restart can resume the
   * same video at the correct elapsed position. Fire-and-forget; failures are
   * logged but never block playback.
   */
  private persistState(): void {
    const state: PersistedYtShuffleState = {
      playlist: this._shuffledPlaylist,
      playlistIndex: this._playlistIndex,
      currentVideoId: this._currentVideoId,
      currentVideoTitle: this._currentVideoTitle,
      currentVideoStartedAtMs: this._currentVideoStartedAtMs,
      activatedAtMs: this._activatedAtMs,
      savedAtMs: Date.now(),
    };
    void runtimeRepo.saveYtShuffleState(CHANNEL_ID, state).catch((err: unknown) =>
      logger.warn({ err }, "[yt-shuffle] failed to persist shuffle state (non-fatal)"),
    );
  }

  /**
   * Attempt to resume the exact video + elapsed position from a previous
   * process's persisted state (loaded by hydrate()). One-shot: the hydrated
   * state is consumed (cleared) on the first call regardless of outcome, so a
   * failed/stale resume always falls through to a normal fresh activation.
   *
   * Returns true when the resume succeeded and the caller (activate()) should
   * return immediately; false when the caller should proceed with a fresh
   * catalog query + shuffle.
   */
  private async tryResumeFromHydratedState(startOverride: StartOverrideFn): Promise<boolean> {
    const state = this._hydratedState;
    this._hydratedState = null;
    if (!state || !state.currentVideoId || state.playlist.length === 0 || state.currentVideoStartedAtMs == null) {
      return false;
    }
    try {
      const entry = state.playlist.find((p) => p.youtubeId === state.currentVideoId);
      if (!entry) return false;

      // Re-verify embeddability — it may have flipped since the state was saved.
      const videosTable = schema.videosTable;
      const embRow = await db
        .select({ isEmbeddable: videosTable.isEmbeddable })
        .from(videosTable)
        .where(eq(videosTable.youtubeId, entry.youtubeId))
        .limit(1);
      if (embRow[0]?.isEmbeddable === false) return false;

      const slotMs = computeSlotMs(entry.duration);
      const elapsedMs = Date.now() - state.currentVideoStartedAtMs;
      // Staleness guard: only resume if the video would still be meaningfully
      // playing right now (at least 5 s of runway left). A long server outage
      // or a save from an unusually short slot should fall through to a fresh
      // activation rather than resuming a video that has already ended.
      const MIN_REMAINING_MS = 5_000;
      if (elapsedMs < 0 || elapsedMs >= slotMs - MIN_REMAINING_MS) return false;

      this._shuffledPlaylist = state.playlist.slice();
      this._playlistIndex = state.playlistIndex;
      const resumeSeconds = Math.floor(elapsedMs / 1000);

      const override = await startOverride({
        kind: "youtube",
        url: buildYouTubeUrl(entry.youtubeId),
        title: entry.title,
        endsAtMs: state.currentVideoStartedAtMs + slotMs,
        resumeQueueOnEnd: true,
        resumeSeconds,
      });

      this._active = true;
      this._activeOverrideId = override.id;
      this._currentVideoId = entry.youtubeId;
      this._currentVideoTitle = entry.title;
      this._activatedAtMs = state.activatedAtMs ?? Date.now();
      this._currentVideoStartedAtMs = state.currentVideoStartedAtMs;
      this._activateCount += 1;
      this._lastError = null;

      logger.warn(
        {
          videoId: entry.youtubeId,
          title: entry.title,
          resumeSeconds,
          overrideId: override.id,
          playlistIndex: this._playlistIndex,
          catalogSize: this._shuffledPlaylist.length,
        },
        "[yt-shuffle] RESUMED after restart — same video continues from its last known position (not restarted from 0:00)",
      );

      adminEventBus.push("broadcast-dead-air-fallback", {
        kind: "youtube-shuffle",
        videoId: entry.youtubeId,
        title: entry.title,
        catalogSize: this._shuffledPlaylist.length,
        playlistIndex: this._playlistIndex,
        activatedAtMs: this._activatedAtMs,
        resumed: true,
        resumeSeconds,
      });

      this.persistState();
      return true;
    } catch (err) {
      logger.warn(
        { err },
        "[yt-shuffle] resume-from-hydrated-state failed (non-fatal) — falling back to fresh activation",
      );
      return false;
    }
  }

  /** Override ID applied by this module — used by the orchestrator to check before stopping. */
  get activeOverrideId(): string | null { return this._activeOverrideId; }

  /**
   * Activate the YouTube shuffle fallback.
   *
   * Queries managed_videos for YouTube catalog entries, Fisher-Yates shuffles
   * them, and starts the first video with a 20-minute finite-duration override.
   * Idempotent: silently no-ops when already active or when YOUTUBE_SHUFFLE_FALLBACK_DISABLE=true.
   *
   * Empty-catalog backoff: when the DB query returns 0 rows the result is
   * cached for EMPTY_CATALOG_RECHECK_MS (60 s).  The selfHealEmptyTimer calls
   * activate() every 5 s; without this guard that produces 12 no-op SELECT
   * queries/min and Drizzle query-builder object churn during the V8 JIT
   * warm-up window, amplifying the startup heap-slope alert.
   */
  async activate(startOverride: StartOverrideFn): Promise<void> {
    if (this._active || this._activating) return;
    if (env.YOUTUBE_SHUFFLE_FALLBACK_DISABLE) return;

    // Restart-resume path: if hydrate() loaded a persisted session, try to
    // resume the exact same video at its correct elapsed position before
    // falling back to a fresh catalog query + shuffle. One-shot per process.
    if (this._hydratedState) {
      this._activating = true;
      try {
        const resumed = await this.tryResumeFromHydratedState(startOverride);
        if (resumed) return;
      } finally {
        this._activating = false;
      }
    }

    // Backoff: skip the DB query if the catalog was recently found empty.
    if (
      this._catalogEmptyLastCheckedMs !== null &&
      Date.now() - this._catalogEmptyLastCheckedMs < EMPTY_CATALOG_RECHECK_MS
    ) {
      return;
    }

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
            // Midnight-prayers content is NEVER eligible for the main shuffle
            // fallback — it plays only on the dedicated midnight-prayers channel
            // during its restricted 00:00–03:00 window.
            // Use or(isNull, ne) — not plain ne() — because SQL NULL != 'midnight-prayers'
            // evaluates to NULL (falsy), silently excluding NULL-category rows.
            or(isNull(videosTable.category), ne(videosTable.category, "midnight-prayers")),
            // Only include videos YouTube allows to be embedded on third-party
            // sites. Non-embeddable videos render as "Video unavailable" inside
            // the iframe, creating silent dead air the orchestrator cannot detect.
            // is_embeddable defaults to true so existing rows are always included
            // until the next sync populates the real embeddability status.
            eq(videosTable.isEmbeddable, true),
          ),
        );

      const entries: YtVideoEntry[] = rows.filter(
        (r): r is { youtubeId: string; title: string; duration: string } =>
          typeof r.youtubeId === "string" && r.youtubeId.length > 0,
      );

      if (entries.length === 0) {
        this._catalogEmptyLastCheckedMs = Date.now();
        logger.info(
          "[yt-shuffle] no YouTube catalog entries found — YouTube shuffle fallback inactive",
        );
        return;
      }
      // Catalog has entries — clear the empty-cache so future calls don't
      // skip the query with stale "no results" state.
      this._catalogEmptyLastCheckedMs = null;

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
      this._currentVideoStartedAtMs = Date.now();
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

      this.persistState();
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

      // Guard: verify the picked video is still embeddable before committing
      // to it. YouTube can flip is_embeddable=false between catalog refreshes;
      // without this check a non-embeddable video starts as dead-air until the
      // client reports yt-playback-error and the orchestrator advances again.
      {
        const videosTable = schema.videosTable;
        const embRow = await db
          .select({ isEmbeddable: videosTable.isEmbeddable })
          .from(videosTable)
          .where(eq(videosTable.youtubeId, pick.youtubeId))
          .limit(1);
        if (embRow[0]?.isEmbeddable === false) {
          // Prune from in-memory playlist and trigger a fresh catalog query
          // via activate() so we immediately pick a different video.
          this._shuffledPlaylist.splice(this._playlistIndex, 1);
          logger.warn(
            { videoId: pick.youtubeId, title: pick.title, remainingCatalog: this._shuffledPlaylist.length },
            "[yt-shuffle] advance(): picked video is non-embeddable — pruned and re-activating with fresh catalog",
          );
          this._activating = false;
          this._active = false;
          await this.activate(startOverride);
          return;
        }
      }

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
      this._currentVideoStartedAtMs = Date.now();
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

      this.persistState();
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

    // Clear the persisted session — local content is back, so a future
    // restart should not resume a stale YouTube video.
    void runtimeRepo
      .clearYtShuffleState(CHANNEL_ID)
      .catch((err: unknown) => logger.warn({ err }, "[yt-shuffle] failed to clear persisted shuffle state (non-fatal)"));

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
        .where(and(
          eq(videosTable.videoSource, "youtube"),
          isNotNull(videosTable.youtubeId),
          // Midnight-prayers content excluded from main shuffle — dedicated channel only.
          // Use or(isNull, ne) to avoid the SQL NULL trap: NULL != 'midnight-prayers' = NULL.
          or(isNull(videosTable.category), ne(videosTable.category, "midnight-prayers")),
          // Only include embeddable videos — non-embeddable ones render as dead air.
          eq(videosTable.isEmbeddable, true),
        ));

      const freshEntries: YtVideoEntry[] = rows.filter(
        (r): r is { youtubeId: string; title: string; duration: string } =>
          typeof r.youtubeId === "string" && r.youtubeId.length > 0,
      );

      if (freshEntries.length === 0) return;

      const freshMap = new Map(freshEntries.map((e) => [e.youtubeId, e]));

      // ── Step 1: Prune videos that are no longer embeddable ────────────────
      // refreshCatalog() is called after every YouTube sync. If a video's
      // is_embeddable flag flipped to false on YouTube's side, the sync
      // updates the DB row but the in-memory playlist still holds the stale
      // entry. Without pruning, the client eventually sees "Video unavailable"
      // in the iframe, reports yt-playback-error, and the orchestrator
      // advances — potentially cascading through a run of bad videos rapidly.
      const prunedPlaylist: YtVideoEntry[] = [];
      let removedBeforeIndex = 0;
      for (let i = 0; i < this._shuffledPlaylist.length; i++) {
        const entry = this._shuffledPlaylist[i]!;
        const fresh = freshMap.get(entry.youtubeId);
        if (fresh) {
          // Update title/duration in place in case the sync changed them.
          prunedPlaylist.push({ youtubeId: entry.youtubeId, title: fresh.title, duration: fresh.duration });
        } else {
          if (i < this._playlistIndex) removedBeforeIndex++;
        }
      }
      const pruned = this._shuffledPlaylist.length - prunedPlaylist.length;
      this._shuffledPlaylist = prunedPlaylist;
      // Adjust the current index so we don't skip the next video after pruning.
      this._playlistIndex = Math.max(0, this._playlistIndex - removedBeforeIndex);
      if (this._playlistIndex >= this._shuffledPlaylist.length && this._shuffledPlaylist.length > 0) {
        this._playlistIndex = 0;
      }

      if (pruned > 0) {
        logger.warn(
          { pruned, remainingCatalog: this._shuffledPlaylist.length },
          "[yt-shuffle] pruned non-embeddable/removed videos from in-memory playlist",
        );
      }

      if (this._shuffledPlaylist.length === 0) {
        // All catalog videos were pruned — degenerate case; let activate() rebuild.
        logger.warn("[yt-shuffle] in-memory playlist empty after pruning — will re-activate on next tick");
        this._active = false;
        this._activeOverrideId = null;
        return;
      }

      // ── Step 2: Add new videos not already in the playlist ───────────────
      const existingIds = new Set(this._shuffledPlaylist.map((e) => e.youtubeId));
      const newEntries = freshEntries.filter((e) => !existingIds.has(e.youtubeId));

      if (newEntries.length === 0 && pruned === 0) return;

      if (newEntries.length > 0) {
        // Insert new entries at a random position after the current index so they
        // enter the rotation without disturbing the currently-playing slot.
        const insertAfter = Math.max(
          this._playlistIndex,
          Math.floor(Math.random() * (this._shuffledPlaylist.length - this._playlistIndex)) +
            this._playlistIndex,
        );
        this._shuffledPlaylist.splice(insertAfter + 1, 0, ...fisherYatesShuffle(newEntries));
      }

      logger.info(
        { pruned, newEntries: newEntries.length, totalCatalog: this._shuffledPlaylist.length },
        "[yt-shuffle] catalog refreshed after YouTube sync",
      );
    } catch (err) {
      logger.warn({ err }, "[yt-shuffle] refreshCatalog() failed (non-fatal)");
    }
  }

  /**
   * Return the next playlist entry (the video AFTER the currently-playing one)
   * without advancing the index.  Used by the orchestrator to include
   * `nextYtVideoId` in V2Snapshot so clients can preload the next YouTube
   * iframe before the current one ends.
   *
   * Returns null when the shuffle is not active, the playlist is empty, or
   * the playlist has only one entry (next === current).
   */
  peekNext(): { youtubeId: string; title: string } | null {
    if (!this._active || this._shuffledPlaylist.length < 2) return null;
    const nextIdx =
      this._playlistIndex + 1 >= this._shuffledPlaylist.length
        ? 0
        : this._playlistIndex + 1;
    const entry = this._shuffledPlaylist[nextIdx];
    return entry ? { youtubeId: entry.youtubeId, title: entry.title } : null;
  }

  /**
   * Explicitly persist the current YouTube shuffle state to the DB and await
   * the result. Called from the orchestrator's graceful-shutdown path
   * (flushCheckpointForShutdown) so a process exit within milliseconds of a
   * video advance cannot leave the DB with stale ytShuffleState.
   *
   * The periodic persistState() calls in advance() are fire-and-forget for
   * performance; this method is the one synchronous save that runs exactly
   * once, just before the process exits.  Always resolves (never throws) —
   * errors are logged and swallowed so a DB hiccup cannot block shutdown.
   *
   * No-ops immediately when the shuffle is not active (nothing useful to save).
   */
  async flushStateForShutdown(): Promise<void> {
    if (!this._active) return;
    const state: PersistedYtShuffleState = {
      playlist: this._shuffledPlaylist,
      playlistIndex: this._playlistIndex,
      currentVideoId: this._currentVideoId,
      currentVideoTitle: this._currentVideoTitle,
      currentVideoStartedAtMs: this._currentVideoStartedAtMs,
      activatedAtMs: this._activatedAtMs,
      savedAtMs: Date.now(),
    };
    await runtimeRepo.saveYtShuffleState(CHANNEL_ID, state).catch((err: unknown) =>
      logger.warn({ err }, "[yt-shuffle] flushStateForShutdown: failed to persist state (non-fatal)"),
    );
  }

  /** Snapshot for the /health endpoint and admin observability. */
  getInfo(): YtShuffleFallbackInfo {
    return {
      enabled: !env.YOUTUBE_SHUFFLE_FALLBACK_DISABLE,
      active: this._active,
      videoId: this._currentVideoId,
      videoTitle: this._currentVideoTitle,
      activatedAtMs: this._activatedAtMs,
      currentVideoStartedAtMs: this._currentVideoStartedAtMs,
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
