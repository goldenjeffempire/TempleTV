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
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { env } from "../../config/env.js";

const pushTokens = schema.pushTokensTable;
const webPush = schema.webPushSubscriptionsTable;

export async function pushRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Register an Expo push token. Called by `notifications.native.ts`
   * immediately after `Notifications.getExpoPushTokenAsync()` succeeds.
   *
   * Upsert semantics: if the token already exists, bump `last_seen_at` so
   * stale-token cleanup (tokens not seen in N days) doesn't prune active
   * devices. A newly-installed app gets a fresh row.
   */
  r.post(
    "/push-tokens",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["notifications"],
        summary: "Register an Expo push token for mobile push delivery",
        body: z.object({
          token: z.string().min(1).max(512),
          platform: z.enum(["ios", "android"]).default("android"),
        }),
        response: {
          200: z.object({ ok: z.literal(true), created: z.boolean() }),
        },
      },
    },
    async (req) => {
      const { token, platform } = req.body;
      const now = new Date();

      // Atomic upsert — replaces the previous SELECT-then-INSERT/UPDATE pattern
      // which had a TOCTOU race: two concurrent registrations for the same token
      // both read "not found", both attempt INSERT, one is silently dropped by
      // onConflictDoNothing and returns the wrong `created` value.
      // On conflict we also update platform so a re-install that switches from
      // Android→iOS (or vice-versa) gets the right channel.
      const [row] = await db
        .insert(pushTokens)
        .values({ id: nanoid(), token, platform, createdAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: pushTokens.token,
          set: { lastSeenAt: now, platform },
        })
        .returning({ createdAt: pushTokens.createdAt });

      // Insert path: createdAt === now (within clock jitter).
      // Update path: createdAt is the original registration timestamp, always older.
      const created = now.getTime() - row!.createdAt.getTime() < 2_000;
      return { ok: true as const, created };
    },
  );

  /**
   * Register a W3C PushSubscription from a browser service worker.
   * Called by `notifications.ts` (web) after `pushManager.subscribe()`.
   */
  r.post(
    "/push/web-subscriptions",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["notifications"],
        summary: "Register a Web Push subscription for browser push delivery",
        body: z.object({
          endpoint: z.string().url().max(2048),
          keys: z.object({
            p256dh: z.string().min(1).max(256),
            auth: z.string().min(1).max(64),
          }),
          userAgent: z.string().max(512).nullable().optional(),
        }),
        response: {
          200: z.object({ ok: z.literal(true), created: z.boolean() }),
        },
      },
    },
    async (req) => {
      const { endpoint, keys, userAgent } = req.body;
      const now = new Date();

      // Atomic upsert — same TOCTOU fix as the Expo token route above.
      // On conflict we update the crypto keys so a re-subscribed browser
      // (e.g. after clearing site data) gets fresh p256dh/auth values.
      const [row] = await db
        .insert(webPush)
        .values({
          id: nanoid(),
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: userAgent ?? null,
          createdAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: webPush.endpoint,
          set: { p256dh: keys.p256dh, auth: keys.auth, lastSeenAt: now },
        })
        .returning({ createdAt: webPush.createdAt });

      const created = now.getTime() - row!.createdAt.getTime() < 2_000;
      return { ok: true as const, created };
    },
  );

  /**
   * Expose the VAPID public key so the browser can call
   * `pushManager.subscribe({ applicationServerKey: ... })`.
   * Returns 503 if VAPID is not configured (avoids a cryptic failure
   * in the browser).
   */
  r.get(
    "/push/web-vapid-public-key",
    {
      schema: {
        tags: ["notifications"],
        summary: "Retrieve the VAPID public key for Web Push subscriptions",
        response: {
          200: z.object({ publicKey: z.string() }),
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (_req, reply) => {
      if (!env.VAPID_PUBLIC_KEY) {
        return reply.code(503).send({ error: "Web Push is not configured on this server" });
      }
      return { publicKey: env.VAPID_PUBLIC_KEY };
    },
  );
}
