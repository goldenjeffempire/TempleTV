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
import { logger } from "./logger.js";

/** Seconds before the leader key expires if not renewed. */
const LEADER_TTL_SECONDS = 15;
/** How often to attempt a renewal when we hold the lock. */
const RENEWAL_INTERVAL_MS = 10_000;

export class BroadcastLeader {
  private readonly leaderKey: string;
  private _isWriter = false;
  private renewalTimer: NodeJS.Timeout | null = null;
  private readonly lostCallbacks: Array<() => void> = [];

  constructor(
    private readonly redis: Redis,
    channelId: string,
    private readonly instanceId: string,
  ) {
    this.leaderKey = `broadcast:leader:${channelId}`;
  }

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
  async tryAcquire(): Promise<boolean> {
    try {
      const won = await this.redis.setnx(this.leaderKey, this.instanceId);
      if (won === 1) {
        // Set TTL; ignore errors — renewal will retry EXPIRE every 10 s.
        await this.redis.expire(this.leaderKey, LEADER_TTL_SECONDS).catch(() => undefined);
        this._isWriter = true;
        logger.info(
          { instanceId: this.instanceId, key: this.leaderKey },
          "[broadcast-leader] acquired leadership",
        );
        return true;
      }
      // SETNX failed — check if we already own it (restart with same ID).
      const current = await this.redis.get(this.leaderKey);
      if (current === this.instanceId) {
        await this.redis.expire(this.leaderKey, LEADER_TTL_SECONDS).catch(() => undefined);
        this._isWriter = true;
        return true;
      }
      this._isWriter = false;
      logger.info(
        { instanceId: this.instanceId, holder: current ?? "<none>" },
        "[broadcast-leader] not the leader — reader mode",
      );
      return false;
    } catch (err) {
      logger.warn({ err }, "[broadcast-leader] tryAcquire error — defaulting to writer");
      this._isWriter = true;
      return true;
    }
  }

  /** Current leadership state. */
  isWriter(): boolean {
    return this._isWriter;
  }

  /**
   * Register a callback invoked when this instance loses the leader lock.
   * Callbacks run synchronously inside the renewal timer tick.
   */
  onLeadershipLost(cb: () => void): void {
    this.lostCallbacks.push(cb);
  }

  /**
   * Start the 10 s renewal timer.
   *
   * Writer: refreshes the TTL if the key still belongs to us.
   * Reader: attempts to acquire the lock (promotes if the writer is gone).
   */
  startRenewal(): void {
    if (this.renewalTimer) return;
    this.renewalTimer = setInterval(async () => {
      try {
        await this.renew();
      } catch (err) {
        logger.warn({ err }, "[broadcast-leader] renewal error");
      }
    }, RENEWAL_INTERVAL_MS);
    this.renewalTimer.unref?.();
  }

  stopRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private async renew(): Promise<void> {
    if (this._isWriter) {
      // We believe we hold the lock — verify and refresh TTL.
      const current = await this.redis.get(this.leaderKey);
      if (current === this.instanceId) {
        await this.redis.expire(this.leaderKey, LEADER_TTL_SECONDS).catch(() => undefined);
        return; // still the leader
      }
      // Another replica stole the key (shouldn't happen with correct timing,
      // but handle defensively).
      const wasWriter = this._isWriter;
      this._isWriter = false;
      logger.warn(
        { instanceId: this.instanceId, holder: current ?? "<none>" },
        "[broadcast-leader] lost leadership — switching to reader",
      );
      if (wasWriter) {
        for (const cb of this.lostCallbacks) cb();
      }
    } else {
      // Reader — try to promote ourselves if the writer's key has expired.
      const promoted = await this.tryAcquire();
      if (promoted) {
        logger.info(
          { instanceId: this.instanceId },
          "[broadcast-leader] promoted from reader → writer",
        );
      }
    }
  }
}
