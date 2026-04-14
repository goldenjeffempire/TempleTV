import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, broadcastQueueTable, scheduleTable, videosTable } from "@workspace/db";
import { count, eq, sql } from "drizzle-orm";
import { cache } from "../lib/cache";
import { metricsSnapshot, metricsText } from "../middlewares/observability";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/cache/status", (_req, res) => {
  const status = cache.status();
  res.json(status);
});

router.get("/ops/status", async (_req, res) => {
  const generatedAt = new Date().toISOString();
  const cacheStatus = cache.status();
  const dbConnected = await db.execute(sql`select 1 as ok`).then(() => true).catch(() => false);
  const [videosResult, scheduleResult, broadcastResult] = dbConnected
    ? await Promise.all([
        db.select({ count: count() }).from(videosTable).catch(() => [{ count: 0 }]),
        db.select({ count: count() }).from(scheduleTable).where(eq(scheduleTable.isActive, true)).catch(() => [{ count: 0 }]),
        db.select({ count: count() }).from(broadcastQueueTable).where(eq(broadcastQueueTable.isActive, true)).catch(() => [{ count: 0 }]),
      ])
    : [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }]];

  const activeQueueItems = Number(broadcastResult[0]?.count ?? 0);
  const checks = [
    { key: "api", label: "API process", status: "ok" },
    { key: "database", label: "Database", status: dbConnected ? "ok" : "critical" },
    { key: "cache", label: "Cache", status: cacheStatus.redis.configured && !cacheStatus.redis.connected ? "degraded" : "ok" },
    { key: "broadcast", label: "Broadcast continuity", status: activeQueueItems > 0 ? "ok" : "degraded" },
  ];
  const overallStatus = checks.some((check) => check.status === "critical")
    ? "critical"
    : checks.some((check) => check.status === "degraded")
      ? "degraded"
      : "ok";

  res.json({
    generatedAt,
    overallStatus,
    checks,
    metrics: metricsSnapshot(),
    database: {
      connected: dbConnected,
      counts: {
        videos: Number(videosResult[0]?.count ?? 0),
        activeScheduleEntries: Number(scheduleResult[0]?.count ?? 0),
      },
    },
    broadcast: {
      activeQueueItems,
    },
  });
});

router.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(metricsText());
});

export default router;
