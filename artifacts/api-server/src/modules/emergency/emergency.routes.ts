import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { broadcastSignal } from "../network/signal-bus.js";
import { logger } from "../../infrastructure/logger.js";

export async function emergencyRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const AlertBodySchema = z.object({
    channelId: z.string().optional().default("all"),
    title: z.string().min(1).max(120),
    message: z.string().min(1).max(1000),
    severity: z.enum(["info", "warning", "critical", "emergency"]).default("info"),
    expiresInMinutes: z.number().int().positive().optional().nullable(),
  });

  const AlertSchema = z.object({
    id: z.string(),
    channelId: z.string(),
    title: z.string(),
    message: z.string(),
    severity: z.string(),
    isActive: z.boolean(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
  });

  // ── Public: get active emergency alerts ───────────────────────────────────
  r.get(
    "/emergency/active",
    {
      schema: {
        tags: ["emergency"],
        summary: "Get currently active emergency alerts",
        response: { 200: z.array(AlertSchema) },
      },
    },
    async () => {
      const now = new Date();
      const rows = await db
        .select()
        .from(schema.emergencyAlertsTable)
        .where(eq(schema.emergencyAlertsTable.isActive, true));

      return rows
        .filter((r) => !r.expiresAt || r.expiresAt > now)
        .map((r) => ({
          id: r.id,
          channelId: r.channelId,
          title: r.title,
          message: r.message,
          severity: r.severity,
          isActive: r.isActive,
          createdBy: r.createdBy ?? null,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt?.toISOString() ?? null,
        }));
    },
  );

  const AlertHistoryItemSchema = z.object({
    id: z.string(),
    channelId: z.string(),
    title: z.string(),
    message: z.string(),
    severity: z.string(),
    isActive: z.boolean(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    dismissedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  });

  const AlertCreatedSchema = z.object({
    id: z.string(),
    channelId: z.string(),
    title: z.string(),
    message: z.string(),
    severity: z.string(),
    isActive: z.boolean(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
  });

  // ── Admin: list all alerts (history) ────────────────────────────────────
  r.get(
    "/admin/emergency",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["emergency"],
        summary: "List all emergency alerts (history)",
        response: { 200: z.array(AlertHistoryItemSchema) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(schema.emergencyAlertsTable)
        .orderBy(schema.emergencyAlertsTable.createdAt);

      return rows.map((r) => ({
        id: r.id,
        channelId: r.channelId,
        title: r.title,
        message: r.message,
        severity: r.severity,
        isActive: r.isActive,
        createdBy: r.createdBy ?? null,
        createdAt: r.createdAt.toISOString(),
        dismissedAt: r.dismissedAt?.toISOString() ?? null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
      }));
    },
  );

  // ── Admin: broadcast emergency alert ────────────────────────────────────
  r.post(
    "/admin/emergency",
    {
      preHandler: requireAuth("editor"),
      // Each create fans out an SSE/WS EMERGENCY_BROADCAST signal to every
      // connected client. 5/min prevents alert-storm abuse from a compromised
      // editor account; legitimate use is always a deliberate manual action.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["emergency"],
        summary: "Broadcast an emergency alert to all connected clients",
        body: AlertBodySchema,
        response: { 201: AlertCreatedSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { channelId, title, message, severity, expiresInMinutes } = req.body;
      const expiresAt = expiresInMinutes
        ? new Date(Date.now() + expiresInMinutes * 60 * 1000)
        : null;

      const [alert] = await db.insert(schema.emergencyAlertsTable).values({
        id: crypto.randomUUID(),
        channelId,
        title,
        message,
        severity,
        isActive: true,
        createdBy: req.principal?.email ?? "admin",
        expiresAt,
      }).returning();

      logger.info(
        {
          alertId: alert!.id,
          channelId,
          severity,
          expiresInMinutes: expiresInMinutes ?? null,
          createdBy: req.principal?.email ?? "admin",
        },
        "[emergency] alert created",
      );

      // Fan out EMERGENCY_BROADCAST signal to every WS/SSE client
      broadcastSignal("EMERGENCY_BROADCAST", channelId, {
        message: title,
        payload: {
          alertId: alert!.id,
          title,
          message,
          severity,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      });

      // Auto-dismiss if expiry set
      if (expiresAt) {
        const delay = expiresAt.getTime() - Date.now();
        setTimeout(async () => {
          await db
            .update(schema.emergencyAlertsTable)
            .set({ isActive: false, dismissedAt: new Date() })
            .where(eq(schema.emergencyAlertsTable.id, alert!.id));

          // Signal clients that the alert is gone
          broadcastSignal("NODE_HEALTH_CHANGED", channelId, {
            message: "Emergency alert expired",
            payload: { alertId: alert!.id, dismissed: true },
          });
        }, delay);
      }

      return reply.code(201).send({
        id: alert!.id,
        channelId: alert!.channelId,
        title: alert!.title,
        message: alert!.message,
        severity: alert!.severity,
        isActive: alert!.isActive,
        createdBy: alert!.createdBy ?? null,
        createdAt: alert!.createdAt.toISOString(),
        expiresAt: alert!.expiresAt?.toISOString() ?? null,
      });
    },
  );

  // ── Admin: dismiss emergency alert ───────────────────────────────────────
  r.delete(
    "/admin/emergency/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["emergency"],
        summary: "Dismiss an active emergency alert",
        params: z.object({ id: z.string() }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const [alert] = await db
        .update(schema.emergencyAlertsTable)
        .set({ isActive: false, dismissedAt: new Date() })
        .where(eq(schema.emergencyAlertsTable.id, req.params.id))
        .returning();

      if (!alert) return reply.code(404).send({ error: "Alert not found" });

      logger.info(
        { alertId: alert.id, channelId: alert.channelId, dismissedBy: req.principal?.email ?? "admin" },
        "[emergency] alert dismissed",
      );

      // Signal clients that the alert is dismissed
      broadcastSignal("NODE_HEALTH_CHANGED", alert.channelId, {
        message: "Emergency alert dismissed by admin",
        payload: { alertId: alert.id, dismissed: true },
      });

      return reply.code(204).send(null);
    },
  );
}
