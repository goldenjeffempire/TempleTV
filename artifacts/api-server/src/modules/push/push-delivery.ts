/**
 * Push Delivery Service
 *
 * Handles actual delivery of push notifications to:
 *   • Expo Push Notification Service → iOS (APNs) + Android (FCM)
 *   • W3C Web Push API               → browser service workers
 *
 * Called by `notificationsService.sendPush()` as a fire-and-forget
 * background task after the audit row is written. All errors are caught
 * and logged — a delivery failure must never crash the HTTP handler or
 * block the response.
 *
 * Retry policy (Expo path):
 *   Transient failures (network timeouts, Expo API 5xx) are retried up
 *   to MAX_CHUNK_RETRIES times with exponential backoff (1 s, 5 s, 30 s).
 *   Permanent failures (DeviceNotRegistered, InvalidCredentials) are never
 *   retried — they trigger immediate stale-token cleanup instead. A chunk
 *   that exhausts its retry budget is logged as an error and skipped; the
 *   remaining chunks still proceed, so one bad chunk never kills the batch.
 *
 * Stale token cleanup:
 *   Expo returns `DeviceNotRegistered` when a token has been revoked or
 *   the app is uninstalled. We hard-delete those tokens from `push_tokens`
 *   so the recipient count stays accurate on subsequent sends.
 *
 *   Web Push returns 410 (Gone) for expired subscriptions. We hard-delete
 *   those from `web_push_subscriptions` for the same reason.
 */

import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import webpush from "web-push";
import { eq, gt, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

// `useFcmV1` was added in expo-server-sdk v1.x but may not appear in older
// @types — cast to silence the unknown-property error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expo = new Expo({ useFcmV1: true } as any);

let vapidInitialized = false;

function ensureVapid(): boolean {
  if (vapidInitialized) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    env.VAPID_MAILTO ?? "mailto:admin@templetv.org.ng",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  vapidInitialized = true;
  return true;
}

export interface PushPayload {
  notificationId: string;
  title: string;
  body: string;
  type: string;
  videoId?: string | null;
}

// ── Expo chunk retry ─────────────────────────────────────────────────────────
// Backoff delays in ms: 1 s, 5 s, 30 s (3 total attempts after the first).
const CHUNK_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const MAX_CHUNK_RETRIES = CHUNK_RETRY_DELAYS_MS.length;

/**
 * Classify an error thrown by `expo.sendPushNotificationsAsync()` as
 * retriable (transient network / server issue) or terminal (auth, SDK bug,
 * invalid message shape). Transient errors get retried with backoff;
 * terminal errors are logged and the chunk is abandoned immediately.
 */
function isTransientExpoError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // expo-server-sdk throws objects with a `statusCode` for HTTP errors.
  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === "number") {
    // 5xx: Expo server-side problem → retriable
    if (status >= 500 && status < 600) return true;
    // 429: rate-limited → retriable
    if (status === 429) return true;
    // 4xx (except 429): client error → not retriable
    return false;
  }
  // Network / DNS / timeout errors surface as `Error` with no statusCode.
  // These are transient by nature.
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("socket") ||
      msg.includes("fetch") ||
      msg.includes("enotfound")
    );
  }
  return false;
}

/**
 * Send one Expo chunk with automatic retry on transient failures.
 * Returns the ticket array on success or throws on permanent failure /
 * exhausted retry budget.
 */
async function sendChunkWithRetry(chunk: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    try {
      return await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      lastErr = err;
      // Never retry permanent errors — bail out immediately.
      if (!isTransientExpoError(err)) throw err;
      if (attempt === MAX_CHUNK_RETRIES) break;
      const delayMs = CHUNK_RETRY_DELAYS_MS[attempt]!;
      logger.warn(
        { err, attempt: attempt + 1, maxAttempts: MAX_CHUNK_RETRIES + 1, retryAfterMs: delayMs },
        "[push-delivery] expo chunk send failed (transient) — retrying",
      );
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, delayMs); t.unref?.(); });
    }
  }
  throw lastErr;
}

