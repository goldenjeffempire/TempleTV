import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError } from "../../shared/errors.js";
import {
  AddQueueItemSchema,
  BroadcastCurrentResultSchema,
  ReorderQueueSchema,
  type BroadcastCurrentResultDto,
} from "./broadcast.schemas.js";
import { broadcastService } from "./broadcast.service.js";
import { broadcastEngine } from "./queue.engine.js";
import type { BroadcastEvent, BroadcastItem, BroadcastSnapshot } from "./queue.engine.js";
import { streamHealthAggregator } from "./stream-health.js";
import { requireAuth } from "../../middleware/auth.js";
import { bumpSseViewers } from "../realtime/viewer-tracker.js";
import { overrideBus } from "../live-overrides/override-bus.js";
import type { ActiveOverrideEntry } from "../live-overrides/override-bus.js";
import { signalBus, type OmegaSignal } from "../network/signal-bus.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { env } from "../../config/env.js";
import { registerNamedStore } from "../../infrastructure/cache.js";
import { db, schema } from "../../infrastructure/db.js";
import { sseCounter } from "../../infrastructure/sse-counter.js";
import { sseCorsHeaders } from "../../lib/sse-cors.js";

// Converts absolute `https://api.templetv.org.ng/api/…` URLs stored in the
// DB to relative `/api/…` paths so the client always hits the correct host
// regardless of environment (dev proxy vs production).
//
// Also converts raw S3/CDN `transcoded/{videoId}/…` URLs (written by the old
// transcoder) to the authenticated /api/hls/:videoId/… proxy path.
// The S3 bucket is private — a direct client fetch returns 403.
function toRelativeApiUrl(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  try {
    const u = new URL(raw);
    if (u.pathname.startsWith("/api/")) {
      return u.pathname + u.search;
    }
    // Convert any S3/CDN URL pointing to a transcoded HLS asset into the
    // authenticated API proxy path. Matches /transcoded/{videoId}/{rest}.
    const m = u.pathname.match(/\/transcoded\/([^/]+)\/(.+)$/);
    if (m) return `/api/hls/${m[1]}/${m[2]}`;
  } catch {
    // Already a relative path — nothing to strip.
  }
  return raw;
}

// ── Reactions event bus ──────────────────────────────────────────────────────
// Module-level EventEmitter used to fan-out live-reaction events to all
// open /broadcast/events SSE connections. A single emitter shared across
// all SSE handler closures so `POST /reaction` only needs to emit once
// and every subscriber receives it — no polling, no DB roundtrip.
const reactionBus = new EventEmitter();
reactionBus.setMaxListeners(512);

export interface LiveReactionEvent {
  type: ReactionType;
  channelId: string;
  serverTimeMs: number;
}

export type ReactionType = "amen" | "fire" | "hallelujah";

// ── Per-IP reaction rate limiter ─────────────────────────────────────────────
// Token-bucket: max 10 reactions per 10-second window per IP.
// In-memory; single-replica safe. For multi-replica, promote to Redis.
const reactionBuckets = new Map<string, { tokens: number; refillAt: number }>();
const REACTION_WINDOW_MS = 10_000;
const REACTION_TOKENS_PER_WINDOW = 10;

function consumeReactionToken(ip: string): boolean {
  const now = Date.now();
  let bucket = reactionBuckets.get(ip);
  if (!bucket || now >= bucket.refillAt) {
    bucket = { tokens: REACTION_TOKENS_PER_WINDOW, refillAt: now + REACTION_WINDOW_MS };
    reactionBuckets.set(ip, bucket);
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

// Purge stale reaction buckets every 5 minutes to prevent unbounded growth.
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, bucket] of reactionBuckets) {
      if (now >= bucket.refillAt) reactionBuckets.delete(ip);
    }
  },
  5 * 60 * 1000,
).unref?.();
registerNamedStore("broadcast-reaction-buckets", () => reactionBuckets.size);

/**
 * Project the engine's internal BroadcastSnapshot into the
 * BroadcastCurrentResult shape that mobile clients (React Native / Expo)
 * expect from GET /broadcast/current and the broadcast-current-updated SSE
 * event. These fields map to `normalizeBroadcastResult()` in
 * `artifacts/mobile/services/broadcast.ts`.
 *
 * The engine snapshot uses `current`/`next` field names and lacks derived
 * fields like `positionSecs`. The projection adds them so mobile can render
 * the cinematic hero, progress bar, and broadcast player without a separate
 * HTTP call.
 */
