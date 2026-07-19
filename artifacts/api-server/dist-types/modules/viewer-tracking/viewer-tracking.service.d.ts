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
export interface HeartbeatPayload {
    sessionId: string;
    streamId: string;
    userId?: string;
    platform?: "tv" | "mobile" | "web" | string;
    clientTs?: number;
}
export interface ViewerStats {
    streamId: string;
    current: number;
    peak: number;
    trend: TrendPoint[];
    updatedAtMs: number;
}
export interface TrendPoint {
    ts: number;
    count: number;
}
export interface AggregateStats {
    streams: ViewerStats[];
    totalCurrent: number;
    totalPeak: number;
}
declare class ViewerTrackingService extends EventEmitter {
    private redis;
    private sub;
    private started;
    private fallbackSessions;
    private fallbackCounts;
    private lastSsePush;
    private trendTimer?;
    private sweepTimer?;
    private lastCount;
    start(): void;
    stop(): void;
    heartbeat(payload: HeartbeatPayload): Promise<{
        viewers: number;
        isNewSession: boolean;
    }>;
    getStats(streamId?: string): Promise<AggregateStats>;
    leave(sessionId: string, streamId: string): Promise<void>;
    private _redisHeartbeat;
    private _redisStats;
    private _redisStreamStats;
    private _scanKeys;
    private _fallbackHeartbeat;
    private _fallbackCount;
    private _fallbackStats;
    private _startFallbackSweep;
    private _startTrendSnapshots;
    private _snapshotTrends;
    private _maybeNotifyAdmin;
    private _attachPubSub;
}
export declare const viewerTrackingService: ViewerTrackingService;
export {};
