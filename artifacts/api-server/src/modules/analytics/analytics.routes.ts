import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";

const WatchEventBodySchema = z.object({
  /**
   * Stable, anonymous per-device identifier.  Clients should persist this in
   * localStorage / AsyncStorage and re-use it across sessions so heartbeat /
   * completion events can be correlated with the original `started` event.
   * If omitted the server generates a random ID (session-level only — no
   * cross-request correlation).
   */
  deviceId: z.string().min(1).max(128).optional(),
  platform: z.enum(["tv", "mobile", "web"]),
  eventType: z.enum(["started", "heartbeat", "completed", "abandoned"]),
  videoId: z.string().min(1).max(256),
  videoTitle: z.string().max(500).optional(),
  positionSecs: z.number().nonnegative().max(86_400).optional(),
  durationSecs: z.number().positive().max(86_400).optional(),
  isLive: z.boolean().optional(),
  channelId: z.string().max(100).optional(),
});

export async function analyticsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/watch-event",
    {
      // Watch heartbeats fire every 30 s per viewer. 10/min per IP is
      // enough for up to 5 simultaneous sessions; prevents event floods
      // from malfunctioning clients or synthetic traffic.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["analytics"],
        summary:
          "Record a watch-time event (started / heartbeat / completed / abandoned). " +
          "Increments video viewCount on `started` and upserts into viewer_sessions so " +
          "the admin analytics dashboard shows real-time engagement data.",
        body: WatchEventBodySchema,
        response: { 204: z.null(), 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const {
        deviceId,
        platform,
        eventType,
        videoId,
        positionSecs,
        durationSecs,
        isLive,
        channelId,
      } = req.body;

      // If the client omits deviceId and this is NOT a "started" event there
      // is no stable identifier to correlate with an existing session row.
      // A freshly-generated nanoid() would match 0 rows in the UPDATE, waste
      // a round-trip, and still leave the session open.  Return early so the
      // caller still gets 204 (analytics writes are non-fatal) but we avoid
      // the useless DB query and the misleading "0 rows updated" log line.
      if (!deviceId && eventType !== "started") {
        return reply.code(204).send(null);
      }

      const effectiveDeviceId = deviceId ?? nanoid();
      const sessions = schema.viewerSessionsTable;
      const videos = schema.videosTable;

      try {
        if (eventType === "started") {
          // Wrapped in a transaction so session insert and viewCount increment
          // are atomic — a partial failure (insert OK, update fails) would leave
          // the session without a corresponding viewCount increment, skewing
          // analytics. onConflictDoNothing() on the insert means replayed
          // "started" events (client retry) do not inflate the count.
          await db.transaction(async (tx) => {
            // Use .returning() to detect whether a new session row was
            // actually inserted.  onConflictDoNothing() silently skips
            // duplicate (deviceId, videoId) pairs — those are client
            // retries and must NOT inflate the viewCount a second time.
            const [inserted] = await tx
              .insert(sessions)
              .values({
                id: nanoid(),
                deviceId: effectiveDeviceId,
                channelId: channelId ?? "temple-tv-live",
                videoId,
                platform,
                isLive: isLive ?? false,
                startedAt: new Date(),
                lastHeartbeatAt: new Date(),
              })
              .onConflictDoNothing()
              .returning({ id: sessions.id });

            // Only increment viewCount for genuinely new sessions.
            if (inserted) {
              await tx
                .update(videos)
                .set({ viewCount: sql`${videos.viewCount} + 1` })
                .where(eq(videos.id, videoId));
            }
          });
        } else if (eventType === "heartbeat") {
          const heartbeatSecs = Math.round(positionSecs ?? 0);
          await db
            .update(sessions)
            .set({
              lastHeartbeatAt: new Date(),
              // GREATEST prevents a delayed heartbeat from overwriting a
              // higher watchedSecs that was already written by a completed
              // or later heartbeat event.
              watchedSecs: sql`GREATEST(${sessions.watchedSecs}, ${heartbeatSecs})`,
            })
            .where(
              and(
                eq(sessions.deviceId, effectiveDeviceId),
                eq(sessions.videoId!, videoId),
              ),
            );
        } else if (eventType === "completed" || eventType === "abandoned") {
          const watchedSecs = Math.round(positionSecs ?? 0);
          const isCompleted =
            eventType === "completed" ||
            (durationSecs != null &&
              durationSecs > 0 &&
              watchedSecs / durationSecs >= 0.9);

          await db
            .update(sessions)
            .set({
              endedAt: new Date(),
              lastHeartbeatAt: new Date(),
              // GREATEST prevents a late-arriving completed/abandoned event
              // from overwriting a higher watchedSecs already written by an
              // earlier completed or heartbeat event.
              watchedSecs: sql`GREATEST(${sessions.watchedSecs}, ${watchedSecs})`,
              // `completed` is sticky once true — never downgrade back to false.
              // A race between a heartbeat and a completed event could otherwise
              // flip completed → false if the heartbeat fires last.
              completed: sql`${sessions.completed} OR ${isCompleted}`,
            })
            .where(
              and(
                eq(sessions.deviceId, effectiveDeviceId),
                eq(sessions.videoId!, videoId),
              ),
            );
        }
      } catch (err) {
        // Non-fatal — analytics writes must never break playback
        app.log.warn({ err, videoId, eventType }, "watch-event DB write failed");
      }

      return reply.code(204).send(null);
    },
  );

  // ── GET /analytics/video/:videoId/retention ──────────────────────────────
  //
  // Per-video viewer retention curve for the admin analytics dashboard.
  //
  // Approach: use `viewer_sessions.watchedSecs` as a proxy for "how far the
  // viewer got". Because watchedSecs is updated with GREATEST on every
  // heartbeat, it tracks the viewer's maximum reached position. Bucketing
  // all sessions by watchedSecs lets us compute what % of viewers made it
  // past each point in the video.
  //
  // The curve is in 10 equal-width buckets (0-9%, 10-19%, … 90-99%, 100%).
  // Each bucket reports the % of total sessions that watched AT LEAST that
  // far — a classic "retention = viewers remaining" curve.
  r.get(
    "/video/:videoId/retention",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["analytics"],
        summary: "Per-video viewer retention curve — percentage of viewers who watched past each point",
        security: [{ bearerAuth: [] }],
        params: z.object({ videoId: z.string().min(1).max(256) }),
        querystring: z.object({
          since: z.string().datetime({ offset: true }).optional(),
        }),
        response: {
          200: z.object({
            videoId: z.string(),
            totalSessions: z.number().int(),
            buckets: z.array(z.object({
              bucketPct: z.number(),
              atLeastSecs: z.number(),
              viewerPct: z.number(),
            })),
          }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => {
      const { videoId } = req.params;
      const { since } = req.query;
      const sessions = schema.viewerSessionsTable;

      const sinceFilter = since ? sql`${sessions.startedAt} >= ${new Date(since)}` : undefined;
      const videoFilter = sql`${sessions.videoId} = ${videoId} AND ${sessions.watchedSecs} > 0`;

      const rows = await db
        .select({ watchedSecs: sessions.watchedSecs })
        .from(sessions)
        .where(sinceFilter ? sql`${videoFilter} AND ${sinceFilter}` : videoFilter)
        .limit(10_000);

      const totalSessions = rows.length;

      if (totalSessions === 0) {
        return {
          videoId,
          totalSessions: 0,
          buckets: Array.from({ length: 10 }, (_, i) => ({
            bucketPct: (i + 1) * 10,
            atLeastSecs: 0,
            viewerPct: 0,
          })),
        };
      }

      // Find the 95th-percentile of watchedSecs as the effective "video length"
      // to avoid outliers (seeked-to-end sessions) inflating the x-axis.
      const sorted = rows.map((r) => r.watchedSecs).sort((a, b) => a - b);
      const p95idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
      const effectiveDuration = Math.max(sorted[p95idx]!, 1);

      const NUM_BUCKETS = 10;
      const buckets = Array.from({ length: NUM_BUCKETS }, (_, i) => {
        const fraction = (i + 1) / NUM_BUCKETS;
        const atLeastSecs = Math.round(effectiveDuration * fraction);
        const watchedAtLeast = rows.filter((r) => r.watchedSecs >= atLeastSecs * 0.95).length;
        return {
          bucketPct: (i + 1) * 10,
          atLeastSecs,
          viewerPct: Math.round((watchedAtLeast / totalSessions) * 100),
        };
      });

      return { videoId, totalSessions, buckets };
    },
  );
}
