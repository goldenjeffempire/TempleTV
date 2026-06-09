import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";

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
}
