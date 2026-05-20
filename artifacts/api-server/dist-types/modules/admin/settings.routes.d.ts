/**
 * Admin System Settings — read/write the app_config key-value store.
 *
 * Routes:
 *   GET  /admin/system-settings          — list all config keys
 *   PUT  /admin/system-settings          — upsert a key-value pair
 *   DELETE /admin/system-settings/:key   — remove a config key
 *
 * The app_config table is a generic k/v store for runtime flags,
 * feature toggles, SMTP settings, broadcast metadata, etc.
 * All values are stored as text; the admin UI handles type coercion.
 */
import type { FastifyInstance } from "fastify";
export declare function settingsRoutes(app: FastifyInstance): Promise<void>;
