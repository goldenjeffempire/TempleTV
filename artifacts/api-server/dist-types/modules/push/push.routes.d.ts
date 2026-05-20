/**
 * Push token registration and Web Push subscription management routes.
 *
 * Clients call these endpoints to register for push notifications:
 *   POST /push-tokens                — Expo push token (iOS / Android)
 *   POST /push/web-subscriptions     — W3C PushSubscription (browser)
 *   GET  /push/web-vapid-public-key  — VAPID public key for subscription setup
 *
 * Note: Mobile's `notifications.native.ts` posts to `/api/push-tokens`
 * (no `/push/` prefix). Both paths are registered by mounting this plugin
 * under the domain prefix `/api` in app.ts with no sub-prefix, then
 * defining the route as `/push-tokens`. The web subscription routes use
 * `/push/web-subscriptions` and `/push/web-vapid-public-key` to match
 * `notifications.ts` on the web client.
 */
import type { FastifyInstance } from "fastify";
export declare function pushRoutes(app: FastifyInstance): Promise<void>;
