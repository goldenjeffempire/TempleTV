/**
 * Cross-instance SSE event bus — Redis pub/sub bridge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 * ─────────────────────────────────────────────────────────────────────────────
 * The base `liveEvents.ts` module fans out an event to all SSE clients
 * connected to the *current process*. With `numInstances: 1` (today's Render
 * deploy) that's everyone — there is no fan-out gap. The moment Render
 * scales the api service to 2+ instances, an event published on instance A
 * (e.g. an admin clicks "Start live broadcast" and the request lands on
 * instance A) only reaches SSE clients connected to instance A. Clients
 * routed to instance B would never see the broadcast-control-updated event,
 * the live status flip, the queue change, the alert, etc.
 *
 * That is why `render.yaml` line 130 documents `numInstances: 1` as
 * "intentional — SSE clients need session affinity that Render's LB doesn't
 * guarantee. Multi-instance requires Redis pub/sub fanout (REDIS_URL
 * groundwork exists but the SSE bridge is not wired yet — that's the next
 * horizontal-scale milestone)." This file IS that bridge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 * • Two Redis connections: one for PUBLISH (can serve other commands too,
 *   so it's reusable in principle), one dedicated for SUBSCRIBE (Redis
 *   protocol forbids running other commands on a connection in subscribe
 *   mode, so this MUST be a separate client). Standard pattern.
 *
 * • Single channel: `templetv:sse:v1`. Every published frame is a small
 *   JSON envelope containing instanceId / event / data / ts / seq. The
 *   schema is versioned in the channel name so a future v2 (e.g. binary
 *   framing, MessagePack, or per-event channels) can roll out without
 *   confusing v1 instances mid-deploy.
 *
 * • Loop prevention: every instance has a unique `instanceId` (RENDER_INSTANCE_ID
 *   when on Render, otherwise a stable random UUID generated at boot). Inbound
 *   frames whose `from === instanceId` are dropped — the local fanout already
 *   delivered the event before publishing, so receiving the echo would
 *   double-send to local clients.
 *
 * • Local fanout always wins: `broadcastLiveEvent()` in `liveEvents.ts`
 *   delivers to local clients FIRST, then notifies the bus. If the bus is
 *   down (Redis unreachable, in reconnect, never started) local delivery
 *   is unaffected. The bus is best-effort and degrades to single-instance
 *   behavior on any failure mode.
 *
 * • Two events stay LOCAL-ONLY (never published to the bus):
 *     - `heartbeat` — emitted by the SSE heartbeat timer every 20s with
 *       per-instance client count. Cross-instance fan-out would just have
 *       every other instance receiving a heartbeat carrying the wrong
 *       client count.
 *     - `stream-health` — 1 Hz per-instance pipeline-health snapshot.
 *       Publishing 1 message/sec/instance to Redis (so it can fanout to
 *       instance-N's clients with a snapshot of instance-1's pipeline)
 *       wastes channel bandwidth and is semantically wrong — the snapshot
 *       describes the publishing instance's pipeline, not a global view.
 *   Publishers send these via `broadcastLiveEventLocal()` instead.
 *
 * • Lifecycle: `startLiveEventsBus()` is called from `index.ts:startApiSchedulers`
 *   AFTER the HTTP server is listening but BEFORE `markReady()` flips
 *   `/healthz` to 200. If `REDIS_URL` is unset, the function is a no-op and
 *   the bus stays disabled — `liveEvents.ts` continues to behave exactly as
 *   it did before this file existed. `stopLiveEventsBus()` is called from
 *   the graceful-shutdown path BEFORE `closeAllSSEClients()` so we stop
 *   accepting cross-instance frames before tearing the local fanout down.
 *
 * • Reconnect: node-redis's built-in reconnect strategy is enabled with a
 *   capped exponential backoff (250 ms → 30 s, jittered). Each reconnect
 *   bumps `stats.reconnects` so ops can spot a flapping endpoint. Inbound
 *   subscribe is automatically re-armed by node-redis on reconnect.
 *
 * • Telemetry: `getBusStatsSnapshot()` exposes counters readable from
 *   `/api/admin/...` for Mission Control. Cheap atomic counters, no I/O.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NON-GOALS (deliberately out of scope for this milestone)
 * ─────────────────────────────────────────────────────────────────────────────
 * • Persistence / replay. SSE is fire-and-forget by design — a client that
 *   reconnects relies on the existing GET endpoints to hydrate state, not
 *   on Redis to replay missed events. No Redis Streams here.
 * • Per-event topic routing. All events go through one channel; instances
 *   that don't care about a given event drop it locally (current local
 *   fanout already handles this — there's no per-event subscription layer
 *   in `liveEvents.ts` to optimise away).
 * • Cluster / Sentinel topology. node-redis handles single-endpoint Redis
 *   (the standard managed-Redis offering on Render / Upstash / Aiven).
 *   Cluster support can be added later by switching the createClient call
 *   if/when we move to a clustered backend.
 */

