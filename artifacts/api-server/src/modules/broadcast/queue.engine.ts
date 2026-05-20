import { EventEmitter } from "node:events";
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { broadcastSignal } from "../network/signal-bus.js";
import { checkpointRepo } from "../broadcast-v2/repository/checkpoint.repo.js";

const queueTable = schema.broadcastQueueTable;
const videosTable = schema.videosTable;

export interface BroadcastItem {
  id: string;
  videoId: string | null;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  /**
   * HLS master playlist URL from the transcoder. Populated via a LEFT JOIN
   * with the `managed_videos` table on `video_id`. Players should prefer
   * this over `localVideoUrl` (raw MP4) because HLS supports adaptive
   * bitrate, mid-stream joining, and proper seeking — all critical for live
   * broadcast playback.
   */
  hlsMasterUrl?: string | null;
  videoSource: string;
  /** ISO timestamp when this item starts playing in viewers' clients. */
  startsAt: string;
  /** ISO timestamp when this item ends. `startsAt + durationSecs`. */
  endsAt: string;
}

export interface BroadcastSnapshot {
  channelId: string;
  generatedAt: string;
  current: BroadcastItem | null;
  next: BroadcastItem | null;
  upcoming: BroadcastItem[];
  preloadAt: string | null;
  failoverHlsUrl: string | null;
}

export type BroadcastEvent =
  | { type: "snapshot"; data: BroadcastSnapshot }
  | { type: "preload"; data: { channelId: string; next: BroadcastItem } }
  | { type: "advance"; data: { channelId: string; current: BroadcastItem } }
  | { type: "viewer-count"; data: { channelId: string; count: number } };

/**
 * Continuous-broadcast queue engine.
 *
 * Treats `broadcast_queue` as a circular buffer of programs ordered by
 * `(is_active, sort_order)`. The engine maintains a wall-clock view of
 * which item is currently airing across all clients so that a phone
 * tuning in at second 1782 of a 30-minute sermon joins at second 1782,
 * not from the beginning.
 *
 * Zero-delay transitions:
 *   • A `preload` event is broadcast `BROADCAST_PRELOAD_LEAD_MS` before
 *     the current item ends, giving every connected client time to
 *     warm an A/B inactive video element with the next item's source.
 *   • At transition the `advance` event flips the active slot.
 *   • Both events ride the same in-process EventEmitter, which the SSE
 *     and WS gateways subscribe to.
 *
 * Self-recovery:
 *   • A 30-second watchdog interval checks whether the scheduleNext()
 *     timer chain is still alive. If the chain died (timer = null while
 *     items are queued), it restarts scheduleNext() automatically.
 *   • When the queue is empty at start, the engine polls the DB every
 *     30 seconds and auto-starts the moment items are added.
 *   • reload() restarts a stopped engine whenever the queue goes from
 *     empty → populated (e.g., after an admin adds the first video).
 *
 * Failover: any client may render the configured `failoverHlsUrl` if
 * its primary playback errors. The URL travels in every snapshot.
 */
class BroadcastEngine extends EventEmitter {
  private items: BroadcastItem[] = [];
  private cycleStartedAt = Date.now();
  private cycleDurationMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private preloadTimer: NodeJS.Timeout | null = null;
  /** Periodic watchdog — detects a dead scheduleNext() chain and restarts it. */
  private watchdogInterval: NodeJS.Timeout | null = null;
  /** Polls the DB when the queue is empty so the engine auto-starts on first add. */
  private emptyQueueRetryInterval: NodeJS.Timeout | null = null;
  /**
   * Persists cycle position to DB.
   * Raised from 10 s to 30 s — reduces idle DB writes 3× with no impact on
   * restart accuracy (v2 orchestrator owns precision state; v1 checkpoint is
   * a coarse fallback used only by the legacy overlay surfaces).
   */
  private checkpointInterval: NodeJS.Timeout | null = null;
  /** Wall-clock ms of the last emitSnapshot() call — used by the watchdog. */
  private lastSnapshotMs = Date.now();
  private viewerCount = 0;
  readonly channelId = "temple-tv-live";

