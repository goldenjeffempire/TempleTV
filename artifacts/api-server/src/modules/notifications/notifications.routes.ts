import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  ListNotificationsQuerySchema,
  ListNotificationsResponseSchema,
  SendPushBodySchema,
  SendPushResponseSchema,
} from "./notifications.schemas.js";
import { notificationsService, recoverStuckPendingNotifications } from "./notifications.service.js";
import { sendMail, getTransport } from "../../infrastructure/mailer.js";

export async function notificationsRoutes(app: FastifyInstance) {
  app.addHook("onReady", () => {
    void recoverStuckPendingNotifications();
  });
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/history",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["notifications"],
        summary: "List sent push notifications",
        querystring: ListNotificationsQuerySchema,
        response: { 200: ListNotificationsResponseSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => notificationsService.listHistory(req.query),
  );

  // Root alias for `/history`. The admin SPA's older notifications page
  // calls `GET /notifications` and expects the same paginated history
  // payload — keep both URLs serving the same handler so we don't break
  // the existing build while the SPA migrates to `/notifications/history`.
  r.get(
    "/",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["notifications"],
        summary: "Root alias for /history (admin SPA compatibility)",
        querystring: ListNotificationsQuerySchema,
        response: { 200: ListNotificationsResponseSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => notificationsService.listHistory(req.query),
  );

  /**
   * Push subscriber counts — returned before sending so the admin UI can
   * show "X devices will receive this notification" without having to
   * fire a send first.
   */
  r.get(
    "/stats",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["notifications"],
        summary: "Push subscriber counts (Expo tokens + Web Push subscriptions)",
        response: {
          200: z.object({
            expoTokens: z.number().int().nonnegative(),
            webSubscriptions: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => notificationsService.getStats(),
  );

  /**
   * POST /notifications/test-email
   *
   * Sends a test email to SMTP_USER so operators can verify SMTP configuration
   * without triggering a real business event (password reset, welcome, etc.).
   * On auth/connection failure the transport singleton is reset automatically
   * so the next send attempt re-initialises the pool with updated credentials.
   *
   * Admin-only — never expose to editor/moderator roles.
   */
  r.post(
    "/test-email",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["notifications"],
        summary: "Send a test email to verify SMTP configuration (admin only)",
        response: {
          200: z.object({
            ok: z.boolean(),
            configured: z.boolean(),
            recipient: z.string().optional(),
            messageId: z.string().optional(),
            error: z.string().optional(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const transport = getTransport();
      if (!transport) {
        return {
          ok: false,
          configured: false,
          error:
            "SMTP is not configured — set SMTP_HOST, SMTP_USER, and SMTP_PASS " +
            "in the environment to enable outbound email",
        };
      }

      const recipient = env.SMTP_USER ?? "unknown";
      try {
        const info = await sendMail({
          to: recipient,
          subject: "[Temple TV] SMTP test — configuration verified",
          html: `
            <p>This is a test email sent from the Temple TV admin dashboard.</p>
            <p>If you received this, your SMTP configuration is working correctly.</p>
            <p style="color:#888;font-size:12px;">Sent at: ${new Date().toISOString()}</p>
          `.trim(),
          text:
            "This is a test email sent from the Temple TV admin dashboard.\n" +
            "If you received this, your SMTP configuration is working correctly.\n" +
            `Sent at: ${new Date().toISOString()}`,
        });
        return {
          ok: true,
          configured: true,
          recipient,
          messageId: (info as { messageId?: string } | null)?.messageId,
        };
      } catch (err) {
        // resetTransport() is already called inside sendMail() on EAUTH/ECONNREFUSED
        // errors. Surfacing the error here gives the admin immediate feedback in the UI.
        return {
          ok: false,
          configured: true,
          recipient,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  r.post(
    "/send",
    {
      preHandler: requireAuth("editor"),
      // Tighter rate limit on the send fan-out to protect against
      // accidental spam (a stuck UI re-submitting on every focus event)
      // or a compromised editor account. Falls back to the default
      // global limit if the per-route plugin is disabled.
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_AUTH_PER_MINUTE,
          timeWindow: "1 minute",
        },
      },
      schema: {
        tags: ["notifications"],
        summary: "Queue a push notification for all subscribers",
        body: SendPushBodySchema,
        response: { 201: SendPushResponseSchema, 200: SendPushResponseSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      // Header takes precedence over body field — matches the
      // RFC draft for `Idempotency-Key` and is what most HTTP clients
      // (including fetch retry shims) set automatically.
      const headerKey = req.headers["idempotency-key"];
      const idempotencyKey =
        (typeof headerKey === "string" && headerKey.length > 0
          ? headerKey
          : Array.isArray(headerKey) && headerKey[0]
            ? headerKey[0]
            : undefined) ?? req.body.idempotencyKey;

      const created = await notificationsService.sendPush({
        ...req.body,
        idempotencyKey,
      });

      // Distinguish "we created it now" (201) from "we already had it
      // and are returning it" (200) — the standard idempotent semantics.
      reply.code(created.deduplicated ? 200 : 201);
      return created;
    },
  );
}