/**
 * Deliver `payload` to all registered Expo push tokens.
 * Returns the number of tokens successfully dispatched.
 *
 * Tokens are loaded in pages of PUSH_PAGE_SIZE to avoid a single enormous
 * heap allocation that would OOM Node.js when the subscriber list is large
 * (100k+ tokens). Each page is messaged, chunked, and delivered before the
 * next page is fetched so peak memory is bounded to O(PUSH_PAGE_SIZE).
 * Stale tokens discovered per-page are pruned immediately after that page.
 */
const PUSH_PAGE_SIZE = 500;

async function deliverToExpo(payload: PushPayload): Promise<number> {
  let totalDispatched = 0;
  let lastId = "";

  for (;;) {
    const page = await db
      .select({ id: schema.pushTokensTable.id, token: schema.pushTokensTable.token })
      .from(schema.pushTokensTable)
      .where(lastId ? gt(schema.pushTokensTable.id, lastId) : undefined)
      .orderBy(schema.pushTokensTable.id)
      .limit(PUSH_PAGE_SIZE);

    if (page.length === 0) break;
    lastId = page[page.length - 1]!.id;

    const messages: ExpoPushMessage[] = page
      .filter((t) => Expo.isExpoPushToken(t.token))
      .map((t) => ({
        to: t.token,
        sound: "default" as const,
        title: payload.title,
        body: payload.body,
        data: {
          type: payload.type,
          notificationId: payload.notificationId,
          ...(payload.videoId ? { videoId: payload.videoId } : {}),
        },
        channelId: "temple-tv-default",
        priority: "high" as const,
      }));

    if (messages.length > 0) {
      const chunks = expo.chunkPushNotifications(messages);
      const staleIds: string[] = [];
      let dispatched = 0;

      for (const chunk of chunks) {
        try {
          const receipts = await sendChunkWithRetry(chunk);
          for (let i = 0; i < receipts.length; i++) {
            const receipt = receipts[i]!;
            if (receipt.status === "ok") {
              dispatched++;
            } else if (
              receipt.details?.error === "DeviceNotRegistered" ||
              receipt.details?.error === "InvalidCredentials"
            ) {
              const chunkMsg = chunk[i];
              if (chunkMsg) {
                const targetToken = Array.isArray(chunkMsg.to) ? chunkMsg.to[0] : chunkMsg.to;
                const match = page.find((t) => t.token === targetToken);
                if (match) staleIds.push(match.id);
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, chunkSize: chunk.length },
            "[push-delivery] expo chunk permanently failed after retries — skipping chunk",
          );
        }
      }

      if (staleIds.length > 0) {
        await db
          .delete(schema.pushTokensTable)
          .where(inArray(schema.pushTokensTable.id, staleIds))
          .catch((err) => logger.warn({ err, staleIds }, "[push-delivery] stale expo token cleanup failed"));
        logger.info({ count: staleIds.length }, "[push-delivery] pruned stale Expo tokens");
      }

      totalDispatched += dispatched;
    }

    if (page.length < PUSH_PAGE_SIZE) break;
  }

  return totalDispatched;
}

/**
 * Deliver `payload` to all registered Web Push subscriptions.
 * Returns the number of subscriptions successfully dispatched.
 *
 * Subscriptions are loaded in pages of PUSH_PAGE_SIZE (keyset pagination on
 * id) so peak heap is O(PUSH_PAGE_SIZE) regardless of subscriber count.
 * Within each page, sends are fanned out in parallel chunks of
 * WEB_PUSH_CHUNK_SIZE to cap OS socket pressure. Stale subs found in a page
 * are pruned before the next page is fetched.
 */
async function deliverToWebPush(payload: PushPayload): Promise<number> {
  if (!ensureVapid()) {
    logger.warn("[push-delivery] VAPID keys not configured — web push disabled; set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY to enable");
    return 0;
  }

  const webPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    type: payload.type,
    notificationId: payload.notificationId,
    ...(payload.videoId ? { videoId: payload.videoId } : {}),
    icon: "/icons/icon-192x192.png",
    badge: "/icons/badge-72x72.png",
  });

  // Retry policy: 410/404 = stale (permanent) → prune; anything else → retry.
  const WEB_PUSH_MAX_RETRIES = 3;
  const WEB_PUSH_BACKOFF_MS = [1_000, 5_000, 30_000];
  const WEB_PUSH_CHUNK_SIZE = 100;

  let totalDispatched = 0;
  let lastId = "";

  for (;;) {
    const page = await db
      .select()
      .from(schema.webPushSubscriptionsTable)
      .where(lastId ? gt(schema.webPushSubscriptionsTable.id, lastId) : undefined)
      .orderBy(schema.webPushSubscriptionsTable.id)
      .limit(PUSH_PAGE_SIZE);

    if (page.length === 0) break;
    lastId = page[page.length - 1]!.id;

    const staleIds: string[] = [];
    let dispatched = 0;

    for (let i = 0; i < page.length; i += WEB_PUSH_CHUNK_SIZE) {
      const chunk = page.slice(i, i + WEB_PUSH_CHUNK_SIZE);
      await Promise.allSettled(
        chunk.map(async (sub) => {
          let lastErr: unknown;
          for (let attempt = 0; attempt <= WEB_PUSH_MAX_RETRIES; attempt++) {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                webPayload,
                { TTL: 86_400 },
              );
              dispatched++;
              return;
            } catch (err: unknown) {
              lastErr = err;
              const status = (err as { statusCode?: number }).statusCode;
              if (status === 410 || status === 404) {
                staleIds.push(sub.id);
                return;
              }
              if (attempt < WEB_PUSH_MAX_RETRIES) {
                await new Promise<void>((r) => { const t = setTimeout(r, WEB_PUSH_BACKOFF_MS[attempt]); t.unref?.(); });
              }
            }
          }
          logger.warn(
            { err: lastErr, endpoint: sub.endpoint },
            "[push-delivery] web push send failed after retries",
          );
        }),
      );
    }

    if (staleIds.length > 0) {
      await db
        .delete(schema.webPushSubscriptionsTable)
        .where(inArray(schema.webPushSubscriptionsTable.id, staleIds))
        .catch((err) => logger.warn({ err }, "[push-delivery] stale web-push cleanup failed"));
      logger.info({ count: staleIds.length }, "[push-delivery] pruned stale Web Push subscriptions");
    }

    totalDispatched += dispatched;
    if (page.length < PUSH_PAGE_SIZE) break;
  }

  return totalDispatched;
}