  constructor() {
    super();
    // Each connected SSE client (admin panel, TV, mobile) adds one listener per
    // event type. Set a high ceiling consistent with the rest of the event buses
    // (ChannelEngine: 512, overrideBus: 1024) to silence the MaxListeners
    // warning and prevent false-positive memory-leak detection.
    this.setMaxListeners(512);
  }

  /** How long the watchdog waits before considering the engine stale. */
  private static readonly WATCHDOG_STALE_MS = 90_000;
  /** Watchdog + empty-queue retry poll interval. */
  private static readonly WATCHDOG_INTERVAL_MS = 30_000;

  async start(): Promise<void> {
    await this.reload();
    if (this.items.length === 0) {
      logger.warn(
        "broadcast queue empty — engine idle, will auto-start when items are added (checking every 30s)",
      );
      this._startEmptyQueueRetry();
      return;
    }
    this._scheduleNext();
    this._startWatchdog();
    this._startCheckpointSave();
    logger.info({ items: this.items.length }, "broadcast engine started");
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.emptyQueueRetryInterval) clearInterval(this.emptyQueueRetryInterval);
    if (this.checkpointInterval) clearInterval(this.checkpointInterval);
    this.timer = null;
    this.preloadTimer = null;
    this.watchdogInterval = null;
    this.emptyQueueRetryInterval = null;
    this.checkpointInterval = null;
  }

  /**
   * Re-read the queue from the database. Called on start, on admin
   * mutation, and on schedule failure recovery.
   *
   * Self-heal: if the engine was idle (timer = null) and the reload brings
   * in items, automatically start the schedule chain. This covers the case
   * where an admin adds the first video after the server started with an
   * empty queue.
   */
  async reload(): Promise<void> {
    const wasRunning = this.timer !== null;

    // PRESERVE CYCLE CONTINUITY: capture which item is currently airing and
    // how far into it we are BEFORE reloading the queue from the DB. After
    // building the new item list we look the same item up by ID so that the
    // wall-clock anchor (cycleStartedAt) keeps viewers at exactly the same
    // position — even if items were added, removed, or reordered around the
    // currently-playing one.
    const prevSnap = this.items.length > 0 ? this.snapshot() : null;
    const prevCurrentId = prevSnap?.current?.id ?? null;
    // Capture wall-clock time ONCE here so that prevPositionMs and the
    // later cycleStartedAt anchor both reference the same instant.
    // Using two separate Date.now() calls (one here, one after the DB
    // query) would inject the DB round-trip latency into cycleStartedAt,
    // causing a noticeable jump in playback position on every queue reload.
    const reloadNow = Date.now();
    const prevPositionMs = prevSnap?.current
      ? Math.max(0, reloadNow - new Date(prevSnap.current.startsAt).getTime())
      : 0;

    // LEFT JOIN with managed_videos so each queue item carries the
    // transcoded HLS master URL when one exists. Players prefer HLS over
    // the raw MP4 `localVideoUrl` for adaptive bitrate, mid-stream joining,
    // and reliable seeking — all critical for the live broadcast player.
    //
    // thumbnailUrl: COALESCE(NULLIF(queue.thumbnail_url,''), videos.thumbnail_url)
    //   When the queue row was added before transcoding completed its thumbnail
    //   was blank. Once the transcoder sets managed_videos.thumbnail_url, the
    //   engine picks it up on the next reload() (triggered by the dispatcher
    //   right after transcoding) without requiring a separate queue-table write.
    const rows = await db
      .select({
        id: queueTable.id,
        videoId: queueTable.videoId,
        youtubeId: queueTable.youtubeId,
        title: queueTable.title,
        thumbnailUrl: sql<string>`COALESCE(NULLIF(${queueTable.thumbnailUrl}, ''), ${videosTable.thumbnailUrl}, '')`,
        durationSecs: queueTable.durationSecs,
        localVideoUrl: queueTable.localVideoUrl,
        videoSource: queueTable.videoSource,
        isActive: queueTable.isActive,
        sortOrder: queueTable.sortOrder,
        addedAt: queueTable.addedAt,
        hlsMasterUrl: videosTable.hlsMasterUrl,
      })
      .from(queueTable)
      .leftJoin(videosTable, eq(queueTable.videoId, videosTable.id))
      .where(eq(queueTable.isActive, true))
      .orderBy(asc(queueTable.sortOrder), asc(queueTable.addedAt));

    // Use the same pre-DB-query wall-clock instant for item-cursor
    // initialisation so that all time values in this reload are coherent.
    const now = reloadNow;
    let cursor = now;
    this.items = rows.map((r) => {
      const dur = Math.max(1, r.durationSecs);
      const startsAt = new Date(cursor).toISOString();
      cursor += dur * 1000;
      const endsAt = new Date(cursor).toISOString();
      return {
        id: r.id,
        videoId: r.videoId,
        youtubeId: r.youtubeId,
        title: r.title,
        // Coerce null → "" — BroadcastItemSchema.thumbnailUrl is z.string()
        // (non-nullable) and the DB column is nullable. Passing null through
        // the engine snapshot would cause a Zod 500 on any response that
        // includes the queue item (broadcast/current, broadcast/guide, etc.).
        thumbnailUrl: r.thumbnailUrl ?? "",
        durationSecs: dur,
        localVideoUrl: r.localVideoUrl,
        hlsMasterUrl: r.hlsMasterUrl ?? null,
        videoSource: r.videoSource,
        startsAt,
        endsAt,
      };
    });
    this.cycleDurationMs = this.items.reduce((s, it) => s + it.durationSecs * 1000, 0);

    // Re-anchor the wall-clock so that the currently-playing item keeps its
    // position after any queue mutation (add / remove / reorder).
    //
    //   cycleStartedAt + offsetOfItem + prevPositionMs = now
    //   ⟹  cycleStartedAt = now − offsetOfItem − prevPositionMs
    //
    // If the playing item was removed from the queue, restart from item 0.
    // If the engine was stopped (first start, or empty → populated), restore
    // from a persisted checkpoint so the broadcast resumes at the correct
    // real-time position after a server restart.
    if (wasRunning && prevCurrentId && this.items.length > 0) {
      const sameIdx = this.items.findIndex((it) => it.id === prevCurrentId);
      if (sameIdx !== -1) {
        let offsetMs = 0;
        for (let i = 0; i < sameIdx; i++) offsetMs += this.items[i]!.durationSecs * 1000;
        // Place cycleStartedAt so the same wall-clock offset maps to the same
        // position within the same item, regardless of what changed around it.
        this.cycleStartedAt = now - offsetMs - prevPositionMs;
        logger.info(
          { prevCurrentId, sameIdx, prevPositionMs, offsetMs },
          "broadcast engine: reload preserved cycle position",
        );
      } else {
        // Previously-playing item was removed — restart cycle from now.
        this.cycleStartedAt = now;
        logger.info(
          { prevCurrentId },
          "broadcast engine: reload restarted cycle (playing item removed)",
        );
      }
    } else if (!wasRunning && this.items.length > 0) {
      // Boot case: try to restore cycle position from the persisted checkpoint.
      // Formula: cycleStartedAt = savedAtMs − offsetOfItemInCycle − positionMs
      // Using savedAtMs (the checkpoint write time) instead of now correctly
      // accounts for how long the server was offline.
      let restored = false;
      try {
        const cp = await checkpointRepo.load(this.channelId);
        if (cp?.itemId) {
          const cpIdx = this.items.findIndex((it) => it.id === cp.itemId);
          if (cpIdx !== -1) {
            let cpOffsetMs = 0;
            for (let i = 0; i < cpIdx; i++) cpOffsetMs += this.items[i]!.durationSecs * 1000;
            const anchor = cp.savedAtMs ?? now;
            this.cycleStartedAt = anchor - cpOffsetMs - cp.positionMs;
            logger.info(
              { itemId: cp.itemId, positionMs: cp.positionMs, anchor },
              "broadcast engine: restored cycle position from checkpoint after restart",
            );
            restored = true;
          }
        }
      } catch (err) {
        logger.warn({ err }, "broadcast engine: checkpoint restore failed (non-fatal)");
      }
      if (!restored) {
        this.cycleStartedAt = now;
      }
    } else {
      this.cycleStartedAt = now;
    }

    this._emitSnapshot();

    if (this.items.length > 0) {
      if (wasRunning) {
        // The old transition timers now reference a stale endsAtMs that was
        // computed against the pre-reload cycleStartedAt. Cancel them and
        // re-arm with corrected timing so the next PROGRAM_CHANGED fires at
        // the right wall-clock moment. _scheduleNext() cancels old timers.
        this._scheduleNext();
      } else {
        // Engine was stopped — start the schedule chain for the first time.
        this._scheduleNext();
        this._startWatchdog();
        this._startCheckpointSave();
        if (this.emptyQueueRetryInterval) {
          clearInterval(this.emptyQueueRetryInterval);
          this.emptyQueueRetryInterval = null;
        }
        logger.info(
          { items: this.items.length },
          "broadcast engine: auto-started after queue became non-empty",
        );
      }
    }
  }

  snapshot(): BroadcastSnapshot {
    const now = Date.now();
    let current: BroadcastItem | null = null;
    let next: BroadcastItem | null = null;
    let preloadAt: string | null = null;
    const upcoming: BroadcastItem[] = [];

    if (this.items.length > 0 && this.cycleDurationMs > 0) {
      const elapsedInCycleMs = (now - this.cycleStartedAt) % this.cycleDurationMs;
      let acc = 0;
      for (let i = 0; i < this.items.length; i++) {
        const span = this.items[i]!.durationSecs * 1000;
        if (elapsedInCycleMs < acc + span) {
          const startsAtMs = now - (elapsedInCycleMs - acc);
          const endsAtMs = startsAtMs + span;
          current = {
            ...this.items[i]!,
            startsAt: new Date(startsAtMs).toISOString(),
            endsAt: new Date(endsAtMs).toISOString(),
          };
          preloadAt = new Date(endsAtMs - env.BROADCAST_PRELOAD_LEAD_MS).toISOString();

          let cursor = endsAtMs;
          for (let k = 1; k <= Math.min(5, this.items.length - 1); k++) {
            const nIdx = (i + k) % this.items.length;
            const it = this.items[nIdx]!;
            const startsAt = new Date(cursor).toISOString();
            cursor += it.durationSecs * 1000;
            const endsAt = new Date(cursor).toISOString();
            const projected: BroadcastItem = { ...it, startsAt, endsAt };
            if (k === 1) next = projected;
            upcoming.push(projected);
          }
          break;
        }
        acc += span;
      }
    }

    // F47: When the queue is empty (current === null) and BROADCAST_FAILOVER_HLS_URL
    // is configured, synthesise a sentinel BroadcastItem that points to the
    // fallback HLS stream. Clients receive a playable item instead of null,
    // preventing a blank screen during queue gaps. Duration is 1 hour so the
    // item stays "current" until the engine is reloaded with real content.
    // This item is never persisted — it exists only in the in-memory snapshot.
    const failoverHlsUrl = env.BROADCAST_FAILOVER_HLS_URL ?? null;
    if (!current && failoverHlsUrl) {
      const FAILOVER_DURATION_MS = 60 * 60 * 1000; // 1 hour
      current = {
        id: "failover",
        videoId: null,
        youtubeId: "",
        title: "Temple TV Live",
        thumbnailUrl: "",
        durationSecs: 3600,
        localVideoUrl: null,
        hlsMasterUrl: failoverHlsUrl,
        videoSource: "hls",
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + FAILOVER_DURATION_MS).toISOString(),
      };
    }

    return {
      channelId: this.channelId,
      generatedAt: new Date(now).toISOString(),
      current,
      next,
      upcoming,
      preloadAt,
      failoverHlsUrl,
    };
  }

  setViewerCount(n: number): void {
    if (n === this.viewerCount) return;
    this.viewerCount = n;
    this.emit("event", {
      type: "viewer-count",
      data: { channelId: this.channelId, count: n },
    } satisfies BroadcastEvent);
  }

  getViewerCount(): number {
    return this.viewerCount;
  }

  /** Milliseconds since the last snapshot was emitted. Used by /health/live. */
  getLastSnapshotAgeMs(): number {
    return Date.now() - this.lastSnapshotMs;
  }

  /** True if the schedule chain is running (timer is set or items.length === 0). */
  isRunning(): boolean {
    return this.items.length === 0 || this.timer !== null;
  }

  /**
   * Push a fresh snapshot event to all subscribed SSE/WS listeners without
   * touching the schedule chain or reloading from the DB. Used by the SSE
   * gateway when the override bus signals a change so SSE clients get an
   * immediate "something changed" ping and can refetch /live/status.
   */
  pushSnapshot(): void {
    this._emitSnapshot();
  }

  /**
   * Returns internal cycle timing state for the `/admin/broadcast/continuity`
   * probe. Exposes the wall-clock anchor and derived cycle metrics so operators
   * can verify that admin queue mutations preserved the broadcast position.
   *
   * All timestamps are ISO-8601 strings; all durations are milliseconds unless
   * a `Secs` suffix indicates seconds.
   */
  getContinuityState(): {
    cycleStartedAt: string;
    cycleDurationMs: number;
    cycleElapsedMs: number;
    cycleProgressPercent: number;
    itemCount: number;
    engineRunning: boolean;
    lastSnapshotAgeMs: number;
    timerArmed: boolean;
    preloadTimerArmed: boolean;
  } {
    const now = Date.now();
    const cycleElapsedMs =
      this.cycleDurationMs > 0
        ? ((now - this.cycleStartedAt) % this.cycleDurationMs + this.cycleDurationMs) %
          this.cycleDurationMs
        : 0;
    return {
      cycleStartedAt: new Date(this.cycleStartedAt).toISOString(),
      cycleDurationMs: this.cycleDurationMs,
      cycleElapsedMs,
      cycleProgressPercent:
        this.cycleDurationMs > 0
          ? Math.round((cycleElapsedMs / this.cycleDurationMs) * 10000) / 100
          : 0,
      itemCount: this.items.length,
      engineRunning: this.isRunning(),
      lastSnapshotAgeMs: now - this.lastSnapshotMs,
      timerArmed: this.timer !== null,
      preloadTimerArmed: this.preloadTimer !== null,
    };
  }

  private _scheduleNext(): void {
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    if (this.timer) clearTimeout(this.timer);
    if (this.items.length === 0) return;

    const snap = this.snapshot();
    if (!snap.current) return;
    const endsAtMs = new Date(snap.current.endsAt).getTime();
    const msToEnd = Math.max(50, endsAtMs - Date.now());
    const msToPreload = Math.max(50, msToEnd - env.BROADCAST_PRELOAD_LEAD_MS);

    if (snap.next) {
      this.preloadTimer = setTimeout(() => {
        this.emit("event", {
          type: "preload",
          data: { channelId: this.channelId, next: snap.next! },
        } satisfies BroadcastEvent);
      }, msToPreload);
    }
    this.timer = setTimeout(() => {
      this.timer = null; // clear before re-entry so isRunning() is accurate
      const after = this.snapshot();
      if (after.current) {
        this.emit("event", {
          type: "advance",
          data: { channelId: this.channelId, current: after.current },
        } satisfies BroadcastEvent);
        // OMEGA Signal Bus: fan out PROGRAM_CHANGED to all WS/SSE clients.
        broadcastSignal("PROGRAM_CHANGED", this.channelId, {
          message: `Now airing: ${after.current.title}`,
          payload: { itemId: after.current.id, title: after.current.title },
        });
      }
      this._emitSnapshot();
      this._scheduleNext();
    }, Math.max(1, msToEnd));
  }

  private _emitSnapshot(): void {
    this.lastSnapshotMs = Date.now();
    this.emit("event", { type: "snapshot", data: this.snapshot() } satisfies BroadcastEvent);
  }

  /**
   * Self-healing watchdog. Runs every 30 s; if the schedule chain has been
   * silent for > 90 s while items are queued, it restarts _scheduleNext().
   * This guards against the (rare) case where a setTimeout callback throws
   * an uncaught error that prevents the chain from re-arming itself.
   */
  private _startWatchdog(): void {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    this.watchdogInterval = setInterval(() => {
      if (this.items.length === 0) return;
      if (this.timer !== null) return; // healthy
      const staleMs = Date.now() - this.lastSnapshotMs;
      if (staleMs > BroadcastEngine.WATCHDOG_STALE_MS) {
        logger.warn(
          { staleMs, items: this.items.length },
          "broadcast engine watchdog: schedule chain stale — restarting",
        );
        // OMEGA Signal Bus: warn all clients that the stream may be degraded.
        broadcastSignal("STREAM_FAILED", this.channelId, {
          message: "Broadcast engine stale — auto-recovering",
          payload: { staleMs },
        });
        this._scheduleNext();
        this._emitSnapshot();
      }
    }, BroadcastEngine.WATCHDOG_INTERVAL_MS);
    this.watchdogInterval.unref?.();
  }

  /**
   * Polls the DB every 30 s when the queue is empty so the engine
   * auto-starts the moment an admin adds the first video.
   */
  private _startEmptyQueueRetry(): void {
    if (this.emptyQueueRetryInterval) clearInterval(this.emptyQueueRetryInterval);
    this.emptyQueueRetryInterval = setInterval(async () => {
      if (this.items.length > 0) {
        // Already started by reload() — clean up and exit.
        clearInterval(this.emptyQueueRetryInterval!);
        this.emptyQueueRetryInterval = null;
        return;
      }
      try {
        await this.reload();
      } catch (err) {
        logger.warn({ err }, "broadcast engine: empty-queue retry reload failed");
      }
    }, BroadcastEngine.WATCHDOG_INTERVAL_MS);
    this.emptyQueueRetryInterval.unref?.();
  }

  /**
   * Starts a periodic interval that saves the current broadcast position to
   * the checkpoint table every 10 s. On server restart, reload() reads this
   * checkpoint and restores cycleStartedAt so the broadcast resumes at the
   * correct real-time position rather than jumping to item 0.
   */
  private _startCheckpointSave(): void {
    if (this.checkpointInterval) clearInterval(this.checkpointInterval);
    this.checkpointInterval = setInterval(() => {
      this._saveCheckpoint().catch((err) => {
        logger.warn({ err }, "broadcast engine: periodic checkpoint save failed (non-fatal)");
      });
    }, 30_000);
    this.checkpointInterval.unref?.();
  }

  private async _saveCheckpoint(): Promise<void> {
    if (this.items.length === 0 || this.cycleDurationMs === 0) return;
    const snap = this.snapshot();
    if (!snap.current) return;
    const positionMs = Math.max(0, Date.now() - new Date(snap.current.startsAt).getTime());
    await checkpointRepo.save({
      channelId: this.channelId,
      itemId: snap.current.id,
      positionMs,
      sourceHealth: "ok",
    });
  }

}

export const broadcastEngine = new BroadcastEngine();
