import { EventEmitter } from "node:events";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { broadcastSignal } from "../network/signal-bus.js";

const queueTable = schema.channelQueueTable;

export interface ChannelQueueItem {
  id: string;
  channelId: string;
  videoId: string | null;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  videoSource: string;
  startsAt: string;
  endsAt: string;
}

export interface ChannelSnapshot {
  channelId: string;
  generatedAt: string;
  current: ChannelQueueItem | null;
  next: ChannelQueueItem | null;
  upcoming: ChannelQueueItem[];
  preloadAt: string | null;
  failoverHlsUrl: string | null;
}

export type ChannelBroadcastEvent =
  | { type: "snapshot"; data: ChannelSnapshot }
  | { type: "preload"; data: { channelId: string; next: ChannelQueueItem } }
  | { type: "advance"; data: { channelId: string; current: ChannelQueueItem } }
  | { type: "viewer-count"; data: { channelId: string; count: number } };

const PRELOAD_LEAD_MS = 10_000;
const WATCHDOG_STALE_MS = 90_000;
const WATCHDOG_INTERVAL_MS = 30_000;

/**
 * Per-channel broadcast engine for non-primary Temple TV channels.
 * Mirrors the behavior of the primary BroadcastEngine but queries
 * `channel_queue` filtered by channelId.
 */
export class ChannelEngine extends EventEmitter {
  private items: ChannelQueueItem[] = [];
  private cycleStartedAt = Date.now();
  private cycleDurationMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private preloadTimer: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private emptyQueueRetryInterval: NodeJS.Timeout | null = null;
  private lastSnapshotMs = Date.now();
  private viewerCount = 0;

  constructor(readonly channelId: string) {
    super();
    this.setMaxListeners(512);
  }