import { createClient, type RedisClientType } from "redis";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { localBroadcastLiveEvent, setBusPublishHook } from "./liveEvents";

const CHANNEL = process.env.SSE_FANOUT_CHANNEL ?? "templetv:sse:v1";
const INSTANCE_ID =
  process.env.RENDER_INSTANCE_ID?.trim() ||
  process.env.HOSTNAME?.trim() ||
  randomUUID();

interface BusFrame {
  /** Originating instance id — used for loop prevention on receive. */
  from: string;
  /** SSE event name (e.g. "broadcast-current-updated"). */
  event: string;
  /** Opaque event payload — same shape as `data` in `broadcastLiveEvent(event, data)`. */
  data: unknown;
  /** Wall-clock at publish time (ms). Carried for diagnostics; not used for ordering. */
  ts: number;
  /** Per-instance monotonically increasing sequence — diagnostic aid only. */
  seq: number;
}

let publisher: RedisClientType | null = null;
let subscriber: RedisClientType | null = null;
let isStarted = false;
let publishSeq = 0;

const stats = {
  startedAt: 0,
  publishesSent: 0,
  publishesFailed: 0,
  publishesSkippedDisconnected: 0,
  framesReceived: 0,
  framesDroppedSelf: 0,
  framesDroppedMalformed: 0,
  reconnects: 0,
  lastPublishErrorAt: 0,
  lastPublishErrorMsg: "",
  lastReceiveErrorAt: 0,
  lastReceiveErrorMsg: "",
};

/**
 * Snapshot of bus state for telemetry / Mission Control.
 * Cheap to call (no I/O, no allocation beyond the returned object).
 */
export interface BusStatsSnapshot {
  enabled: boolean;
  connected: boolean;
  channel: string;
  instanceId: string;
  uptimeSec: number;
  publishesSent: number;
  publishesFailed: number;
  publishesSkippedDisconnected: number;
  framesReceived: number;
  framesDroppedSelf: number;
  framesDroppedMalformed: number;
  reconnects: number;
  lastPublishErrorAt: number;
  lastPublishErrorMsg: string;
  lastReceiveErrorAt: number;
  lastReceiveErrorMsg: string;
}

export function getBusStatsSnapshot(): BusStatsSnapshot {
  const enabled = isStarted;
  const connected =
    enabled && Boolean(publisher?.isReady) && Boolean(subscriber?.isReady);
  return {
    enabled,
    connected,
    channel: CHANNEL,
    instanceId: INSTANCE_ID,
    uptimeSec:
      stats.startedAt > 0 ? Math.floor((Date.now() - stats.startedAt) / 1000) : 0,
    publishesSent: stats.publishesSent,
    publishesFailed: stats.publishesFailed,
    publishesSkippedDisconnected: stats.publishesSkippedDisconnected,
    framesReceived: stats.framesReceived,
    framesDroppedSelf: stats.framesDroppedSelf,
    framesDroppedMalformed: stats.framesDroppedMalformed,
    reconnects: stats.reconnects,
    lastPublishErrorAt: stats.lastPublishErrorAt,
    lastPublishErrorMsg: stats.lastPublishErrorMsg,
    lastReceiveErrorAt: stats.lastReceiveErrorAt,
    lastReceiveErrorMsg: stats.lastReceiveErrorMsg,
  };
}

/**
 * Publish an event to the bus. Fire-and-forget by design — failures
 * NEVER throw to the caller (which is the `broadcastLiveEvent` hot path
 * called from request handlers). Errors are logged + counted only.
 *
 * Synchronous from the caller's perspective: kicks off the async PUBLISH
 * and returns immediately. The publish promise is `void`-discarded after
 * an error handler attached to it.
 */
