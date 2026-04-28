import { EventEmitter } from "node:events";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

const queueTable = schema.broadcastQueueTable;

export interface BroadcastItem {
  id: string;
  videoId: string | null;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
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
 * Failover: any client may render the configured `failoverHlsUrl` if
 * its primary playback errors. The URL travels in every snapshot.
 */
class BroadcastEngine extends EventEmitter {
  private items: BroadcastItem[] = [];
  private currentIndex = 0;
  private cycleStartedAt = Date.now();
  private cycleDurationMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private preloadTimer: NodeJS.Timeout | null = null;
  private viewerCount = 0;
  readonly channelId = "temple-tv-live";

  async start(): Promise<void> {
    await this.reload();
    if (this.items.length === 0) {
      logger.warn("broadcast queue empty — engine idle until items are added");
      return;
    }
    this.scheduleNext();
    logger.info({ items: this.items.length }, "broadcast engine started");
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    this.timer = null;
    this.preloadTimer = null;
  }

  /**
   * Re-read the queue from the database. Called on start, on admin
   * mutation, and on schedule failure recovery.
   */
  async reload(): Promise<void> {
    const rows = await db
      .select()
      .from(queueTable)
      .where(eq(queueTable.isActive, true))
      .orderBy(asc(queueTable.sortOrder), asc(queueTable.addedAt));

    const now = Date.now();
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
        thumbnailUrl: r.thumbnailUrl,
        durationSecs: dur,
        localVideoUrl: r.localVideoUrl,
        videoSource: r.videoSource,
        startsAt,
        endsAt,
      };
    });
    this.cycleStartedAt = now;
    this.cycleDurationMs = this.items.reduce((s, it) => s + it.durationSecs * 1000, 0);
    this.currentIndex = 0;
    this.emitSnapshot();
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

    return {
      channelId: this.channelId,
      generatedAt: new Date(now).toISOString(),
      current,
      next,
      upcoming,
      preloadAt,
      failoverHlsUrl: env.BROADCAST_FAILOVER_HLS_URL ?? null,
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

  private scheduleNext(): void {
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
      const after = this.snapshot();
      if (after.current) {
        this.emit("event", {
          type: "advance",
          data: { channelId: this.channelId, current: after.current },
        } satisfies BroadcastEvent);
      }
      this.emitSnapshot();
      this.scheduleNext();
    }, msToEnd + 10);
  }

  private emitSnapshot(): void {
    this.emit("event", { type: "snapshot", data: this.snapshot() } satisfies BroadcastEvent);
  }
}

export const broadcastEngine = new BroadcastEngine();
