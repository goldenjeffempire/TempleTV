import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middleware/auth.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  AdminStatsSchema,
  AdminUserSchema,
  AnalyticsOverviewSchema,
  AnalyticsSchema,
  ConcurrentViewersSchema,
  DailyPlatformTrendsSchema,
  ListUsersQuerySchema,
  ListUsersResponseSchema,
  UpdateUserRoleBodySchema,
} from "./admin.schemas.js";
import { adminService } from "./admin.service.js";
import { db, schema } from "../../infrastructure/db.js";

const idParam = z.object({ id: z.string().min(1) });

export async function adminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/stats",
    {
      preHandler: requireAuth("editor"),
      // /stats fans out into 8+ COUNT(*) queries against the largest tables.
      // The 30s in-process cache absorbs most reads, but a polling tab loop
      // (admin dashboard) can still drive cache misses on every TTL boundary.
      // 60/min is enough for a 1-second poller plus a few simultaneous tabs;
      // beyond that the cache is doing its job and there is no reason to
      // touch the DB. (P2 fix)
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Aggregate dashboard counts (videos, users, queue, schedule)",
        response: { 200: AdminStatsSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => adminService.getStats(),
  );

  r.get(
    "/analytics",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Top videos by view count and total views",
        response: { 200: AnalyticsSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => adminService.getAnalytics(),
  );

  r.get(
    "/analytics/overview",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary:
          "Rich analytics overview: daily view time-series, platform breakdown, session engagement metrics",
        querystring: z.object({
          range: z.enum(["7d", "30d", "90d"]).default("30d"),
        }),
        response: { 200: AnalyticsOverviewSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => adminService.getAnalyticsOverview(req.query.range),
  );

  r.get(
    "/analytics/concurrent",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Concurrent viewer count time-series with per-platform breakdown and peak detection",
        querystring: z.object({
          range: z.enum(["7d", "30d", "90d"]).default("7d"),
        }),
        response: { 200: ConcurrentViewersSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => adminService.getConcurrentViewers(req.query.range),
  );

  r.get(
    "/analytics/platform-trends",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Daily session counts broken down by platform (TV / mobile / web)",
        querystring: z.object({
          range: z.enum(["7d", "30d", "90d"]).default("30d"),
        }),
        response: { 200: DailyPlatformTrendsSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => adminService.getDailyPlatformTrends(req.query.range),
  );

  r.delete(
    "/users/:id",
    {
      preHandler: requireAuth("admin"),
      // Hard-deletes user + all PII. 5/min prevents bulk account wipes via
      // a compromised admin token — each delete should be a deliberate act.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        tags: ["admin"],
        summary: "Permanently delete a user account and all associated data",
        params: idParam,
        response: {
          200: z.object({ deleted: z.literal(true), id: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      // Prevent admins from deleting their own account — doing so would
      // immediately revoke their session and leave the platform without an admin
      // if they are the last one. The action is irreversible from the UI.
      if (req.params.id === req.principal?.id) {
        throw new ForbiddenError("You cannot delete your own account");
      }
      const result = await adminService.deleteUser(req.params.id);
      req.log.warn(
        {
          by: req.principal?.id ?? "unknown",
          byEmail: req.principal?.email ?? "unknown",
          targetUserId: req.params.id,
        },
        "[rbac-audit] user deleted",
      );
      return result;
    },
  );

  r.get(
    "/users",
    {
      preHandler: requireAuth("admin"),
      schema: {
        tags: ["admin"],
        summary: "List all users",
        querystring: ListUsersQuerySchema,
        response: { 200: ListUsersResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => adminService.listUsers(req.query),
  );

  r.post(
    "/users/:id/ban",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        tags: ["admin"],
        summary: "Ban a user from chat (creates indefinite chat_moderation ban record)",
        params: idParam,
        body: z.object({
          reason: z.string().max(500).optional(),
          durationSecs: z.number().int().positive().nullable().optional(),
        }).optional(),
        response: {
          200: z.object({
            ok: z.literal(true),
            userId: z.string(),
            action: z.literal("ban"),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id: userId } = req.params;
      const body = req.body ?? {};

      // Privilege-escalation guard: editors may not ban admins or system accounts.
      // Only admins can moderate other admins. Fetch the target's role first.
      const [targetUser] = await db
        .select({ role: schema.usersTable.role })
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, userId))
        .limit(1);
      if (!targetUser) throw new NotFoundError("User not found");
      const callerRank = { system: 4, admin: 3, editor: 2, moderator: 1, user: 0 } as Record<string, number>;
      const callerRole = req.principal?.role ?? "user";
      if ((callerRank[targetUser.role] ?? 0) >= (callerRank[callerRole] ?? 0)) {
        throw new ForbiddenError("You cannot ban a user with equal or higher privileges");
      }

      const expiresAt =
        body.durationSecs && body.durationSecs > 0
          ? new Date(Date.now() + body.durationSecs * 1000)
          : null;
      await db
        .insert(schema.chatModerationTable)
        .values({
          id: nanoid(),
          subjectKind: "user",
          subjectId: userId,
          action: "ban",
          reason: body.reason ?? null,
          expiresAt,
          createdBy: req.principal?.id ?? null,
        });
      req.log.info(
        { by: req.principal?.id ?? "unknown", targetUserId: userId },
        "[chat-mod-audit] user banned",
      );
      return { ok: true as const, userId, action: "ban" as const };
    },
  );

  r.patch(
    "/users/:id/role",
    {
      preHandler: requireAuth("admin"),
      // Role escalation to admin/system is high privilege. 10/min is ample
      // for legitimate use while blocking automated privilege-escalation loops.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      bodyLimit: 1 * 1024 * 1024,
      schema: {
        tags: ["admin"],
        summary: "Update a user's role",
        params: idParam,
        body: UpdateUserRoleBodySchema,
        response: { 200: AdminUserSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      // Prevent self-demotion — an admin demoting themselves could immediately
      // lose access to the admin panel, locking themselves out with no recourse.
      if (req.params.id === req.principal?.id) {
        throw new ForbiddenError("You cannot change your own role");
      }
      const result = await adminService.updateUserRole(req.params.id, req.body);
      req.log.info(
        {
          by: req.principal?.id ?? "unknown",
          byEmail: req.principal?.email ?? "unknown",
          targetUserId: req.params.id,
          newRole: req.body.role,
        },
        "[rbac-audit] user role updated",
      );
      return result;
    },
  );
}