function publishToBus(event: string, data: unknown): void {
  if (!publisher) return;
  if (!publisher.isReady) {
    stats.publishesSkippedDisconnected++;
    return;
  }
  const frame: BusFrame = {
    from: INSTANCE_ID,
    event,
    data,
    ts: Date.now(),
    seq: ++publishSeq,
  };
  let payload: string;
  try {
    payload = JSON.stringify(frame);
  } catch (err) {
    // Non-serialisable payload (e.g. a circular reference) — log and drop.
    // This is a producer bug; counting separately so it surfaces in stats.
    stats.publishesFailed++;
    stats.lastPublishErrorAt = Date.now();
    stats.lastPublishErrorMsg = `serialize: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(
      { event, err: stats.lastPublishErrorMsg },
      "[liveEventsBus] failed to serialise frame; event delivered locally only",
    );
    return;
  }

  publisher
    .publish(CHANNEL, payload)
    .then(() => {
      stats.publishesSent++;
    })
    .catch((err: unknown) => {
      stats.publishesFailed++;
      stats.lastPublishErrorAt = Date.now();
      stats.lastPublishErrorMsg = err instanceof Error ? err.message : String(err);
      // Don't log every failure — under sustained Redis outage that would
      // flood logs at the broadcast rate. Log at most once every 30 s by
      // keying off the timestamp-rounded-to-30s.
      const bucketKey = Math.floor(Date.now() / 30_000);
      if (bucketKey !== lastPublishLogBucket) {
        lastPublishLogBucket = bucketKey;
        logger.warn(
          { err: stats.lastPublishErrorMsg, channel: CHANNEL },
          "[liveEventsBus] publish failed (rate-limited log; see stats for full count)",
        );
      }
    });
}
let lastPublishLogBucket = 0;

/**
 * Handle an inbound message from the channel.
 *
 * Three guard conditions, in order:
 *   1. Parse the envelope. Garbage in (non-JSON, missing required fields)
 *      → drop + count, never throw. A misbehaving publisher elsewhere on
 *      the channel must not be able to crash this instance's subscribe loop.
 *   2. Loop prevention. If `from === INSTANCE_ID`, this is our own echo
 *      and the local fanout already delivered the event — drop.
 *   3. Deliver to local SSE clients via `localBroadcastLiveEvent`. This is
 *      the SAME function `broadcastLiveEvent` calls for the local hop, so
 *      remote-originated events go through the same backpressure / capacity
 *      / dead-client checks as locally-originated ones.
 */
function onSubscribeMessage(payload: string): void {
  let frame: Partial<BusFrame> | null = null;
  try {
    frame = JSON.parse(payload) as Partial<BusFrame>;
  } catch {
    stats.framesDroppedMalformed++;
    return;
  }
  if (
    !frame ||
    typeof frame.from !== "string" ||
    typeof frame.event !== "string"
  ) {
    stats.framesDroppedMalformed++;
    return;
  }
  if (frame.from === INSTANCE_ID) {
    stats.framesDroppedSelf++;
    return;
  }
  stats.framesReceived++;
  try {
    localBroadcastLiveEvent(frame.event, frame.data);
  } catch (err) {
    stats.lastReceiveErrorAt = Date.now();
    stats.lastReceiveErrorMsg = err instanceof Error ? err.message : String(err);
    // Local fanout has its own try/catches per client, so reaching here is
    // unexpected — log it (rate-limited too).
    logger.warn(
      { event: frame.event, err: stats.lastReceiveErrorMsg },
      "[liveEventsBus] local delivery threw on inbound frame",
    );
  }
}

/**
 * Start the bus. No-op when REDIS_URL is unset — the bus stays disabled
 * and `broadcastLiveEvent()` continues to behave exactly as before this
 * module existed.
 *
 * Returns `true` if the bus is now active, `false` if disabled by config.
 *
 * Failure to connect on startup is NOT fatal — node-redis will retry in
 * the background, and the publisher will simply skip publishing (counted
 * via `publishesSkippedDisconnected`) until the connection settles.
 * Local delivery continues to work throughout.
 */
export async function startLiveEventsBus(): Promise<boolean> {
  if (isStarted) return true;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    logger.info(
      { instanceId: INSTANCE_ID },
      "[liveEventsBus] REDIS_URL not set — bus DISABLED, single-instance fanout only",
    );
    return false;
  }

  // Two clients: publisher (general-purpose; could be reused for other
  // commands later) and subscriber (must be exclusive to subscribe ops).
  publisher = createClient({
    url,
    name: `temple-tv-sse-pub-${INSTANCE_ID.slice(0, 8)}`,
    socket: {
      reconnectStrategy: (retries) => {
        // 250 ms → 30 s exponential, jittered. Cap retries to Infinity
        // so we never give up under a long Redis outage.
        const base = Math.min(30_000, 250 * 2 ** Math.min(retries, 8));
        return base + Math.floor(Math.random() * 250);
      },
    },
  });
  subscriber = publisher.duplicate();

  // Instrumentation BEFORE connect so we don't miss the first reconnect.
  for (const [tag, client] of [
    ["pub", publisher],
    ["sub", subscriber],
  ] as const) {
    client.on("error", (err: Error) => {
      // node-redis emits "Socket already opened" and other transient errors
      // during reconnect — log at warn, not error, to avoid alert noise.
      logger.warn({ err: err.message, tag }, `[liveEventsBus] client error (${tag})`);
    });
    client.on("reconnecting", () => {
      stats.reconnects++;
      logger.info({ tag, reconnects: stats.reconnects }, `[liveEventsBus] reconnecting (${tag})`);
    });
    client.on("ready", () => {
      logger.info({ tag, channel: CHANNEL }, `[liveEventsBus] client READY (${tag})`);
    });
  }

  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(CHANNEL, onSubscribeMessage);
  } catch (err) {
    // Connect failure on first attempt — don't keep the half-built clients
    // around; let node-redis's auto-reconnect take over from a fresh state.
    logger.error(
      { err: err instanceof Error ? err.message : String(err), url: maskRedisUrl(url) },
      "[liveEventsBus] initial connect failed — bus will retry in background",
    );
    // Intentionally NOT setting publisher/subscriber to null — node-redis
    // will keep trying. publishToBus() guards on isReady so publishes during
    // the retry window are counted as skipped, not failed.
  }

  // Wire the publish hook so `broadcastLiveEvent()` in liveEvents.ts will
  // call us for every (non-local-only) event. Doing this AFTER the connect
  // attempt means even if connect failed, the hook is in place and publishes
  // start working the moment the background reconnect succeeds.
  setBusPublishHook(publishToBus);

  stats.startedAt = Date.now();
  isStarted = true;

  logger.info(
    {
      instanceId: INSTANCE_ID,
      channel: CHANNEL,
      redisUrl: maskRedisUrl(url),
    },
    "[liveEventsBus] bus ARMED — cross-instance SSE fanout active",
  );
  return true;
}

/**
 * Stop the bus during graceful shutdown. Idempotent.
 *
 * Order matters: unhook the publish callback FIRST (so any in-flight
 * `broadcastLiveEvent` calls during shutdown don't try to publish on a
 * closing connection), then close subscribe (so we stop receiving inbound
 * frames), then close publish (so any straggling outbound frames complete
 * or fail quickly).
 *
 * Bounded by a 2 s timeout per close — if the Redis endpoint is genuinely
 * unreachable we don't want to block the 15 s overall shutdown timer.
 */
export async function stopLiveEventsBus(): Promise<void> {
  if (!isStarted) return;
  isStarted = false;

  setBusPublishHook(null);

  const closeWithTimeout = async (
    label: string,
    client: RedisClientType | null,
  ): Promise<void> => {
    if (!client) return;
    try {
      await Promise.race([
        client.quit(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch (err) {
      logger.warn(
        { tag: label, err: err instanceof Error ? err.message : String(err) },
        `[liveEventsBus] error closing ${label} (continuing shutdown)`,
      );
    }
  };

  await closeWithTimeout("sub", subscriber);
  await closeWithTimeout("pub", publisher);

  publisher = null;
  subscriber = null;

  logger.info("[liveEventsBus] bus stopped");
}

/**
 * Strip the password from `redis://user:pass@host:port` for safe logging.
 * Returns the input unchanged if it doesn't look like a URL.
 */
function maskRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username && u.username !== "default") u.username = "***";
    return u.toString();
  } catch {
    return "(unparseable)";
  }
}

/** Test-only: reset module state. NOT for production code. */
export function __resetForTests(): void {
  publisher = null;
  subscriber = null;
  isStarted = false;
  publishSeq = 0;
  stats.startedAt = 0;
  stats.publishesSent = 0;
  stats.publishesFailed = 0;
  stats.publishesSkippedDisconnected = 0;
  stats.framesReceived = 0;
  stats.framesDroppedSelf = 0;
  stats.framesDroppedMalformed = 0;
  stats.reconnects = 0;
  stats.lastPublishErrorAt = 0;
  stats.lastPublishErrorMsg = "";
  stats.lastReceiveErrorAt = 0;
  stats.lastReceiveErrorMsg = "";
  setBusPublishHook(null);
}
