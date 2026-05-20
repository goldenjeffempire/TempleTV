/**
 * Redis Pub/Sub fan-out for broadcast-v2 across API replicas.
 *
 * ## Why
 * When multiple replicas run behind a load balancer each has its own
 * independent orchestrator FSM.  Clients routed to different replicas would
 * see divergent broadcast state.  This module synchronises them through a
 * Redis Pub/Sub channel so every replica emits identical SSE/WS frames.
 *
 * ## Channel
 *   broadcast:state:{channelId}
 *
 * ## Message envelope
 *   { instanceId: string; frame: V2ServerFrame }
 *
 * ## Roles
 *   writer   — holds the Redis leader key; emits frames locally AND publishes
 *              to Redis so readers can fan them out to their own clients.
 *   reader   — does not hold the leader key; local orchestrator frame emission
 *              is suppressed; frames arrive exclusively from Redis and are
 *              injected into the local SSE/WS push path via
 *              orchestrator.injectFrame().
 *   standalone — Redis unavailable; behaves exactly like the pre-fanout
 *              single-process mode with no code-path changes.
 *
 * ## Deduplication
 * The writer also subscribes to the channel and discards messages carrying its
 * own instanceId.  This prevents a round-trip echo from double-delivering
 * frames to the writer's own SSE/WS clients.
 *
 * ## Graceful degradation
 * init() never throws.  Every Redis failure is caught and logged; on any
 * unrecoverable error the module resets to standalone mode so existing
 * single-process behaviour is preserved.
 */

import type { Redis } from "ioredis";
import { getRedis } from "../../../infrastructure/redis.js";
import {
  INSTANCE_ID,
  createRedisSubscriberClient,
} from "../../../infrastructure/redis-client.js";
import { BroadcastLeader } from "../../../infrastructure/broadcast-leader.js";
import { logger } from "../../../infrastructure/logger.js";
import type { V2ServerFrame } from "../domain/types.js";

export type FanoutRole = "writer" | "reader" | "standalone";

interface FanoutMessage {
  instanceId: string;
  frame: V2ServerFrame;
}

/**
 * Minimal interface the fanout needs from the orchestrator.
 * Using a structural type lets tests inject simple mock objects.
 */
export interface FanoutOrchestrator {
  readonly channelId: string;
  setSuppressLocalEmit(val: boolean): void;
  injectFrame(frame: V2ServerFrame): void;
  on(event: "frame", listener: (frame: V2ServerFrame) => void): this;
  off(event: "frame", listener: (frame: V2ServerFrame) => void): this;
}

const PUBSUB_CHANNEL_PREFIX = "broadcast:state:";

class BroadcastFanout {
  private role: FanoutRole = "standalone";
  private subscriber: Redis | null = null;
  private leader: BroadcastLeader | null = null;
  private orchestrator: FanoutOrchestrator | null = null;
  private frameListener: ((frame: V2ServerFrame) => void) | null = null;
  private channelId = "main";
  private _commandClient: Redis | null = null;
  /** Effective instance ID for this fanout — defaults to the process-level INSTANCE_ID. */
  private _instanceId: string = INSTANCE_ID;

  /** Whether this fanout has an active Redis connection. */
  isConnected(): boolean {
    return this.role !== "standalone";
  }

  getRole(): FanoutRole {
    return this.role;
  }

