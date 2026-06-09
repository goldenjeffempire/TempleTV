/**
 * network.routes — OMEGA Control Plane
 *
 * Implements the Network Operations Center (NOC):
 *   POST /api/network/broadcast/command  — dispatch a broadcast command
 *   GET  /api/network/heartbeat          — encoder + stream + CDN + player health
 *   GET  /api/network/status             — full NOC dashboard state
 *
 * Commands (OMEGA CONTROL PLANE):
 *   GO_LIVE    — start a live override immediately
 *   SWITCH     — switch the active stream source
 *   SYNC       — force all viewers to resync position
 *   EMERGENCY  — interrupt everything with emergency broadcast
 *   FAILOVER   — manually trigger the failover chain
 *   LOCK       — lock broadcast state (prevents further changes)
 *   UNLOCK     — release broadcast lock
 *   STOP       — stop the active live override
 *
 * Transport: all commands that change state emit an OMEGA signal via
 * the signal bus, which the WS and SSE gateways fan out to every client.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { overrideBus } from "../live-overrides/override-bus.js";
import { liveOverridesService } from "../live-overrides/live-overrides.service.js";
import { streamHealthAggregator } from "../broadcast/stream-health.js";
import { broadcastScheduler } from "../broadcast/broadcast-scheduler.js";
import { broadcastSignal } from "./signal-bus.js";

// ── Broadcast lock ─────────────────────────────────────────────────────────
// When locked, only UNLOCK and EMERGENCY commands are accepted.
// In-memory; clears on process restart (intentional — a stale lock after
// a deploy would block the channel indefinitely).
let broadcastLocked = false;

// ── NOC status shape ────────────────────────────────────────────────────────
const NocStatusSchema = z.object({
  channelId: z.string(),
  serverTimeMs: z.number(),
  locked: z.boolean(),
  engine: z.object({
    running: z.boolean(),
    healthy: z.boolean(),
    hasCurrent: z.boolean(),
    currentTitle: z.string().nullable(),
    lastSnapshotAgeMs: z.number(),
  }),
  override: z.object({
    active: z.boolean(),
    title: z.string().nullable(),
    hlsStreamUrl: z.string().nullable(),
    youtubeVideoId: z.string().nullable(),
    startedAt: z.string().nullable(),
    endsAt: z.string().nullable(),
  }),
  viewers: z.number().int().nonnegative(),
  failoverHlsUrl: z.string().nullable(),
  telemetry: z.object({
    totalStalls: z.number(),
    totalErrors: z.number(),
    avgBufferedSecs: z.number().nullable(),
    activeSessions: z.number(),
  }),
});

function buildNocStatus() {
  const snap = broadcastEngine.snapshot();
  const active = overrideBus.active;
  const health = streamHealthAggregator.getStats();
  const lastSnapshotAgeMs = broadcastEngine.getLastSnapshotAgeMs();
  return {
    channelId: broadcastEngine.channelId,
    serverTimeMs: Date.now(),
    locked: broadcastLocked,
    engine: {
      running: broadcastEngine.isRunning(),
      healthy: broadcastEngine.isRunning() && lastSnapshotAgeMs < 90_000,
      hasCurrent: snap.current !== null,
      currentTitle: snap.current?.title ?? null,
      lastSnapshotAgeMs,
    },
    override: {
      active: active !== null,
      title: active?.title ?? null,
      hlsStreamUrl: active?.hlsStreamUrl ?? null,
      youtubeVideoId: active?.youtubeVideoId ?? null,
      startedAt: active?.startedAt ?? null,
      endsAt: active?.endsAt ?? null,
    },
    viewers: broadcastEngine.getViewerCount(),
    failoverHlsUrl: null,
    telemetry: {
      totalStalls: health.totalStalls,
      totalErrors: health.totalErrors,
      avgBufferedSecs: health.avgBufferedSecs,
      activeSessions: health.activeSessions,
    },
  };
}

// ── Heartbeat checker ───────────────────────────────────────────────────────
async function runHeartbeatCheck() {
  const channelId = broadcastEngine.channelId;
  const lastSnapshotAgeMs = broadcastEngine.getLastSnapshotAgeMs();
  const health = streamHealthAggregator.getStats();
  const snap = broadcastEngine.snapshot();

  const checks = {
    engine: broadcastEngine.isRunning() && lastSnapshotAgeMs < 90_000,
    stream: snap.current !== null || overrideBus.active !== null,
    // CDN check: we judge CDN health by whether clients are receiving data
    // (avg buffer > 0 if anyone has posted telemetry in the last 5 min)
    cdn: health.activeSessions === 0 || (health.avgBufferedSecs ?? 0) > 0,
    // Player health: low stall-to-session ratio
    player: health.activeSessions === 0 || health.totalStalls < health.activeSessions * 3,
  };

  const allHealthy = Object.values(checks).every(Boolean);

  // Auto-recovery: if engine is unhealthy and not locked, trigger reload
  if (!checks.engine && !broadcastLocked) {
    try {
      await broadcastEngine.reload();
      broadcastSignal("SYNC_REQUIRED", channelId, {
        message: "Heartbeat triggered engine reload",
        payload: { staleMs: lastSnapshotAgeMs },
      });
    } catch {
      broadcastSignal("STREAM_FAILED", channelId, {
        message: "Heartbeat: engine reload failed",
        payload: { lastSnapshotAgeMs },
      });
    }
  }

  return { ok: allHealthy, checks, checkedAt: new Date().toISOString() };
}

export async function networkRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── NOC Status ──────────────────────────────────────────────────────────
  r.get(
    "/status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["network"],
        summary: "OMEGA NOC: full broadcast network status",
        security: [{ bearerAuth: [] }],
        response: { 200: NocStatusSchema },
      },
    },
    async () => buildNocStatus(),
  );

  // ── Live Heartbeat ──────────────────────────────────────────────────────
  // GET /api/network/heartbeat — checks encoder, stream, CDN, player health.
  // Safe to poll from uptime monitors; triggers auto-recovery on failure.
  r.get(
    "/heartbeat",
    {
      schema: {
        tags: ["network"],
        summary: "OMEGA NOC: live heartbeat — encoder + stream + CDN + player",
        response: {
          200: z.object({
            ok: z.boolean(),
            checks: z.object({
              engine: z.boolean(),
              stream: z.boolean(),
              cdn: z.boolean(),
              player: z.boolean(),
            }),
            checkedAt: z.string(),
          }),
        },
      },
    },
    async (_req, reply) => {
      reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      return runHeartbeatCheck();
    },
  );

  // ── Broadcast Command Dispatch ──────────────────────────────────────────
  const CommandSchema = z.object({
    command: z.enum(["GO_LIVE", "SWITCH", "SYNC", "EMERGENCY", "FAILOVER", "LOCK", "UNLOCK", "STOP"]),
    payload: z
      .object({
        title: z.string().max(256).optional(),
        hlsStreamUrl: z.string().url().optional(),
        youtubeUrl: z.string().optional(),
        endsAt: z.string().datetime().optional(),
        message: z.string().max(512).optional(),
        reason: z.string().max(256).optional(),
      })
      .optional(),
  });

  r.post(
    "/broadcast/command",
    {
      preHandler: requireAuth("admin"),
      // High-impact NOC commands that mutate live broadcast state. 10/min
      // gives operators plenty of headroom while bounding accidental loops.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["network"],
        summary: "OMEGA NOC: dispatch a broadcast command (GO_LIVE, SWITCH, SYNC, EMERGENCY, FAILOVER, LOCK, UNLOCK, STOP)",
        body: CommandSchema,
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({ ok: z.literal(true), command: z.string(), executedAt: z.string() }),
          423: z.object({ error: z.string(), locked: z.literal(true) }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { command, payload } = req.body;
      const channelId = broadcastEngine.channelId;

      // LOCK gate: reject all commands except UNLOCK and EMERGENCY when locked
      if (broadcastLocked && command !== "UNLOCK" && command !== "EMERGENCY") {
        return reply.code(423).send({ error: "Broadcast is locked — UNLOCK or use EMERGENCY to override", locked: true as const });
      }

      switch (command) {
        case "GO_LIVE": {
          const title = payload?.title ?? "Live Broadcast";
          const override = await liveOverridesService.start({
            title,
            hlsStreamUrl: payload?.hlsStreamUrl,
            youtubeUrl: payload?.youtubeUrl,
            endsAt: payload?.endsAt,
          });
          overrideBus.notifyStarted({
            id: override.id,
            title: override.title,
            hlsStreamUrl: override.hlsStreamUrl,
            youtubeVideoId: override.youtubeVideoId,
            startedAt: override.startedAt,
            endsAt: override.endsAt,
          });
          broadcastSignal("PROGRAM_CHANGED", channelId, {
            message: `GO_LIVE: ${title}`,
            payload: { command, overrideId: override.id },
          });
          break;
        }

        case "SWITCH": {
          // Switch stream: stop current override and start a new one
          if (overrideBus.active) {
            await liveOverridesService.stop().catch(() => null);
            overrideBus.notifyStopped();
          }
          if (payload?.hlsStreamUrl || payload?.youtubeUrl) {
            const title = payload?.title ?? "Switched Broadcast";
            const override = await liveOverridesService.start({
              title,
              hlsStreamUrl: payload?.hlsStreamUrl,
              youtubeUrl: payload?.youtubeUrl,
              endsAt: payload?.endsAt,
            });
            overrideBus.notifyStarted({
              id: override.id,
              title: override.title,
              hlsStreamUrl: override.hlsStreamUrl,
              youtubeVideoId: override.youtubeVideoId,
              startedAt: override.startedAt,
              endsAt: override.endsAt,
            });
          }
          broadcastSignal("PROGRAM_CHANGED", channelId, {
            message: `SWITCH: ${payload?.title ?? "stream switched"}`,
            payload: { command, reason: payload?.reason },
          });
          break;
        }

        case "SYNC": {
          // Force all viewers to resync — emit SYNC_REQUIRED signal
          broadcastSignal("SYNC_REQUIRED", channelId, {
            message: payload?.message ?? "Admin-requested global resync",
            payload: { command, adminInitiated: true },
          });
          // Also run the scheduler to clean up any stale state
          await broadcastScheduler.runNow();
          break;
        }

        case "EMERGENCY": {
          // Highest priority: activate emergency broadcast, unlock if locked
          broadcastLocked = false;
          const title = payload?.title ?? "EMERGENCY BROADCAST";
          if (overrideBus.active) {
            await liveOverridesService.stop().catch(() => null);
            overrideBus.notifyStopped();
          }
          if (payload?.hlsStreamUrl || payload?.youtubeUrl) {
            const override = await liveOverridesService.start({
              title,
              hlsStreamUrl: payload?.hlsStreamUrl,
              youtubeUrl: payload?.youtubeUrl,
              endsAt: payload?.endsAt,
            });
            overrideBus.notifyStarted({
              id: override.id,
              title: override.title,
              hlsStreamUrl: override.hlsStreamUrl,
              youtubeVideoId: override.youtubeVideoId,
              startedAt: override.startedAt,
              endsAt: override.endsAt,
            });
          }
          broadcastSignal("EMERGENCY_BROADCAST", channelId, {
            message: payload?.message ?? `EMERGENCY BROADCAST: ${title}`,
            payload: { command, title, adminInitiated: true },
          });
          break;
        }

        case "FAILOVER": {
          // Manually trigger failover: stop active override, force engine reload
          if (overrideBus.active) {
            await liveOverridesService.stop().catch(() => null);
            overrideBus.notifyStopped();
          }
          await broadcastEngine.reload();
          broadcastSignal("FAILOVER_ACTIVATED", channelId, {
            message: payload?.reason ?? "Manual failover triggered by admin",
            payload: { command, failoverHlsUrl: null },
          });
          break;
        }

        case "LOCK": {
          broadcastLocked = true;
          broadcastSignal("BROADCAST_LOCKED", channelId, {
            message: payload?.message ?? "Broadcast locked by admin",
            payload: { command },
          });
          break;
        }

        case "UNLOCK": {
          broadcastLocked = false;
          broadcastSignal("BROADCAST_UNLOCKED", channelId, {
            message: payload?.message ?? "Broadcast unlocked by admin",
            payload: { command },
          });
          break;
        }

        case "STOP": {
          if (!overrideBus.active) {
            return reply.code(200).send({ ok: true as const, command, executedAt: new Date().toISOString() });
          }
          await liveOverridesService.stop();
          overrideBus.notifyStopped();
          broadcastSignal("PROGRAM_CHANGED", channelId, {
            message: "STOP: live override ended, returning to scheduled queue",
            payload: { command },
          });
          break;
        }
      }

      return { ok: true as const, command, executedAt: new Date().toISOString() };
    },
  );
}

export { broadcastLocked };
