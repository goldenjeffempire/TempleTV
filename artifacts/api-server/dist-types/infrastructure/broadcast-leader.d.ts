/**
 * Lightweight Redis-based leader election for the broadcast-v2 orchestrator.
 *
 * ## Algorithm
 *   SETNX broadcast:leader:{channel} {instanceId}
 *   (followed by EXPIRE to set the TTL on success)
 *
 * The instance that wins SETNX becomes the "writer" for the channel.
 * It renews the TTL every 10 s via GET + EXPIRE (CAS check so we only extend
 * a key we still own).  Any replica that cannot acquire the key is a "reader"
 * and consumes state via Redis Pub/Sub instead.
 *
 * Note: SETNX + EXPIRE is not fully atomic (there is a tiny window between
 * the two calls).  For leader election this is acceptable: the worst case is
 * a key without a TTL that persists until the next renewal tick (10 s) sets
 * the expiry.  The SETNX gate itself IS atomic so no two replicas can both
 * win the lock.
 *
 * ## Failure modes
 *   - Writer crashes: TTL expires in ≤15 s, next renewal tick on a reader
 *     calls tryAcquire() and wins, promoting itself to writer.
 *     Max visible gap: 1 broadcast tick (2 s) after the new writer is elected.
 *   - Redis unavailable: isWriter() returns true on every replica (single-
 *     process fallback).  No fan-out occurs; each replica serves its own
 *     local clients normally.
 *
 * ## Public API
 *   new BroadcastLeader(redis, channelId, instanceId)
 *   .tryAcquire()        → Promise<boolean>  attempt SETNX
 *   .isWriter()          → boolean           current leadership state
 *   .onLeadershipLost(cb)                    register loss callback
 *   .startRenewal()                          start 10 s renewal timer
 *   .stopRenewal()                           cancel renewal timer
 */
import type { Redis } from "ioredis";
export declare class BroadcastLeader {
    private readonly redis;
    private readonly instanceId;
    private readonly leaderKey;
    private _isWriter;
    private renewalTimer;
    private readonly lostCallbacks;
    constructor(redis: Redis, channelId: string, instanceId: string);
    /**
     * Attempt to acquire the leader lock.
     *
     * SETNX is atomic: exactly one caller wins even across multiple processes.
     * On success we immediately set the TTL so the key expires if this process
     * crashes before the first renewal.
     *
     * If SETNX fails but the key already holds our instanceId (possible after a
     * fast restart that reused the same INSTANCE_ID) we treat that as a win.
     */
    tryAcquire(): Promise<boolean>;
    /** Current leadership state. */
    isWriter(): boolean;
    /**
     * Register a callback invoked when this instance loses the leader lock.
     * Callbacks run synchronously inside the renewal timer tick.
     */
    onLeadershipLost(cb: () => void): void;
    /**
     * Start the 10 s renewal timer.
     *
     * Writer: refreshes the TTL if the key still belongs to us.
     * Reader: attempts to acquire the lock (promotes if the writer is gone).
     */
    startRenewal(): void;
    stopRenewal(): void;
    private renew;
}
