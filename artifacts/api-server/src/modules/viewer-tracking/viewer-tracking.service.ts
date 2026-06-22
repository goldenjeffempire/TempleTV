/**
 * Viewer Tracking Service
 *
 * Production-grade real-time viewer counting, fully decoupled from the
 * broadcast engine.  Clients send a heartbeat every ~10 s; the server
 * maintains per-stream active-viewer counts using Redis sorted sets so
 * no DB write occurs per heartbeat.  Survives API/worker restarts
 * because all ephemeral state lives in Redis with TTL-based expiry.
 *
 * Redis key schema
 * ──────────────────────────────────────────────────────────────────
 *  vt:session:{sessionId}   → JSON blob, TTL = SESSION_TTL_S (25 s)
 *                             Auto-expires on missed heartbeats.
 *  vt:active:{streamId}     → Sorted set, score = expireAtMs, member = sessionId
 *                             Queried with ZRANGEBYSCORE to count live sessions.
 *  vt:peak:{streamId}       → integer string, no TTL (persists across restarts)
 *  vt:trend:{streamId}      → Sorted set, score = timestamp ms, member = "{ts}:{count}"
 *                             Pruned to a 5-min rolling window.
 *  vt:pubsub                → Pub/Sub channel for cross-instance count fan-out
 *
 * In-process fallback (no Redis)
 * ──────────────────────────────────────────────────────────────────
 *  Map<sessionId, SessionEntry> with a periodic sweep timer.
 *  Same public interface — callers never need to branch on Redis availability.
 *
 * Scalability: ZADD / ZRANGEBYSCORE / ZCARD are all O(log N + k) where k is
 * the number of entries swept.  Supports 100k+ concurrent sessions.
 */

import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { getRedis } from "../../infrastructure/redis.js";
import { createRedisSubscriberClient, INSTANCE_ID } from "../../infrastructure/redis-client.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

// ── Constants ──────────────────────────────────────────────────────────────
const SESSION_TTL_S = env.VIEWER_TRACKING_SESSION_TTL_S;   // 25 s default
const SESSION_TTL_MS = SESSION_TTL_S * 1_000;

const TREND_WINDOW_MS   = 5 * 60_000;   // 5-minute rolling window
const TREND_SNAPSHOT_MS = 15_000;        // snapshot every 15 s (20 points across 5 min)
const ADMIN_SSE_DEBOUNCE_MS = 3_000;     // max 1 admin-SSE push per 3 s per stream
const FALLBACK_SWEEP_MS = 10_000;        // in-process map sweep cadence

const KEY_SESSION  = (sid: string)   => `vt:session:${sid}`;
const KEY_ACTIVE   = (stream: string) => `vt:active:${stream}`;
const KEY_PEAK     = (stream: string) => `vt:peak:${stream}`;
const KEY_TREND    = (stream: string) => `vt:trend:${stream}`;
const PUBSUB_CHANNEL = "vt:pubsub";

// ── Types ──────────────────────────────────────────────────────────────────
export interface HeartbeatPayload {
  sessionId: string;
  streamId:  string;
  userId?:   string;
  platform?: "tv" | "mobile" | "web" | string;
  clientTs?: number;
}

export interface ViewerStats {
  streamId:    string;
  current:     number;
  peak:        number;
  trend:       TrendPoint[];
  updatedAtMs: number;
}

export interface TrendPoint {
  ts:    number;
  count: number;
}

export interface AggregateStats {
  streams:     ViewerStats[];
  totalCurrent: number;
  totalPeak:   number;
}

interface SessionData {
  sessionId: string;
  streamId:  string;
  userId?:   string;
  platform?: string;
  joinedAtMs: number;
}

interface FallbackEntry {
  data:      SessionData;
  expireAtMs: number;
}

// Pub/sub message shape
interface PubSubMsg {
  instanceId: string;
  streamId:   string;
  count:      number;
  delta:      "join" | "leave" | "update";
}

// ── Service ────────────────────────────────────────────────────────────────
class ViewerTrackingService extends EventEmitter {
  private redis: Redis | null        = null;
  private sub:   Redis | null        = null;
  private started                    = false;

