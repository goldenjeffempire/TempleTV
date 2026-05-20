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
import type { V2ServerFrame } from "../domain/types.js";
export type FanoutRole = "writer" | "reader" | "standalone";
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
declare class BroadcastFanout {
    private role;
    private subscriber;
    private leader;
    private orchestrator;
    private frameListener;
    private channelId;
    private _commandClient;
    /** Effective instance ID for this fanout — defaults to the process-level INSTANCE_ID. */
    private _instanceId;
    /** Whether this fanout has an active Redis connection. */
    isConnected(): boolean;
    getRole(): FanoutRole;
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
    init(orchestrator: FanoutOrchestrator, opts?: {
        commandClient?: Redis;
        subscriberClient?: Redis;
        instanceId?: string;
    }): Promise<void>;
    /** Gracefully shut down the fanout (stop renewal + close subscriber). */
    close(): Promise<void>;
    private _becomeWriter;
    private _becomeReader;
    private _publish;
}
/** Exported class — primarily for test instantiation with injected clients. */
export { BroadcastFanout };
/** Module-level singleton — one fanout per process. */
export declare const broadcastFanout: BroadcastFanout;