  /**
   * Initialise the fan-out for `orchestrator`.
   *
   * @param orchestrator  The local broadcast orchestrator instance.
   * @param opts          Optional overrides — primarily for test injection.
   *   commandClient    — Redis connection for commands (SET/GET/PUBLISH).
   *                      Defaults to the process-level getRedis() singleton.
   *   subscriberClient — Dedicated Redis connection for SUBSCRIBE mode.
   *                      Defaults to createRedisSubscriberClient().
   *   instanceId       — Override the process-level INSTANCE_ID. Used in
   *                      tests where multiple fanout instances run in the
   *                      same process and need distinct identities.
   */
  async init(
    orchestrator: FanoutOrchestrator,
    opts?: { commandClient?: Redis; subscriberClient?: Redis; instanceId?: string },
  ): Promise<void> {
    this.orchestrator = orchestrator;
    this.channelId = orchestrator.channelId;

    const effectiveInstanceId = opts?.instanceId ?? INSTANCE_ID;

    const commandClient = opts?.commandClient ?? getRedis();
    if (!commandClient) {
      logger.info("[broadcast-v2] Redis unavailable — single-process mode");
      this.role = "standalone";
      return;
    }
    this._commandClient = commandClient;
    this._instanceId = effectiveInstanceId;

    // ── Leader election ──────────────────────────────────────────────────
    this.leader = new BroadcastLeader(commandClient, this.channelId, effectiveInstanceId);
    let isLeader: boolean;
    try {
      isLeader = await this.leader.tryAcquire();
    } catch (err) {
      logger.warn({ err }, "[broadcast-v2] leader election failed — standalone fallback");
      this.role = "standalone";
      return;
    }

    // Set initial role before attaching subscriber so the leader listener
    // is registered before any incoming messages could arrive.
    if (isLeader) {
      this._becomeWriter(orchestrator);
    } else {
      this._becomeReader(orchestrator);
    }

    // Leadership-loss callback — switches from writer → reader.
    this.leader.onLeadershipLost(() => {
      logger.warn("[broadcast-v2] leadership lost — switching to reader mode");
      if (this.orchestrator) this._becomeReader(this.orchestrator);
    });

    // ── Subscribe (all replicas, including writer for deduplication) ─────
    const subscriberClient = opts?.subscriberClient ?? createRedisSubscriberClient();
    if (!subscriberClient) {
      logger.warn("[broadcast-v2] could not create subscriber client — standalone fallback");
      this.role = "standalone";
      orchestrator.setSuppressLocalEmit(false);
      this.leader.stopRenewal();
      return;
    }
    this.subscriber = subscriberClient;

    const pubsubChannel = `${PUBSUB_CHANNEL_PREFIX}${this.channelId}`;
    try {
      await this.subscriber.subscribe(pubsubChannel);
    } catch (err) {
      logger.warn({ err }, "[broadcast-v2] subscribe failed — standalone fallback");
      this.role = "standalone";
      orchestrator.setSuppressLocalEmit(false);
      this.leader.stopRenewal();
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
      return;
    }

    this.subscriber.on("message", (ch: string, data: string) => {
      if (ch !== pubsubChannel) return;
      try {
        const msg = JSON.parse(data) as FanoutMessage;
        // Discard own messages to prevent double-delivery on the writer.
        if (msg.instanceId === this._instanceId) return;
        this.orchestrator?.injectFrame(msg.frame);
      } catch {
        // ignore malformed messages
      }
    });

    this.leader.startRenewal();

    logger.info(
      { role: this.role, instanceId: INSTANCE_ID, channel: pubsubChannel },
      "[broadcast-v2] fanout initialized",
    );
  }

  /** Gracefully shut down the fanout (stop renewal + close subscriber). */
  async close(): Promise<void> {
    this.leader?.stopRenewal();
    if (this.orchestrator && this.frameListener) {
      this.orchestrator.off("frame", this.frameListener);
      this.frameListener = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
    this.role = "standalone";
    this.orchestrator?.setSuppressLocalEmit(false);
  }

  // ── Private role transitions ─────────────────────────────────────────────

  private _becomeWriter(orchestrator: FanoutOrchestrator): void {
    // Remove any reader-mode suppression so local ticks reach SSE/WS clients.
    orchestrator.setSuppressLocalEmit(false);
    this.role = "writer";

    // Detach any old listener before attaching a fresh one (idempotent).
    if (this.frameListener) {
      orchestrator.off("frame", this.frameListener);
    }

    // Mirror every locally-emitted frame to Redis so reader replicas can
    // deliver them to their own SSE/WS clients.
    this.frameListener = (frame: V2ServerFrame) => {
      void this._publish(frame);
    };
    orchestrator.on("frame", this.frameListener);
  }

  private _becomeReader(orchestrator: FanoutOrchestrator): void {
    // Suppress local tick emissions — frames arrive from Redis instead.
    orchestrator.setSuppressLocalEmit(true);
    this.role = "reader";

    // Reader never publishes, so detach the writer's publish listener.
    if (this.frameListener) {
      orchestrator.off("frame", this.frameListener);
      this.frameListener = null;
    }
  }

  private async _publish(frame: V2ServerFrame): Promise<void> {
    const client = this._commandClient;
    if (!client) return;
    try {
      const msg: FanoutMessage = { instanceId: this._instanceId, frame };
      await client.publish(
        `${PUBSUB_CHANNEL_PREFIX}${this.channelId}`,
        JSON.stringify(msg),
      );
    } catch (err) {
      logger.warn({ err }, "[broadcast-v2] fanout publish error");
    }
  }
}

/** Exported class — primarily for test instantiation with injected clients. */
export { BroadcastFanout };

/** Module-level singleton — one fanout per process. */
export const broadcastFanout = new BroadcastFanout();