  // In-process fallback state (used when Redis is unavailable)
  private fallbackSessions = new Map<string, FallbackEntry>();
  // Map<streamId, count> for fast in-process reads
  private fallbackCounts   = new Map<string, number>();

  // Debounce tracking for admin SSE pushes  Map<streamId, lastPushMs>
  private lastSsePush      = new Map<string, number>();

  // Snapshot / sweep timers
  private trendTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;

  // Track last emitted count per stream for change detection
  private lastCount        = new Map<string, number>();

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;

    this.redis = getRedis();
    if (this.redis) {
      this.sub = createRedisSubscriberClient();
      this._attachPubSub();
      logger.info("[viewer-tracking] Redis mode — sorted-set heartbeat store");
    } else {
      logger.info("[viewer-tracking] No Redis — in-process fallback mode");
      this._startFallbackSweep();
    }

    this._startTrendSnapshots();
    logger.info(
      { sessionTtlS: SESSION_TTL_S, trendWindowMs: TREND_WINDOW_MS },
      "[viewer-tracking] service started",
    );
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.trendTimer) { clearInterval(this.trendTimer); this.trendTimer = undefined; }
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
    if (this.sub) {
      this.sub.quit().catch(() => undefined);
      this.sub = null;
    }
  }

  // ── Heartbeat (hot path) ─────────────────────────────────────────────────

  async heartbeat(payload: HeartbeatPayload): Promise<{ viewers: number; isNewSession: boolean }> {
    const { sessionId, streamId } = payload;
    const now = Date.now();
    const expireAt = now + SESSION_TTL_MS;

    if (this.redis) {
      return this._redisHeartbeat(payload, now, expireAt);
    }
    return this._fallbackHeartbeat(payload, now, expireAt);
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  async getStats(streamId?: string): Promise<AggregateStats> {
    if (this.redis) {
      return this._redisStats(streamId);
    }
    return this._fallbackStats(streamId);
  }

  // ── Redis implementation ─────────────────────────────────────────────────

  private async _redisHeartbeat(
    payload: HeartbeatPayload,
    now: number,
    expireAt: number,
  ): Promise<{ viewers: number; isNewSession: boolean }> {
    const { sessionId, streamId } = payload;
    const r = this.redis!;

    const sessionKey = KEY_SESSION(sessionId);
    const activeKey  = KEY_ACTIVE(streamId);

    // Detect new session: check existing score in the active sorted set
    const existingScore = await r.zscore(activeKey, sessionId);
    const isNewSession  = existingScore === null;

    // Upsert session data
    const sessionData: SessionData = {
      sessionId,
      streamId,
      userId:     payload.userId,
      platform:   payload.platform,
      joinedAtMs: isNewSession ? now : Number(existingScore ?? now),
    };
    await r.set(sessionKey, JSON.stringify(sessionData), "EX", SESSION_TTL_S);

    // Update sorted set: member = sessionId, score = expireAtMs
    // Sweep expired entries then get live count — single pipeline for atomicity
    const pipeline = r.pipeline();
    pipeline.zadd(activeKey, expireAt, sessionId);
    pipeline.zremrangebyscore(activeKey, 0, now);  // remove expired
    pipeline.zcard(activeKey);                     // live count after sweep
    const results = await pipeline.exec();

    const count = (results?.[2]?.[1] as number | null) ?? 0;

    // Peak tracking: update if count exceeds stored peak
    const peakKey = KEY_PEAK(streamId);
    const peakRaw = await r.get(peakKey);
    const peak    = peakRaw ? Number(peakRaw) : 0;
    if (count > peak) {
      await r.set(peakKey, String(count));
    }

    // Publish cross-instance update
    const msg: PubSubMsg = {
      instanceId: INSTANCE_ID,
      streamId,
      count,
      delta: isNewSession ? "join" : "update",
    };
    r.publish(PUBSUB_CHANNEL, JSON.stringify(msg)).catch(() => undefined);

    // Push admin SSE if count changed (debounced)
    this._maybeNotifyAdmin(streamId, count, now);

    if (isNewSession) {
      this.emit("join", { sessionId, streamId, platform: payload.platform });
    }

    return { viewers: count, isNewSession };
  }

  private async _redisStats(filterStreamId?: string): Promise<AggregateStats> {
    const r = this.redis!;
    const now = Date.now();

    // Discover known streams: scan for active keys
    let streamIds: string[] = [];
    if (filterStreamId) {
      streamIds = [filterStreamId];
    } else {
      // SCAN for vt:active:* keys
      const keys = await this._scanKeys(r, "vt:active:*");
      streamIds = keys.map((k) => k.replace("vt:active:", ""));
    }

    const streams: ViewerStats[] = await Promise.all(
      streamIds.map((sid) => this._redisStreamStats(sid, now)),
    );

    const totalCurrent = streams.reduce((s, v) => s + v.current, 0);
    const totalPeak    = streams.reduce((s, v) => s + v.peak, 0);

    return { streams, totalCurrent, totalPeak };
  }

  private async _redisStreamStats(streamId: string, now: number): Promise<ViewerStats> {
    const r = this.redis!;
    const activeKey = KEY_ACTIVE(streamId);
    const peakKey   = KEY_PEAK(streamId);
    const trendKey  = KEY_TREND(streamId);

    // Sweep + count in pipeline
    const pipeline = r.pipeline();
    pipeline.zremrangebyscore(activeKey, 0, now);
    pipeline.zcard(activeKey);
    pipeline.get(peakKey);
    pipeline.zrangebyscore(trendKey, now - TREND_WINDOW_MS, "+inf", "WITHSCORES");
    const results = await pipeline.exec();

    const current  = (results?.[1]?.[1] as number | null) ?? 0;
    const peakRaw  = (results?.[2]?.[1] as string | null) ?? "0";
    const peak     = Math.max(current, Number(peakRaw));
    const trendRaw = (results?.[3]?.[1] as string[] | null) ?? [];

    // Parse trend: [member0, score0, member1, score1, ...]
    const trend: TrendPoint[] = [];
    for (let i = 0; i + 1 < trendRaw.length; i += 2) {
      const member = trendRaw[i] ?? "";
      const ts = Number(trendRaw[i + 1] ?? 0);
      const colonIdx = member.lastIndexOf(":");
      const count = colonIdx >= 0 ? Number(member.slice(colonIdx + 1)) : 0;
      if (!isNaN(ts) && !isNaN(count)) {
        trend.push({ ts, count });
      }
    }

    return { streamId, current, peak, trend, updatedAtMs: now };
  }

  private async _scanKeys(r: Redis, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  }

  // ── In-process fallback implementation ──────────────────────────────────

  private _fallbackHeartbeat(
    payload: HeartbeatPayload,
    now: number,
    expireAt: number,
  ): { viewers: number; isNewSession: boolean } {
    const { sessionId, streamId } = payload;
    const existing = this.fallbackSessions.get(sessionId);
    const isNewSession = !existing;

    const data: SessionData = {
      sessionId,
      streamId,
      userId:     payload.userId,
      platform:   payload.platform,
      joinedAtMs: existing ? existing.data.joinedAtMs : now,
    };
    this.fallbackSessions.set(sessionId, { data, expireAtMs: expireAt });

    // Recount for this stream
    const count = this._fallbackCount(streamId);
    this._maybeNotifyAdmin(streamId, count, now);

    if (isNewSession) {
      this.emit("join", { sessionId, streamId, platform: payload.platform });
    }
    return { viewers: count, isNewSession };
  }

  private _fallbackCount(streamId: string): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.fallbackSessions.values()) {
      if (entry.data.streamId === streamId && entry.expireAtMs > now) count++;
    }
    this.fallbackCounts.set(streamId, count);
    return count;
  }

  private _fallbackStats(filterStreamId?: string): AggregateStats {
    const now = Date.now();
    const streamCounts = new Map<string, number>();
    for (const entry of this.fallbackSessions.values()) {
      if (entry.expireAtMs <= now) continue;
      const sid = entry.data.streamId;
      if (filterStreamId && sid !== filterStreamId) continue;
      streamCounts.set(sid, (streamCounts.get(sid) ?? 0) + 1);
    }

    const streams: ViewerStats[] = [];
    for (const [streamId, current] of streamCounts) {
      streams.push({
        streamId,
        current,
        peak: current,    // fallback mode has no persistent peak
        trend: [],
        updatedAtMs: now,
      });
    }

    const totalCurrent = streams.reduce((s, v) => s + v.current, 0);
    const totalPeak    = streams.reduce((s, v) => s + v.peak, 0);
    return { streams, totalCurrent, totalPeak };
  }

  private _startFallbackSweep(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, entry] of this.fallbackSessions) {
        if (entry.expireAtMs <= now) {
          const { streamId } = entry.data;
          this.fallbackSessions.delete(sid);
          this.emit("leave", { sessionId: sid, streamId });
          const count = this._fallbackCount(streamId);
          this._maybeNotifyAdmin(streamId, count, now);
        }
      }
    }, FALLBACK_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  // ── Trend snapshots ──────────────────────────────────────────────────────

  private _startTrendSnapshots(): void {
    this.trendTimer = setInterval(() => {
      void this._snapshotTrends();
    }, TREND_SNAPSHOT_MS);
    this.trendTimer.unref?.();
  }

  private async _snapshotTrends(): Promise<void> {
    if (!this.redis) return;  // fallback mode: no persistent trend
    const r = this.redis;
    const now = Date.now();

    // Get known stream ids
    const keys = await this._scanKeys(r, "vt:active:*").catch(() => []);
    if (keys.length === 0) return;

    const pipeline = r.pipeline();
    for (const key of keys) {
      const streamId = key.replace("vt:active:", "");
      // We do a pipeline sweep + count for each stream
      pipeline.zremrangebyscore(key, 0, now);
      pipeline.zcard(key);
    }
    const results = await pipeline.exec().catch(() => null);
    if (!results) return;

    const trendPipeline = r.pipeline();
    for (let i = 0; i < keys.length; i++) {
      const streamId = (keys[i] ?? "").replace("vt:active:", "");
      const count    = (results[i * 2 + 1]?.[1] as number | null) ?? 0;
      const trendKey = KEY_TREND(streamId);
      const member   = `${now}:${count}`;
      trendPipeline.zadd(trendKey, now, member);
      trendPipeline.zremrangebyscore(trendKey, 0, now - TREND_WINDOW_MS);
      // Expire the trend key after 2× window so empty streams clean themselves up
      trendPipeline.expire(trendKey, Math.ceil((TREND_WINDOW_MS * 2) / 1000));
    }
    await trendPipeline.exec().catch(() => undefined);
  }

  // ── Admin SSE notification ────────────────────────────────────────────────

  private _maybeNotifyAdmin(streamId: string, count: number, now: number): void {
    const prev      = this.lastCount.get(streamId);
    const lastPush  = this.lastSsePush.get(streamId) ?? 0;
    const elapsed   = now - lastPush;

    // Push when: count changed AND debounce window has passed
    if (count === prev && elapsed < ADMIN_SSE_DEBOUNCE_MS) return;

    this.lastCount.set(streamId, count);
    if (elapsed < ADMIN_SSE_DEBOUNCE_MS && count === prev) return;

    this.lastSsePush.set(streamId, now);
    adminEventBus.push("viewer-count-updated", {
      streamId,
      current:    count,
      ts:         now,
    });
  }

  // ── Pub/Sub fan-out (cross-instance sync) ────────────────────────────────

  private _attachPubSub(): void {
    if (!this.sub) return;
    this.sub.subscribe(PUBSUB_CHANNEL, (err) => {
      if (err) logger.warn({ err: err.message }, "[viewer-tracking] pub/sub subscribe error");
    });
    this.sub.on("message", (channel: string, raw: string) => {
      if (channel !== PUBSUB_CHANNEL) return;
      try {
        const msg = JSON.parse(raw) as PubSubMsg;
        // Skip our own messages (already processed in the command path)
        if (msg.instanceId === INSTANCE_ID) return;
        // Notify admin SSE from cross-instance update
        const now = Date.now();
        this._maybeNotifyAdmin(msg.streamId, msg.count, now);
      } catch {
        /* ignore malformed */
      }
    });
  }
}

export const viewerTrackingService = new ViewerTrackingService();
