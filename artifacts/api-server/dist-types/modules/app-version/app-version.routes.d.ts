/**
 * App Version Routes
 *
 * Public:
 *   GET  /app/version-check   — mobile clients check for available updates
 *
 * Admin (editor+):
 *   GET  /admin/app/versions              — list all version records
 *   POST /admin/app/versions              — create a new version record
 *   PATCH /admin/app/versions/:id         — update a version record
 *   DELETE /admin/app/versions/:id        — delete a version record
 *   POST /admin/app/versions/:id/send-notification  — push update alert to all users
 */
import type { FastifyInstance } from "fastify";
export declare function appVersionRoutes(app: FastifyInstance): Promise<void>;
