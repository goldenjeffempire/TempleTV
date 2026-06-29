import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { requireAuth } from "../../../middleware/auth.js";
import { getAutoHealStatus, triggerManualScan } from "../engine/auto-heal-monitor.js";

const adminGuard = { preHandler: requireAuth("editor") } as const;

const _429err = z.object({ error: z.string() });

export async function autohealRoutes(app: FastifyInstance) {
  app.get("/autoheal/status", {
    ...adminGuard,
    schema: { response: { 429: _429err } },
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    return getAutoHealStatus();
  });

  app.post("/autoheal/trigger", {
    ...adminGuard,
    schema: {
      response: {
        200: z.object({ ok: z.boolean(), triggeredAt: z.number(), scanCount: z.number(), actionsTriggered: z.number() }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const { scanCount, actionsTriggered } = await triggerManualScan();
    return { ok: true, triggeredAt: Date.now(), scanCount, actionsTriggered };
  });
}
