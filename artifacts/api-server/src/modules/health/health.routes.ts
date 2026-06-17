import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { count, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { cache } from "../../infrastructure/cache.js";
import { storage } from "../../infrastructure/storage.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { broadcastOrchestrator } from "../broadcast-v2/engine/broadcast-orchestrator.js";
import { streamHealthAggregator } from "../broadcast/stream-health.js";
import { liveOverridesService } from "../live-overrides/live-overrides.service.js";
import { env } from "../../config/env.js";
import { isShuttingDown } from "../../infrastructure/shutdown-flag.js";

const HealthSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  uptimeSec: z.number(),
  version: z.string(),
  dependencies: z.object({
    database: z.enum(["ok", "down"]),
    cache: z.enum(["ok", "down"]),
    // "degraded" = storage is enabled but the health-monitor circuit breaker
    // has tripped (consecutive probe failures).  "disabled" = storage is not
    // configured.
    storage: z.enum(["ok", "degraded", "disabled"]),
    broadcastV2: z.enum(["ok", "stuck", "down"]),
  }),
  broadcast: z.object({
    channelId: z.string(),
    viewerCount: z.number().int().nonnegative(),
    hasCurrent: z.boolean(),
  }),
  // Structured broadcast-v2 orchestrator metrics for production monitoring.
  // Exposes the minimum fields needed for uptime dashboards and alerting rules
  // without leaking internal state that changes on every snapshot tick.
  broadcastEngine: z.object({
    ok: z.boolean(),
    mode: z.string(),
    sequence: z.number().int(),
    uptimeMs: z.number().int(),
    itemCount: z.number().int(),
  }),
  storageReconciliation: z.object({
    lastRunAt: z.number().nullable(),
    lastPassElapsedMs: z.number().nullable(),
    itemsChecked: z.number().int(),
    blobsVerified: z.number().int(),
    gapsFound: z.number().int(),
    recoveries: z.number().int(),
    orphanedBlobCount: z.number().int(),
    consecutiveErrors: z.number().int(),
  }).optional(),
});

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Liveness probe (cheap, no I/O). The shared handler is mounted at
  // both `/healthz` (k8s convention) and `/health` (the more common
  // load-balancer / uptime-monitor convention) so we don't have to
  // pick one and break a downstream consumer.
  //
  // During graceful shutdown (SIGTERM received) the probe returns 503 so
  // upstream load balancers (Render, AWS ALB, k8s ingress, Replit proxy)
  // observe the failure, stop routing new requests, and drain in-flight
  // traffic — the core mechanism for zero-downtime rolling restarts.
  // The SHUTDOWN_PRECLOSE_DELAY_MS window in main.ts gives the LB time to
  // act on the 503 before any connections are actively closed.
  const liveness = async (_req: unknown, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    if (isShuttingDown()) {
      reply.code(503);
      return { status: "shutting_down" as const };
    }
    return { status: "ok" as const };
  };
  const livenessSchema = {
    tags: ["health"],
    summary: "Liveness probe — returns 503 during graceful shutdown so LBs drain traffic",
    response: {
      200: z.object({ status: z.literal("ok") }),
      503: z.object({ status: z.literal("shutting_down") }),
    },
  };
  const livenessRateLimit = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  r.get("/healthz", { ...livenessRateLimit, schema: livenessSchema }, liveness);
  r.get("/health", { ...livenessRateLimit, schema: livenessSchema }, liveness);

  // Cheap diagnostic snapshot — version, uptime, runtime memory, run-mode,
  // process pid, node version. No I/O, safe to poll from uptime monitors
  // every few seconds. Distinct from /readyz (which probes DB + cache +
  // storage + broadcast engine and may return 503).
  const StatusSchema = z.object({
    service: z.literal("temple-tv-api"),
    version: z.string(),
    runMode: z.enum(["api", "worker", "all"]),
    env: z.string(),
    uptimeSec: z.number(),
    nodeVersion: z.string(),
    pid: z.number(),
    memory: z.object({
      rssMb: z.number(),
      heapUsedMb: z.number(),
      heapTotalMb: z.number(),
    }),
  });
  const statusHandler = async () => {
    const mem = process.memoryUsage();
    const toMb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
    return {
      service: "temple-tv-api" as const,
      version: env.APP_VERSION ?? process.env.npm_package_version ?? "1.0.20",
      runMode: env.RUN_MODE,
      env: env.NODE_ENV,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      nodeVersion: process.version,
      pid: process.pid,
      memory: {
        rssMb: toMb(mem.rss),
        heapUsedMb: toMb(mem.heapUsed),
        heapTotalMb: toMb(mem.heapTotal),
      },
    };
  };
  const statusSchema = {
    tags: ["health"],
    summary: "Diagnostic snapshot (cheap, no I/O)",
    response: { 200: StatusSchema, 429: z.object({ error: z.string() }) },
  };
  r.get("/status", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: statusSchema }, statusHandler);

  r.get(
    "/readyz",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["health"],
        summary: "Readiness probe — DB + cache + storage + broadcast engine",
        response: { 200: HealthSchema, 503: HealthSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (_req, reply) => {
      // Startup gate: return 503 while the API is still booting.
      // Without this a load balancer could route traffic to a half-initialised
      // replica (DB pool not warm, workers not started, orchestrator not
      // hydrated), causing request failures immediately after a deploy.
      // This check is intentionally cheap — it reads a module-level boolean
      // set by main.ts at the very end of the boot sequence.
      {
        const { isStartupComplete } = await import("../../infrastructure/shutdown-flag.js");
        if (!isStartupComplete()) {
          reply.code(503);
          return {
            status: "down" as const,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            version: env.APP_VERSION ?? "unknown",
            dependencies: {
              database: "down" as const,
              cache: "down" as const,
              storage: "disabled" as const,
              broadcastV2: "down" as const,
            },
            broadcast: { channelId: "main", viewerCount: 0, hasCurrent: false },
            broadcastEngine: { ok: false, mode: "starting_up", sequence: 0, uptimeMs: 0, itemCount: 0 },
          };
        }
      }
      let dbOk = true;
      try {
        await db.execute(sql`select 1`);
      } catch {
        dbOk = false;
      }
      let cacheOk = true;
      try {
        await cache().set("__health__", "1", 5);
        await cache().get<string>("__health__");
      } catch {
        cacheOk = false;
      }
      const snap = broadcastEngine.snapshot();

      const storageEnabled = storage().enabled;
      const storageDisabledInProd = !storageEnabled && env.NODE_ENV === "production";
      // Use the storage health monitor circuit-breaker status when available.
      // Falls back to healthy=true during the first 5 s before the probe fires
      // so a freshly started process doesn't 503 its own readiness check.
      let storageProbeFailed = false;
      try {
        const { getStorageHealthStatus } = await import("../../infrastructure/storage-health-monitor.js");
        const sth = getStorageHealthStatus();
        storageProbeFailed = sth.enabled && !sth.healthy && sth.totalChecks > 0;
      } catch {
        // monitor not yet loaded — treat as healthy
      }

      // Broadcast-v2 health: surface stuck-orchestrator state (boot succeeded
      // but sequence never advanced past 0 while items exist for >30 s).
      // Uses the orchestrator's own start timestamp — NOT the health module's
      // load time — so a freshly started orchestrator on a long-lived process
      // is not falsely flagged as stuck.
      let v2Status: "ok" | "stuck" | "down" = "ok";
      try {
        if (!broadcastOrchestrator.isStarted()) {
          v2Status = "down";
        } else {
          const seq = broadcastOrchestrator.getSequence();
          const itemCount = broadcastOrchestrator.getItemCount();
          const startedAtMs = broadcastOrchestrator.getStartedAtMs();
          const orchestratorUptimeMs = startedAtMs > 0 ? Date.now() - startedAtMs : 0;
          if (seq === 0 && itemCount > 0 && orchestratorUptimeMs > 30_000) {
            v2Status = "stuck";
          }
        }
      } catch {
        v2Status = "down";
      }

      const status: "ok" | "degraded" | "down" =
        !dbOk ? "down"
        : storageDisabledInProd ? "down"
        : v2Status === "down" ? "down"
        : (!cacheOk || v2Status === "stuck" || storageProbeFailed) ? "degraded"
        : "ok";
      const body = {
        status,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        version: env.APP_VERSION ?? process.env.npm_package_version ?? "1.0.20",
        dependencies: {
          database: dbOk ? "ok" as const : "down" as const,
          cache: cacheOk ? "ok" as const : "down" as const,
          storage: storageEnabled
            ? (storageProbeFailed ? "degraded" as const : "ok" as const)
            : "disabled" as const,
          broadcastV2: v2Status,
        },
        broadcast: {
          channelId: snap.channelId,
          viewerCount: broadcastEngine.getViewerCount(),
          hasCurrent: snap.current !== null,
        },
      };
      const v2Started = broadcastOrchestrator.isStarted();
      const v2StartedAtMs = broadcastOrchestrator.getStartedAtMs();
      const v2EngineBody = {
        ok: v2Started && v2Status !== "down" && v2Status !== "stuck",
        mode: v2Started ? (broadcastOrchestrator.snapshot().mode ?? "unknown") : "stopped",
        sequence: broadcastOrchestrator.getSequence(),
        uptimeMs: v2StartedAtMs > 0 ? Math.max(0, Date.now() - v2StartedAtMs) : 0,
        itemCount: broadcastOrchestrator.getItemCount(),
      };
      // Expose storage reconciliation stats for production monitoring.
      // Lazy-import so the health endpoint works even before the reconciliation
      // worker module has been loaded (early boot / worker disabled).
      let storageReconciliationStats: ReturnType<typeof import("../broadcast-v2/engine/storage-blob-recovery.service.js")["storageBlobRecoveryService"]["getStats"]> | undefined;
      try {
        const { storageBlobRecoveryService } = await import("../broadcast-v2/engine/storage-blob-recovery.service.js");
        storageReconciliationStats = storageBlobRecoveryService.getStats();
      } catch {
        // module not loaded — stats omitted
      }

      if (status === "down") reply.code(503);
      return {
        ...body,
        broadcastEngine: v2EngineBody,
        ...(storageReconciliationStats !== undefined
          ? { storageReconciliation: storageReconciliationStats }
          : {}),
      };
    },
  );

  // ── Broadcast stream-health endpoint ─────────────────────────────────────
  // Returns live broadcast KPIs in a single response: viewer counts, engine
  // status, and rolling 5-minute telemetry aggregates (stalls, errors, avg
  // buffer level, avg bitrate). Intended for dashboards, uptime monitors, and
  // the admin panel's stream-health widget. No DB I/O — all data is in-memory.
  const LiveHealthSchema = z.object({
    ok: z.boolean(),
    uptimeSec: z.number(),
    checkedAt: z.string(),
    broadcast: z.object({
      channelId: z.string(),
      engineRunning: z.boolean(),
      hasCurrent: z.boolean(),
      currentTitle: z.string().nullable(),
      lastSnapshotAgeMs: z.number(),
      engineHealthy: z.boolean(),
    }),
    viewers: z.object({
      total: z.number().int().nonnegative(),
    }),
    telemetry: z.object({
      windowMs: z.number(),
      totalStalls: z.number().int().nonnegative(),
      totalErrors: z.number().int().nonnegative(),
      avgBufferedSecs: z.number().nullable(),
      avgBitrateKbps: z.number().nullable(),
      activeSessions: z.number().int().nonnegative(),
      platformBreakdown: z.record(z.string(), z.number()),
    }),
  });

  // ── GET /ops/status — public platform status for mobile/TV diagnostic use ──
  // Returns a lightweight summary matching the `PlatformStatus` interface used
  // by the mobile app's `services/platform.ts`. No auth required; used to show
  // a "Platform Status" indicator in the mobile settings screen and to gate
  // certain features (e.g., live chat) when the platform is degraded.
  const OpsStatusSchema = z.object({
    generatedAt: z.string(),
    overallStatus: z.enum(["ok", "degraded", "critical"]),
    checks: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        status: z.enum(["ok", "degraded", "critical"]),
      }),
    ),
    database: z
      .object({
        counts: z
          .object({
            videos: z.number().int().optional(),
            activeScheduleEntries: z.number().int().optional(),
          })
          .optional(),
      })
      .optional(),
    broadcast: z
      .object({
        activeQueueItems: z.number().int().optional(),
        activeLiveOverrides: z.number().int().optional(),
      })
      .optional(),
  });

  r.get(
    "/ops/status",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["health"],
        summary: "Public platform status summary for mobile / TV clients",
        response: { 200: OpsStatusSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (_req, reply) => {
      reply.header("Cache-Control", "public, s-maxage=15, max-age=15, stale-while-revalidate=30");

      let dbStatus: "ok" | "degraded" | "critical" = "ok";
      let videoCount: number | undefined;
      try {
        const [vc] = await db.select({ c: count() }).from(schema.videosTable);
        videoCount = Number(vc?.c ?? 0);
      } catch {
        dbStatus = "critical";
      }

      const snap = broadcastEngine.snapshot();
      const engineRunning = broadcastEngine.isRunning();
      const broadcastStatus: "ok" | "degraded" | "critical" = engineRunning ? "ok" : "degraded";

      let overridesCount = 0;
      try {
        const recent = await liveOverridesService.listRecent();
        overridesCount = recent.items.filter((i) => i.isActive).length;
      } catch { /* non-fatal */ }

      const checks: Array<{ key: string; label: string; status: "ok" | "degraded" | "critical" }> = [
        { key: "database",  label: "Database",         status: dbStatus },
        { key: "broadcast", label: "Broadcast Engine", status: broadcastStatus },
        { key: "api",       label: "API Server",       status: "ok" },
      ];

      const overallStatus: "ok" | "degraded" | "critical" =
        checks.some((c) => c.status === "critical") ? "critical"
        : checks.some((c) => c.status === "degraded") ? "degraded"
        : "ok";

      return {
        generatedAt: new Date().toISOString(),
        overallStatus,
        checks,
        database: { counts: { videos: videoCount } },
        broadcast: {
          activeQueueItems: snap.upcoming.length + (snap.current ? 1 : 0),
          activeLiveOverrides: overridesCount,
        },
      };
    },
  );

  r.get(
    "/health/live",
    {
      schema: {
        tags: ["health"],
        summary: "Broadcast stream-health KPIs — viewers, engine status, telemetry (5-min window)",
        response: { 200: LiveHealthSchema },
      },
    },
    async () => {
      const snap = broadcastEngine.snapshot();
      const lastSnapshotAgeMs = broadcastEngine.getLastSnapshotAgeMs();
      // Engine is "healthy" if:
      //  • it is actively running (timer chain alive), OR
      //  • the queue is empty (idle-by-design, not stuck)
      //  • AND the last snapshot is fresh enough (< 90 s stale threshold)
      const engineRunning = broadcastEngine.isRunning();
      const engineHealthy = engineRunning && lastSnapshotAgeMs < 90_000;

      const telemetry = streamHealthAggregator.getStats();

      return {
        ok: engineHealthy,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        checkedAt: new Date().toISOString(),
        broadcast: {
          channelId: snap.channelId,
          engineRunning,
          hasCurrent: snap.current !== null,
          currentTitle: snap.current?.title ?? null,
          lastSnapshotAgeMs,
          engineHealthy,
        },
        viewers: {
          total: broadcastEngine.getViewerCount(),
        },
        telemetry: {
          windowMs: telemetry.windowMs,
          totalStalls: telemetry.totalStalls,
          totalErrors: telemetry.totalErrors,
          avgBufferedSecs: telemetry.avgBufferedSecs,
          avgBitrateKbps: telemetry.avgBitrateKbps,
          activeSessions: telemetry.activeSessions,
          platformBreakdown: telemetry.platformBreakdown,
        },
      };
    },
  );
}
