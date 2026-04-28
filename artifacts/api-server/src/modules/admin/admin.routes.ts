import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  AdminStatsSchema,
  AdminUserSchema,
  AnalyticsSchema,
  ListUsersQuerySchema,
  ListUsersResponseSchema,
  UpdateUserRoleBodySchema,
} from "./admin.schemas.js";
import { adminService } from "./admin.service.js";

const idParam = z.object({ id: z.string().min(1) });

export async function adminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/stats",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Aggregate dashboard counts (videos, users, queue, schedule)",
        response: { 200: AdminStatsSchema },
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

  r.patch(
    "/users/:id/role",
    {
      preHandler: requireAuth("admin"),
      schema: {
        tags: ["admin"],
        summary: "Update a user's role",
        params: idParam,
        body: UpdateUserRoleBodySchema,
        response: { 200: AdminUserSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => adminService.updateUserRole(req.params.id, req.body),
  );
}
