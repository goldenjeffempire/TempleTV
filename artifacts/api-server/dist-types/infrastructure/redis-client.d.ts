/**
 * Redis client utilities for broadcast fan-out.
 *
 * Provides:
 *   - INSTANCE_ID: stable per-process identifier used for leader-election and
 *     pub/sub message deduplication.
 *   - createRedisSubscriberClient(): a dedicated ioredis connection that
 *     enters subscriber mode (SUBSCRIBE/PSUBSCRIBE).  A separate connection is
 *     required because ioredis blocks a connection from issuing regular
 *     commands once it enters subscriber mode.
 *
 * Regular command work (SET/GET/PUBLISH/SETEX) should continue to use the
 * existing getRedis() singleton from infrastructure/redis.ts so that command
 * and subscriber connections are not conflated.
 */
import { Redis } from "ioredis";
/**
 * Unique identifier for this process instance.
 *
 * Combines hostname + PID + a hi-res timestamp suffix so two replicas
 * starting at the same millisecond on the same host still get distinct IDs.
 * Used as the value stored in the Redis leader key and as the `instanceId`
 * field in pub/sub messages so each replica can recognise and discard its
 * own published frames.
 */
export declare const INSTANCE_ID: string;
/**
 * Create a brand-new ioredis connection configured for subscriber mode.
 *
 * Returns null when REDIS_URL is absent so callers can degrade gracefully.
 * The caller owns the returned connection and must call .quit() on shutdown.
 *
 * `maxRetriesPerRequest` is set to null (unlimited) so that the subscriber
 * reconnects automatically after a Redis restart without throwing on the
 * pending SUBSCRIBE command — ioredis will re-issue it on reconnect.
 */
export declare function createRedisSubscriberClient(): Redis | null;