export function snapshotToCurrentResult(
  snap: BroadcastSnapshot,
  active: ActiveOverrideEntry | null = null,
): BroadcastCurrentResultDto {
  const now = Date.now();
  const current = snap.current;
  const next = snap.next;

  const positionSecs = current
    ? Math.max(0, (now - Date.parse(current.startsAt)) / 1000)
    : 0;
  const totalSecs = current?.durationSecs ?? 0;
  const currentItemEndsAtMs = current ? Date.parse(current.endsAt) : null;
  const itemStartEpochSecs = current ? Math.floor(Date.parse(current.startsAt) / 1000) : null;
  const queueLength = snap.upcoming.length + (current ? 1 : 0);

  const liveOverride = active
    ? {
        id: active.id,
        title: active.title,
        startedAt: active.startedAt,
        endsAt: active.endsAt,
        hlsStreamUrl: active.hlsStreamUrl,
        youtubeVideoId: active.youtubeVideoId,
      }
    : null;

  // Normalize URL fields on BroadcastItems before handing them to clients.
  // `localVideoUrl` stored in the DB may be absolute production API URLs
  // (e.g. `https://api.templetv.org.ng/api/uploads/uuid.mp4`). Converting
  // them to relative paths ensures the client hits the current host and
  // follows any redirects (e.g. to S3) correctly, regardless of environment.
  // `hlsMasterUrl` (joined from the videos table) receives the same treatment.
  function normalizeItem<T extends { localVideoUrl?: string | null; hlsMasterUrl?: string | null } | null>(
    item: T,
  ): T {
    if (!item) return item;
    return {
      ...item,
      localVideoUrl: toRelativeApiUrl(item.localVideoUrl),
      hlsMasterUrl: toRelativeApiUrl(item.hlsMasterUrl),
    };
  }

  return {
    item: normalizeItem(current ?? null),
    nextItem: normalizeItem(next ?? null),
    upcomingItems: snap.upcoming.map(normalizeItem),
    index: 0,
    positionSecs,
    totalSecs,
    queueLength,
    progressPercent: totalSecs > 0 ? Math.min(100, (positionSecs / totalSecs) * 100) : 0,
    syncedAt: snap.generatedAt,
    serverTimeMs: now,
    currentItemEndsAtMs,
    itemStartEpochSecs,
    failoverReason: null,
    failoverHlsUrl: snap.failoverHlsUrl ?? null,
    activeSchedule: null,
    liveOverride,
    ytLive: false,
    ytVideoId: null,
    ytTitle: null,
  };
}

// ── Per-IP SSE connection limiter ───────────────────────────────────────────
// Long-lived SSE connections bypass per-minute rate-limit plugins, so we
// track concurrent connections per IP and cap them independently.
// The limit is configurable via the MAX_SSE_PER_IP environment variable
// (default 8) so operators can tune it without a code change.
const MAX_SSE_PER_IP = env.MAX_SSE_PER_IP;
const sseConnections = new Map<string, number>();
registerNamedStore("broadcast-sse-connections", () => sseConnections.size);
function sseIncrement(ip: string): number {
  const n = (sseConnections.get(ip) ?? 0) + 1;
  sseConnections.set(ip, n);
  return n;
}
function sseDecrement(ip: string): void {
  const n = sseConnections.get(ip) ?? 1;
  if (n <= 1) sseConnections.delete(ip);
  else sseConnections.set(ip, n - 1);
}

// Force-close registry: populated by the SSE handler for each open connection.
// closeAllBroadcastSseSessions() is called during graceful shutdown so the
// server drain loop completes in O(ms) instead of waiting for the timeout.
const openBroadcastSseCleanups = new Set<() => void>();
export function closeAllBroadcastSseSessions(): void {
  for (const cleanup of openBroadcastSseCleanups) {
    try { cleanup(); } catch { /* ignore */ }
  }
}

