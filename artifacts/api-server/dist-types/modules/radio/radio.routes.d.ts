/**
 * Radio Station module — stores and serves live radio stream configuration.
 *
 * All config lives in the `app_config` key-value table under the `radio:*`
 * namespace. This means zero schema migrations are required to deploy the
 * radio feature — the table already exists and is designed for exactly
 * this kind of runtime flag storage.
 *
 * Public endpoint:
 *   GET  /api/radio        → streamUrl, title, description, isActive
 *   GET  /api/v1/radio     (dual-prefix; same handler)
 *
 * Admin endpoints (system / admin role required):
 *   GET  /api/admin/radio
 *   PATCH /api/admin/radio
 *   (and their /api/v1/admin/* counterparts via dual-prefix registration)
 */
import type { FastifyInstance } from "fastify";
export declare function radioRoutes(app: FastifyInstance): Promise<void>;
