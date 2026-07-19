/**
 * OTA Update Routes
 *
 * Provides admin-triggered Expo EAS Over-The-Air update dispatch via the
 * GitHub Actions workflow_dispatch API and EAS update history via the
 * Expo GraphQL API.
 *
 * Admin (admin role):
 *   GET  /admin/ota/status   — EAS config health + recent updates per channel
 *   POST /admin/ota/publish  — dispatch the ota-update.yml workflow
 */
import type { FastifyInstance } from "fastify";
export declare function otaRoutes(app: FastifyInstance): Promise<void>;