export async function broadcastRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/current",
    {
      config: {
        // TV app, mobile app, and web players all poll this on reconnect.
        // 60 req/min/IP gives a polling interval of 1 s — far more than
        // any real client needs (they all use SSE for real-time updates
        // and fall back to polling on reconnect only). Prevents runaway
        // polling loops from a single device hammering the broadcast state.
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["broadcast"],
        summary: "Current channel state — what is airing now and what's next (mobile-compatible shape)",
        response: { 200: BroadcastCurrentResultSchema, 429: z.object({ error: z.string() }) },
      },
    },
    // Project to BroadcastCurrentResult so mobile clients (deployed React Native
    // / Expo apps) get `item`/`nextItem`/`positionSecs` as they expect. The TV
    // app uses /api/playback/state instead and is unaffected by this change.
    async (req, reply) => {
      reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      const snap = broadcastService.snapshot();

      // F12: cold-start DB fallback — the broadcast engine may not have finished
      // its first reload() (e.g. it threw during start() but the server still
      // started). Query the DB directly to build a synthetic snapshot so clients
      // get a real answer instead of { item: null } on every poll.
      if (!snap.current) {
        try {
          const queueTable = schema.broadcastQueueTable;
          const videosTable = schema.videosTable;
          const rows = await db
            .select({
              id: queueTable.id,
              videoId: queueTable.videoId,
              youtubeId: queueTable.youtubeId,
              title: queueTable.title,
              thumbnailUrl: queueTable.thumbnailUrl,
              durationSecs: queueTable.durationSecs,
              localVideoUrl: queueTable.localVideoUrl,
              videoSource: queueTable.videoSource,
              hlsMasterUrl: videosTable.hlsMasterUrl,
            })
            .from(queueTable)
            .leftJoin(videosTable, eq(queueTable.videoId, videosTable.id))
            .where(eq(queueTable.isActive, true))
            .orderBy(asc(queueTable.sortOrder), asc(queueTable.addedAt))
            .limit(10);

          if (rows.length > 0) {
            req.log.warn(
              { rowCount: rows.length },
              "[broadcast/current] engine cold — using DB fallback snapshot",
            );
            let cursor = Date.now();
            const items: BroadcastItem[] = rows.map((r) => {
              const dur = Math.max(1, r.durationSecs);
              const startsAt = new Date(cursor).toISOString();
              cursor += dur * 1000;
              return {
                id: r.id,
                videoId: r.videoId,
                youtubeId: r.youtubeId,
                title: r.title,
                thumbnailUrl: r.thumbnailUrl ?? "",
                durationSecs: dur,
                localVideoUrl: r.localVideoUrl,
                hlsMasterUrl: r.hlsMasterUrl ?? null,
                videoSource: r.videoSource,
                startsAt,
                endsAt: new Date(cursor).toISOString(),
              };
            });
            const dbSnap: BroadcastSnapshot = {
              channelId: snap.channelId,
              generatedAt: new Date().toISOString(),
              current: items[0] ?? null,
              next: items[1] ?? null,
              upcoming: items.slice(2),
              preloadAt: null,
              failoverHlsUrl: snap.failoverHlsUrl,
            };
            return snapshotToCurrentResult(dbSnap, overrideBus.active);
          }
        } catch (err) {
          req.log.warn({ err }, "[broadcast/current] DB cold-start fallback failed");
        }
      }

      return snapshotToCurrentResult(snap, overrideBus.active);
    },
  );

  r.get(
    "/queue",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["broadcast"],
        summary: "Admin: list every program in the queue (active + inactive)",
        security: [{ bearerAuth: [] }],
        response: { 200: z.unknown(), 429: z.object({ error: z.string() }) },
      },
    },
    async () => broadcastService.listQueue(),
  );

  r.post(
    "/queue",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Admin: append a program to the queue",
        body: AddQueueItemSchema,
        security: [{ bearerAuth: [] }],
        response: {
          201: z.unknown(),
          409: z.object({ error: z.string() }),
          422: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      // If the payload references a managed video, enforce READY-only pipeline.
      if (req.body.videoId) {
        const [video] = await db
          .select({
            id: schema.videosTable.id,
            title: schema.videosTable.title,
            transcodingStatus: schema.videosTable.transcodingStatus,
            hlsMasterUrl: schema.videosTable.hlsMasterUrl,
            videoSource: schema.videosTable.videoSource,
          })
          .from(schema.videosTable)
          .where(eq(schema.videosTable.id, req.body.videoId))
          .limit(1);
        if (video) {
          const inFlight = ["queued", "encoding", "processing"] as const;
          if (
            video.videoSource !== "youtube" &&
            inFlight.includes(video.transcodingStatus as (typeof inFlight)[number]) &&
            !video.hlsMasterUrl
          ) {
            return reply.code(422).send({
              error: `Video "${video.title}" is currently ${video.transcodingStatus} — ` +
                "wait for transcoding to complete before adding it to the broadcast queue.",
            });
          }
        }
      }
      let created;
      try {
        created = await broadcastService.addToQueue(req.body);
      } catch (err) {
        if (err instanceof ConflictError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
      reply.code(201);
      return created;
    },
  );

  r.delete(
    "/queue/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Admin: remove a program from the queue",
        params: z.object({ id: z.string().min(1).max(128) }),
        security: [{ bearerAuth: [] }],
        response: { 200: z.unknown(), 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => broadcastService.removeFromQueue(req.params.id),
  );

  r.post(
    "/queue/reorder",
    {
      preHandler: requireAuth("editor"),
      // Reorder writes to the DB on every call. 30/min lets drag-and-drop
      // save debounce freely while bounding damage from a runaway client.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Admin: reorder the active queue",
        body: ReorderQueueSchema,
        security: [{ bearerAuth: [] }],
        response: { 200: z.unknown(), 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => broadcastService.reorder(req.body.itemIds),
  );

  r.post(
    "/skip",
    {
      preHandler: requireAuth("editor"),
      // Skip advances the on-air item — a rapid burst could skip through
      // the entire queue in seconds. 10/min is ample for legitimate use.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Admin: skip the currently playing queue item and advance to the next",
        response: { 200: z.object({ ok: z.literal(true) }), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const [current] = await db
        .select({ id: schema.broadcastQueueTable.id })
        .from(schema.broadcastQueueTable)
        .where(eq(schema.broadcastQueueTable.isActive, true))
        .orderBy(asc(schema.broadcastQueueTable.sortOrder), asc(schema.broadcastQueueTable.addedAt))
        .limit(1);
      if (current) {
        await broadcastService.toggleActive(current.id, false);
        await broadcastEngine.reload();
      }
      return { ok: true as const };
    },
  );

  r.patch(
    "/queue/:id/active",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Admin: toggle whether a queue item is in rotation",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: z.object({ isActive: z.boolean() }),
        security: [{ bearerAuth: [] }],
        response: { 200: z.unknown(), 429: z.object({ error: z.string() }) },
      },
    },
    async (req) => broadcastService.toggleActive(req.params.id, req.body.isActive),
  );

  r.get(
    "/viewers",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["broadcast"],
        summary: "Live viewer count for the channel",
        response: {
          200: z.object({ channelId: z.string(), count: z.number().int().nonnegative() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      // A 3-second cache lets CDNs absorb polling bursts (many TV/mobile
      // clients checking the viewer badge simultaneously) without staling
      // the count noticeably. The true count refreshes via SSE anyway.
      reply.header("Cache-Control", "public, max-age=3, s-maxage=3, stale-while-revalidate=6, stale-if-error=60");
      return { channelId: broadcastEngine.channelId, count: broadcastEngine.getViewerCount() };
    },
  );

  // ── Guide / EPG ─────────────────────────────────────────────────────────
  // Lightweight EPG projection of the broadcast snapshot — what the TV
  // bundle's `useGuide()` and the mobile guide tab poll to populate the
  // channel guide overlay.
  //
  // Shape contract: the response MUST match `BroadcastGuideResult` in
  // `artifacts/mobile/services/broadcast.ts` so the mobile client's
  // `fetchBroadcastGuide()` can call `.items.map()` without throwing.
  // The old response used `entries` (not `items`) and omitted fields
  // (`youtubeId`, `localVideoUrl`, `hlsMasterUrl`, `videoSource`,
  // `startMs`, `endMs`, `positionSecs`, `progressPercent`) that the
  // guide tab and TV guide overlay depend on. That caused a silent
  // TypeError in `data.items.map()` which was caught and returned as
  // `null`, making the guide tab permanently empty.
  //
  // Fix: project the full `BroadcastItem` fields from the snapshot into
  // the `items` array shape. Epoch-ms `startMs`/`endMs` are derived from
  // the engine's ISO `startsAt`/`endsAt` timestamps. `positionSecs` and
  // `progressPercent` are computed live for the current item.

  const GuideItemSchema = z.object({
    id: z.string(),
    youtubeId: z.string(),
    title: z.string(),
    thumbnailUrl: z.string(),
    durationSecs: z.number().int().positive(),
    localVideoUrl: z.string().nullable(),
    hlsMasterUrl: z.string().nullable().optional(),
    videoSource: z.string(),
    startMs: z.number(),
    endMs: z.number(),
    isCurrent: z.boolean(),
    positionSecs: z.number(),
    progressPercent: z.number(),
  });
  const GuideResponseSchema = z.object({
    items: z.array(GuideItemSchema),
    liveOverride: z
      .object({ title: z.string() })
      .nullable()
      .optional(),
  });

  r.get(
    "/guide",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["broadcast"],
        summary: "Channel guide — current + upcoming programs (mobile + TV compatible)",
        response: { 200: GuideResponseSchema, 304: z.void(), 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      // Guide changes only when the broadcast engine advances to the next
      // queue item. A 5-second CDN/edge cache keeps guide tab open-rate
      // costs low without surfacing stale program info. `stale-while-
      // revalidate=10` lets clients serve the cached body instantly while
      // a background refresh happens — perceived latency → zero on repeat
      // opens.
      reply.header("Cache-Control", "public, max-age=5, s-maxage=5, stale-while-revalidate=10, stale-if-error=300");

      const snap = broadcastService.snapshot();

      // ETag based on sequence + current item id — changes only when the
      // broadcast engine advances to a new item or sequence tick. Saves body
      // transfer on CDN re-validation and client conditional-GET cycles.
      // Use a weak ETag (W/) because positionSecs + progressPercent are
      // time-derived and change on every call even for the same broadcast item.
      // ETag encodes current + next item ids — changes only when the broadcast
      // engine advances to a new item (not on every time-derived positionSecs).
      const guideEtag = `W/"g${snap.current?.id ?? "none"}-${snap.next?.id ?? "none"}"`;
      reply.header("ETag", guideEtag);
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === guideEtag) return reply.code(304).send();
      const now = Date.now();

      function projectItem(
        it: typeof snap.current,
        isCurrent: boolean,
      ): z.infer<typeof GuideItemSchema> | null {
        if (!it) return null;
        const startMs = Date.parse(it.startsAt);
        const endMs = Date.parse(it.endsAt);
        const positionSecs = isCurrent
          ? Math.max(0, (now - startMs) / 1000)
          : 0;
        const progressPercent =
          it.durationSecs > 0
            ? Math.min(100, (positionSecs / it.durationSecs) * 100)
            : 0;
        return {
          id: it.id,
          // GuideItemSchema declares youtubeId and thumbnailUrl as z.string()
          // (non-nullable). The engine snapshot inherits these from the DB
          // where both columns are nullable — coerce here as a belt-and-
          // suspenders guard (engine.reload() already coerces, but this
          // protects against any future hot-path that bypasses that fix).
          youtubeId: it.youtubeId ?? "",
          title: it.title,
          thumbnailUrl: it.thumbnailUrl ?? "",
          durationSecs: it.durationSecs,
          localVideoUrl: toRelativeApiUrl(it.localVideoUrl),
          hlsMasterUrl: toRelativeApiUrl(it.hlsMasterUrl) ?? null,
          videoSource: it.videoSource,
          startMs,
          endMs,
          isCurrent,
          positionSecs,
          progressPercent,
        };
      }

      const items: z.infer<typeof GuideItemSchema>[] = [];
      const current = projectItem(snap.current, true);
      if (current) items.push(current);
      for (const it of snap.upcoming) {
        const entry = projectItem(it, false);
        if (entry) items.push(entry);
      }

      const active = overrideBus.active;
      return {
        items,
        liveOverride: active ? { title: active.title } : null,
      };
    },
  );

  // ── Playback-quality telemetry ──────────────────────────────────────────
  // The TV's `HlsVideoPlayer` POSTs periodic playback-health samples
  // (buffer level, dropped frames, bitrate, stalls) to this endpoint.
  // We log them through the request logger — same firehose pattern as
  // `/client-errors` — and ack 202. No DB write; aggregates can be
  // computed by tailing the structured logs.

  const PlaybackTelemetrySchema = z
    .object({
      videoId: z.string().max(256).optional(),
      sessionId: z.string().max(128).optional(),
      platform: z.string().max(32).optional(),
      bufferedSecs: z.number().nonnegative().optional(),
      droppedFrames: z.number().int().nonnegative().optional(),
      bitrateKbps: z.number().nonnegative().optional(),
      stalls: z.number().int().nonnegative().optional(),
      currentTimeSecs: z.number().nonnegative().optional(),
      occurredAt: z.string().datetime().optional(),
      startupMs: z.number().nonnegative().optional(),
      event: z.string().max(64).optional(),
      errorType: z.string().max(128).optional(),
      errorDetails: z.string().max(512).optional(),
    })
    .passthrough();

  r.post(
    "/playback-telemetry",
    {
      // High-volume telemetry from TV/mobile fleet. 120/min per IP is
      // generous enough for the 5 s reporting interval while bounding
      // log-flood attacks from malicious clients.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Ingest a playback-quality sample from a TV/mobile client",
        body: PlaybackTelemetrySchema,
        response: {
          202: z.object({ ok: z.literal(true), receivedAt: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      req.log.info({ playbackTelemetry: req.body }, "[playback-telemetry]");
      // Feed the rolling in-memory aggregator so /health/live can report
      // stall rates, avg buffer level, and bitrate across the fleet.
      streamHealthAggregator.record({
        platform: req.body.platform,
        stalls: req.body.stalls,
        bufferedSecs: req.body.bufferedSecs,
        bitrateKbps: req.body.bitrateKbps,
        droppedFrames: req.body.droppedFrames,
        sessionId: req.body.sessionId,
        startupMs: req.body.startupMs,
        event: req.body.event,
        videoId: req.body.videoId,
      });
      // Record error events separately for per-type/per-platform breakdown
      if (req.body.event === "error" && (req.body.errorType || req.body.errorDetails)) {
        streamHealthAggregator.recordError(
          req.body.platform,
          req.body.errorType ?? "unknown",
        );
      }
      reply.code(202);
      return { ok: true as const, receivedAt: new Date().toISOString() };
    },
  );

  // ── Live Reactions ────────────────────────────────────────────────────────
  // Mobile clients `POST /broadcast/reaction` when the viewer taps an emoji.
  // The server rate-limits per IP, validates the emoji type, and fans the
  // event out to all open SSE connections via `reactionBus`. The TV's
  // `BroadcastLiveCompanion` and the mobile player both show floating emoji
  // animations from `live-reaction` SSE events.
  //
  // No DB persistence: reactions are ephemeral presence signals, not a
  // durable record. Aggregation (total reacts per session) can be derived
  // from structured logs if needed.
  r.post(
    "/reaction",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Send a live emoji reaction — fans out to all SSE subscribers",
        body: z.object({
          type: z.enum(["amen", "fire", "hallelujah"]),
        }),
        response: {
          202: z.object({ ok: z.literal(true) }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const ip = req.ip ?? "unknown";
      if (!consumeReactionToken(ip)) {
        return reply.code(429).send({ error: "Too many reactions — slow down" });
      }
      const event: LiveReactionEvent = {
        type: req.body.type as ReactionType,
        channelId: broadcastEngine.channelId,
        serverTimeMs: Date.now(),
      };
      reactionBus.emit("live-reaction", event);
      reply.code(202);
      return { ok: true as const };
    },
  );

  // ── Live Prayer Requests ───────────────────────────────────────────────────
  // Mobile and TV clients POST /broadcast/prayer during live broadcasts.
  // Prayers are stored in prayer_requests for admin review.
  r.post(
    "/prayer",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Submit a prayer request during a live broadcast",
        body: z.object({
          name: z.string().max(100).default("Anonymous"),
          message: z.string().min(1).max(2000),
          platform: z.enum(["mobile", "tv", "web"]).default("mobile"),
        }),
        response: {
          201: z.object({ ok: z.literal(true), id: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const id = nanoid();
      await db.insert(schema.prayerRequestsTable).values({
        id,
        name: req.body.name,
        message: req.body.message,
        isRead: false,
        createdAt: new Date(),
      });
      reply.code(201);
      return { ok: true as const, id };
    },
  );

  // ── GET/PATCH /playback/state — playback engine configuration ─────────────
  // Stores adaptive-bitrate, CDN, cache and HLS segment settings in
  // app_config (key: playback:config). Readable without auth; writable by editors.
  const PlaybackStateSchema = z.object({
    mode: z.string(),
    cdnEnabled: z.boolean(),
    adaptiveBitrate: z.boolean(),
    maxBitrate: z.number().nullable().optional(),
    defaultQuality: z.string().optional(),
    cacheEnabled: z.boolean(),
    hlsSegmentDuration: z.number().nullable().optional(),
  });
  const DEFAULT_PLAYBACK_STATE = {
    mode: "hls",
    cdnEnabled: false,
    adaptiveBitrate: true,
    maxBitrate: null,
    defaultQuality: "auto",
    cacheEnabled: true,
    hlsSegmentDuration: 6,
  };
  async function getPlaybackState() {
    try {
      const [row] = await db
        .select({ value: schema.appConfigTable.value })
        .from(schema.appConfigTable)
        .where(eq(schema.appConfigTable.key, "playback:config"))
        .limit(1);
      return row ? { ...DEFAULT_PLAYBACK_STATE, ...(JSON.parse(row.value) as object) } : DEFAULT_PLAYBACK_STATE;
    } catch {
      return DEFAULT_PLAYBACK_STATE;
    }
  }

  r.get(
    "/playback/state",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["broadcast"],
        summary: "Get current playback engine configuration",
        response: { 200: PlaybackStateSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async () => getPlaybackState(),
  );

  r.patch(
    "/playback/state",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["broadcast"],
        summary: "Admin: update playback engine configuration",
        body: PlaybackStateSchema.partial(),
        response: { 200: PlaybackStateSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const current = await getPlaybackState();
      const next = { ...current, ...req.body };
      await db
        .insert(schema.appConfigTable)
        .values({ key: "playback:config", value: JSON.stringify(next), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.appConfigTable.key,
          set: { value: JSON.stringify(next), updatedAt: new Date() },
        });
      return next;
    },
  );

  // ── SSE push channel for mobile / web clients ───────────────────────────
  // Mobile (React Native / Expo) uses EventSource (or the polyfill in
  // `services/broadcast.ts`) because WebSocket support on RN is less
  // reliable across Expo Go and bare workflows.  The TV uses a WebSocket
  // instead (`/api/playback/ws`); this endpoint exists specifically for
  // mobile and any web consumer that prefers SSE auto-reconnect.
  //
  // Named events emitted (mobile subscribes via addEventListener):
  //   broadcast-current-updated  — snapshot, advance, preload (full snapshot)
  //   stream-health              — viewer-count ticks
  //   live-reaction              — emoji reaction fan-out (amen/fire/hallelujah)
  app.get<{ Querystring: { platform?: string } }>(
    "/events",
    async (req, reply) => {
      const ip = req.ip ?? "unknown";
      const count = sseIncrement(ip);

      if (count > MAX_SSE_PER_IP) {
        sseDecrement(ip);
        return reply
          .code(429)
          .header("Content-Type", "application/json")
          .send({ error: "Too many SSE connections from this address", max: MAX_SSE_PER_IP });
      }

      // Count this SSE viewer in the combined broadcast viewer count.
      // WS connections are counted in ws.gateway.ts via bumpWsViewers().
      bumpSseViewers(+1);
      sseCounter.inc();

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...sseCorsHeaders(req),
      });

      let lastBcastSseWriteOkMs = Date.now();
      const emit = (eventName: string, data: unknown) => {
        try {
          const ok = reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
          if (ok) lastBcastSseWriteOkMs = Date.now();
        } catch {
          /* connection already gone */
        }
      };

      // Seed the client with the current state immediately so it doesn't
      // have to wait for the next engine tick.
      emit(
        "broadcast-current-updated",
        snapshotToCurrentResult(broadcastEngine.snapshot(), overrideBus.active),
      );

      const onBroadcastEvent = (e: BroadcastEvent) => {
        switch (e.type) {
          case "snapshot":
          case "advance":
          case "preload":
            emit(
              "broadcast-current-updated",
              snapshotToCurrentResult(broadcastEngine.snapshot(), overrideBus.active),
            );
            break;
          case "viewer-count":
            emit("stream-health", { viewerCount: e.data.count, channelId: e.data.channelId });
            break;
        }
      };
      broadcastEngine.on("event", onBroadcastEvent);

      // Push an updated snapshot whenever an admin starts or stops a live
      // override. `overrideBus.active` is already updated by the time this
      // handler fires (notifyStarted/notifyStopped update _active synchronously
      // before emitting), so the snapshot it builds reflects the new state.
      const onOverrideChange = () => {
        emit(
          "broadcast-current-updated",
          snapshotToCurrentResult(broadcastEngine.snapshot(), overrideBus.active),
        );
      };
      overrideBus.on("change", onOverrideChange);

      // Fan live-reaction events from POST /reaction → all SSE subscribers.
      const onReaction = (event: LiveReactionEvent) => {
        emit("live-reaction", event);
      };
      reactionBus.on("live-reaction", onReaction);

      // OMEGA Signal Bus: fan out typed network signals to this SSE subscriber.
      // Mobile clients and web consumers receive real-time PROGRAM_CHANGED,
      // STREAM_FAILED, SYNC_REQUIRED, and EMERGENCY_BROADCAST events via the
      // `omega-signal` SSE named event without polling.
      const onSignal = (signal: OmegaSignal) => {
        emit("omega-signal", signal);
      };
      signalBus.on("signal", onSignal);

      // Admin event bus: forward library/schedule change events to this SSE
      // connection so TV and web clients can bump their libraryRevision /
      // scheduleRevision and trigger a catalog refetch without polling.
      //
      // Event name convention is intentional — the broadcast-sync library's
      // SSE sidecar listens for exactly these named events via EventSource's
      // addEventListener("videos-library-updated", ...).
      const onAdminEvent = (event: { type: string; data: unknown }) => {
        if (event.type === "videos-library-updated") {
          emit("videos-library-updated", event.data ?? {});
        } else if (event.type === "broadcast-schedule-updated") {
          emit("broadcast-schedule-updated", event.data ?? {});
        }
      };
      adminEventBus.on("admin-event", onAdminEvent);

      const heartbeat = setInterval(() => {
        try {
          const ok = reply.raw.write(": ping\n\n");
          if (ok) lastBcastSseWriteOkMs = Date.now();
        } catch {
          /* already gone */
        }
      }, 15_000);
      heartbeat.unref?.();

      // Zombie detection: half-open TCP (silent disconnect without FIN) keeps
      // the socket alive indefinitely. Check writability every 30 s and force-
      // close if no successful write in 90 s (= 6 missed 15 s heartbeats).
      const zombieCheck = setInterval(() => {
        const idleMs = Date.now() - lastBcastSseWriteOkMs;
        const writable = !reply.raw.socket?.destroyed && reply.raw.socket?.writable;
        if (!writable || idleMs > 90_000) cleanup();
      }, 30_000);
      zombieCheck.unref?.();

      let broadcastSseClosed = false;
      const cleanup = () => {
        if (broadcastSseClosed) return;
        broadcastSseClosed = true;
        openBroadcastSseCleanups.delete(cleanup);
        clearInterval(heartbeat);
        clearInterval(zombieCheck);
        broadcastEngine.off("event", onBroadcastEvent);
        overrideBus.off("change", onOverrideChange);
        reactionBus.off("live-reaction", onReaction);
        signalBus.off("signal", onSignal);
        adminEventBus.off("admin-event", onAdminEvent);
        bumpSseViewers(-1);
        sseDecrement(ip);
        sseCounter.dec();
        try { reply.raw.end(); } catch { /* ignore */ }
      };

      openBroadcastSseCleanups.add(cleanup);
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
    },
  );
}
