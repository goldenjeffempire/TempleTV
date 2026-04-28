import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../infrastructure/db.js";
import { cache } from "../../infrastructure/cache.js";
import { storage } from "../../infrastructure/storage.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";

const HealthSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  uptimeSec: z.number(),
  version: z.string(),
  dependencies: z.object({
    database: z.enum(["ok", "down"]),
    cache: z.enum(["ok", "down"]),
    storage: z.enum(["ok", "disabled"]),
  }),
  broadcast: z.object({
    channelId: z.string(),
    viewerCount: z.number().int().nonnegative(),
    hasCurrent: z.boolean(),
  }),
});

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/healthz",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness probe (cheap)",
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  r.get(
    "/readyz",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness probe — DB + cache + storage + broadcast engine",
        response: { 200: HealthSchema, 503: HealthSchema },
      },
    },
    async (_req, reply) => {
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

      const status: "ok" | "degraded" | "down" =
        !dbOk ? "down" : !cacheOk ? "degraded" : "ok";
      const body = {
        status,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        version: process.env.APP_VERSION ?? "1.0.0",
        dependencies: {
          database: dbOk ? "ok" as const : "down" as const,
          cache: cacheOk ? "ok" as const : "down" as const,
          storage: storage().enabled ? "ok" as const : "disabled" as const,
        },
        broadcast: {
          channelId: snap.channelId,
          viewerCount: broadcastEngine.getViewerCount(),
          hasCurrent: snap.current !== null,
        },
      };
      if (status === "down") reply.code(503);
      return body;
    },
  );
}