  async start(): Promise<void> {
    await this.reload();
    if (this.items.length === 0) {
      logger.info({ channelId: this.channelId }, "channel engine: empty queue, will auto-start");
      this._startEmptyQueueRetry();
      return;
    }
    this._scheduleNext();
    this._startWatchdog();
    logger.info({ channelId: this.channelId, items: this.items.length }, "channel engine started");
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.emptyQueueRetryInterval) clearInterval(this.emptyQueueRetryInterval);
    this.timer = null;
    this.preloadTimer = null;
    this.watchdogInterval = null;
    this.emptyQueueRetryInterval = null;
  }

  async reload(): Promise<void> {
    const wasRunning = this.timer !== null;
    const prevSnap = this.items.length > 0 ? this.snapshot() : null;
    const prevCurrentId = prevSnap?.current?.id ?? null;
    const prevPositionMs = prevSnap?.current
      ? Math.max(0, Date.now() - new Date(prevSnap.current.startsAt).getTime())
      : 0;

    let rows: (typeof queueTable.$inferSelect)[];
    try {
      rows = await db
        .select()
        .from(queueTable)
        .where(eq(queueTable.channelId, this.channelId))
        .orderBy(asc(queueTable.sortOrder), asc(queueTable.addedAt));
    } catch (err) {
      logger.warn({ err, channelId: this.channelId }, "channel engine: reload DB query failed — keeping current items");
      return;
    }

    const now = Date.now();
    let cursor = now;
    this.items = rows
      .filter((r) => r.isActive)
      .map((r) => {
        const dur = Math.max(1, r.durationSecs);
        const startsAt = new Date(cursor).toISOString();
        cursor += dur * 1000;
        const endsAt = new Date(cursor).toISOString();
        return {
          id: r.id,
          channelId: r.channelId,
          videoId: r.videoId,
          youtubeId: r.youtubeId,
          title: r.title,
          thumbnailUrl: r.thumbnailUrl,
          durationSecs: dur,
          localVideoUrl: r.localVideoUrl,
          hlsMasterUrl: r.hlsMasterUrl,
          videoSource: r.videoSource,
          startsAt,
          endsAt,
        };
      });

    this.cycleDurationMs = this.items.reduce((s, it) => s + it.durationSecs * 1000, 0);

    if (wasRunning && prevCurrentId && this.items.length > 0) {
      const sameIdx = this.items.findIndex((it) => it.id === prevCurrentId);
      if (sameIdx !== -1) {
        let offsetMs = 0;
        for (let i = 0; i < sameIdx; i++) offsetMs += this.items[i]!.durationSecs * 1000;
        this.cycleStartedAt = now - offsetMs - prevPositionMs;
      } else {
        this.cycleStartedAt = now;
      }
    } else {
      this.cycleStartedAt = now;
    }

    this._emitSnapshot();

    if (this.items.length > 0) {
      this._scheduleNext();
      this._startWatchdog();
      if (this.emptyQueueRetryInterval) {
        clearInterval(this.emptyQueueRetryInterval);
        this.emptyQueueRetryInterval = null;
      }
      if (!wasRunning) {
        logger.info({ channelId: this.channelId, items: this.items.length }, "channel engine: auto-started");
      }
    }
  }

  snapshot(): ChannelSnapshot {
    const now = Date.now();
    let current: ChannelQueueItem | null = null;
    let next: ChannelQueueItem | null = null;
    let preloadAt: string | null = null;
    const upcoming: ChannelQueueItem[] = [];

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
          preloadAt = new Date(endsAtMs - PRELOAD_LEAD_MS).toISOString();
          let cursor = endsAtMs;
          for (let k = 1; k <= Math.min(5, this.items.length - 1); k++) {
            const nIdx = (i + k) % this.items.length;
            const it = this.items[nIdx]!;
            const startsAt = new Date(cursor).toISOString();
            cursor += it.durationSecs * 1000;
            const endsAt = new Date(cursor).toISOString();
            const projected: ChannelQueueItem = { ...it, startsAt, endsAt };
            if (k === 1) next = projected;
            upcoming.push(projected);
          }
          break;
        }
        acc += span;
      }
    }

    return {
      channelId: this.channelId,
      generatedAt: new Date(now).toISOString(),
      current,
      next,
      upcoming,
      preloadAt,
      failoverHlsUrl: null,
    };
  }

  setViewerCount(n: number): void {
    if (n === this.viewerCount) return;
    this.viewerCount = n;
    this.emit("event", {
      type: "viewer-count",
      data: { channelId: this.channelId, count: n },
    } satisfies ChannelBroadcastEvent);
  }

  getViewerCount(): number {
    return this.viewerCount;
  }

  isRunning(): boolean {
    return this.items.length === 0 || this.timer !== null;
  }

  pushSnapshot(): void {
    this._emitSnapshot();
  }

  private _scheduleNext(): void {
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    if (this.timer) clearTimeout(this.timer);
    if (this.items.length === 0) return;

    const snap = this.snapshot();
    if (!snap.current) return;
    const endsAtMs = new Date(snap.current.endsAt).getTime();
    const msToEnd = Math.max(50, endsAtMs - Date.now());
    const msToPreload = Math.max(50, msToEnd - PRELOAD_LEAD_MS);

    if (snap.next) {
      this.preloadTimer = setTimeout(() => {
        this.emit("event", {
          type: "preload",
          data: { channelId: this.channelId, next: snap.next! },
        } satisfies ChannelBroadcastEvent);
      }, msToPreload);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      const after = this.snapshot();
      if (after.current) {
        this.emit("event", {
          type: "advance",
          data: { channelId: this.channelId, current: after.current },
        } satisfies ChannelBroadcastEvent);
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
    this.emit("event", { type: "snapshot", data: this.snapshot() } satisfies ChannelBroadcastEvent);
  }

  private _startWatchdog(): void {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    this.watchdogInterval = setInterval(() => {
      if (this.items.length === 0 || this.timer !== null) return;
      const staleMs = Date.now() - this.lastSnapshotMs;
      if (staleMs > WATCHDOG_STALE_MS) {
        logger.warn({ channelId: this.channelId, staleMs }, "channel engine: watchdog restarting stale chain");
        this._scheduleNext();
        this._emitSnapshot();
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogInterval.unref?.();
  }

  private _startEmptyQueueRetry(): void {
    if (this.emptyQueueRetryInterval) clearInterval(this.emptyQueueRetryInterval);
    this.emptyQueueRetryInterval = setInterval(async () => {
      if (this.items.length > 0) {
        clearInterval(this.emptyQueueRetryInterval!);
        this.emptyQueueRetryInterval = null;
        return;
      }
      try {
        await this.reload();
      } catch (err) {
        logger.warn({ err, channelId: this.channelId }, "channel engine: empty-queue retry failed");
      }
    }, WATCHDOG_INTERVAL_MS);
    this.emptyQueueRetryInterval.unref?.();
  }
}