/**
 * Fire-and-forget entry point. Call this after writing the audit row.
 * All errors are caught — a delivery failure never propagates to the caller.
 */
export async function deliverPushNotification(payload: PushPayload): Promise<void> {
  try {
    const [expoCount, webCount] = await Promise.all([
      deliverToExpo(payload),
      deliverToWebPush(payload),
    ]);
    logger.info(
      { notificationId: payload.notificationId, expoCount, webCount, total: expoCount + webCount },
      "[push-delivery] push delivery complete",
    );
    await db
      .update(schema.notificationsTable)
      .set({
        status: "sent",
        sentCount: expoCount + webCount,
        // Increment atomically rather than hardcoding 1 — this function may be
        // called after the scheduled dispatcher has already incremented attempts
        // on earlier failed attempts, so overwriting with 1 would lose that history.
        attempts: sql`${schema.notificationsTable.attempts} + 1`,
      })
      .where(eq(schema.notificationsTable.id, payload.notificationId));
  } catch (err) {
    logger.error({ err, notificationId: payload.notificationId }, "[push-delivery] delivery failed");
    await db
      .update(schema.notificationsTable)
      .set({
        status: "failed",
        lastError: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        attempts: sql`${schema.notificationsTable.attempts} + 1`,
      })
      .where(eq(schema.notificationsTable.id, payload.notificationId))
      .catch(() => { /* best effort */ });
  }
}
