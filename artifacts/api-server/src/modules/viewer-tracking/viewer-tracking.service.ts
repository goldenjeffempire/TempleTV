import { EventEmitter } from "node:events";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { ViewerPresenceStore } from "./viewer-presence.store.js";

export interface HeartbeatPayload {
  sessionId: string;
  streamId: string;
  platform?: string;
  sequence?: number;
}
export interface TrendPoint { ts: number; count: number }
export interface ViewerStats {
  streamId: string; current: number; peak: number; trend: TrendPoint[]; updatedAtMs: number;
}
export interface AggregateStats { streams: ViewerStats[]; totalCurrent: number; totalPeak: number; activeAppUsers: number }

/**
 * Every API/daemon instance reads the same PostgreSQL leases. Fixed-cost
 * two-second reconciliation restores state after restart, publishes expiry
 * (including zero) and repairs missed realtime events. Burst refreshes are
 * coalesced; heartbeat traffic doesn't each perform a global count/SCAN.
 */
export class ViewerTrackingService extends EventEmitter {
  private started = false;
  private timer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private dirty = false;
  private healthy = false;
  private stats: AggregateStats = { streams: [], totalCurrent: 0, totalPeak: 0, activeAppUsers: 0 };
  private trends = new Map<string, TrendPoint[]>();
  private lastPrune = 0;
  constructor(private readonly store = new ViewerPresenceStore(undefined, env.VIEWER_TRACKING_SESSION_TTL_S)) {
    super();
    // Every playback socket subscribes to availability. Cleanup removes each
    // listener; legitimate concurrency is not bounded by EventEmitter's 10.
    this.setMaxListeners(0);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => logger.warn({ err }, "[viewer-tracking] reconciliation unavailable"));
    }, 2000);
    this.timer.unref();
    // Arm retries BEFORE initial I/O. A temporary startup database failure
    // must not permanently disable expiry/restart reconciliation.
    await this.refresh();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.timer = this.refreshTimer = undefined;
  }

  async issueCredential(userId?: string, resumeSessionId?: string): Promise<string> {
    return this.store.issue(userId, resumeSessionId);
  }

  async nextSequence(sessionId: string): Promise<number> {
    return this.store.nextSequence(sessionId);
  }

  currentCount(streamId = broadcastEngine.channelId): number | null {
    const stream = this.stats.streams.find(s => s.streamId === streamId);
    return this.healthy && stream && Date.now() - stream.updatedAtMs <= 5000 ? stream.current : null;
  }

  async heartbeat(payload: HeartbeatPayload): Promise<{ viewers: number; isNewSession: boolean }> {
    const result = await this.store.record(payload.sessionId, payload.streamId,
      payload.sequence ?? Date.now() * 1000, true, payload.platform);
    if (result.changed) this.scheduleRefresh();
    // This response is an acknowledgement; realtime/stat snapshots carry the
    // authoritative count. No global aggregation for each individual heartbeat.
    return { viewers: this.stats.streams.find(s => s.streamId === payload.streamId)?.current ?? 0, isNewSession: result.isNewSession };
  }

  async leave(sessionId: string, streamId: string, sequence?: number): Promise<void> {
    await this.store.record(sessionId, streamId, sequence ?? Date.now() * 1000, false);
    this.scheduleRefresh();
  }

  async appHeartbeat(sessionId: string, sequence: number, active: boolean): Promise<void> {
    await this.store.recordApp(sessionId, sequence, active);
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    this.dirty = true;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch((err) => logger.warn({ err }, "[viewer-tracking] refresh unavailable"));
    }, 250);
    this.refreshTimer.unref();
  }

  async getStats(streamId?: string): Promise<AggregateStats> {
    // Bounded freshness and single-flight even with many simultaneous readers.
    if (!this.healthy || this.dirty || Date.now() - (this.stats.streams[0]?.updatedAtMs ?? 0) > 2000) await this.refresh();
    const streams = this.stats.streams.filter(s => !streamId || s.streamId === streamId);
    return {
      streams,
      totalCurrent: streams.reduce((n, s) => n + s.current, 0),
      totalPeak: streams.reduce((n, s) => n + s.peak, 0),
      activeAppUsers: this.stats.activeAppUsers,
    };
  }

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.dirty = false;
    this.refreshing = this.reconcile().catch((err) => {
      this.healthy = false;
      this.emit("unavailable");
      adminEventBus.push("viewer-count-updated", { unavailable: true, ts: Date.now() });
      throw err;
    }).finally(() => {
      this.refreshing = undefined;
      if (this.dirty) this.scheduleRefresh();
    });
    return this.refreshing;
  }

  private async reconcile(): Promise<void> {
    const rows = await this.store.counts();
    const activeAppUsers = await this.store.appCount();
    const now = Date.now();
    if (!rows.some(s => s.streamId === broadcastEngine.channelId)) {
      rows.push({ streamId: broadcastEngine.channelId, current: 0, peak: 0 });
    }
    const streams = rows.map(row => {
      const trend = (this.trends.get(row.streamId) ?? []).filter(p => p.ts > now - 300_000);
      if (!trend.length || now - trend[trend.length - 1]!.ts >= 15_000) trend.push({ ts: now, count: row.current });
      this.trends.set(row.streamId, trend);
      return { ...row, trend, updatedAtMs: now };
    });
    const previous = this.stats;
    const wasHealthy = this.healthy;
    this.stats = {
      streams,
      totalCurrent: streams.reduce((n, s) => n + s.current, 0),
      totalPeak: streams.reduce((n, s) => n + s.peak, 0),
      activeAppUsers,
    };
    this.healthy = true;
    if (!wasHealthy || previous.activeAppUsers !== activeAppUsers) {
      adminEventBus.push("viewer-count-updated", { activeAppUsers, ts: now });
    }
    for (const stream of streams) {
      const changed = previous.streams.find(s => s.streamId === stream.streamId)?.current !== stream.current;
      if (stream.streamId === broadcastEngine.channelId) broadcastEngine.setViewerCount(stream.current);
      if (changed || !wasHealthy) {
        adminEventBus.push("viewer-count-updated", { streamId: stream.streamId, current: stream.current, ts: now });
        this.emit("count", { streamId: stream.streamId, count: stream.current });
      }
    }
    if (now - this.lastPrune > 60_000) {
      this.lastPrune = now;
      void this.store.prune().catch(err => logger.warn({ err }, "[viewer-tracking] credential cleanup deferred"));
    }
  }
}

export const viewerTrackingService = new ViewerTrackingService();
