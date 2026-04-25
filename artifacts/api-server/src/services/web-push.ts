import webpush from "web-push";
import { db, appConfigTable, webPushSubscriptionsTable, type WebPushSubscription } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const VAPID_PUBLIC_KEY = "vapid_public_key";
const VAPID_PRIVATE_KEY = "vapid_private_key";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT?.trim() || "mailto:admin@temple.tv";

let cached: { publicKey: string; privateKey: string } | null = null;

async function readKey(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: appConfigTable.value })
    .from(appConfigTable)
    .where(eq(appConfigTable.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function writeKey(key: string, value: string): Promise<void> {
  await db
    .insert(appConfigTable)
    .values({ key, value })
    .onConflictDoNothing({ target: appConfigTable.key });
}

export async function ensureVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (cached) return cached;

  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) {
    cached = { publicKey: envPublic, privateKey: envPrivate };
    webpush.setVapidDetails(VAPID_SUBJECT, cached.publicKey, cached.privateKey);
    return cached;
  }

  const [storedPublic, storedPrivate] = await Promise.all([
    readKey(VAPID_PUBLIC_KEY),
    readKey(VAPID_PRIVATE_KEY),
  ]);
  if (storedPublic && storedPrivate) {
    cached = { publicKey: storedPublic, privateKey: storedPrivate };
    webpush.setVapidDetails(VAPID_SUBJECT, cached.publicKey, cached.privateKey);
    return cached;
  }

  const generated = webpush.generateVAPIDKeys();
  await Promise.all([
    writeKey(VAPID_PUBLIC_KEY, generated.publicKey),
    writeKey(VAPID_PRIVATE_KEY, generated.privateKey),
  ]);
  cached = generated;
  webpush.setVapidDetails(VAPID_SUBJECT, cached.publicKey, cached.privateKey);
  logger.info({ publicKey: generated.publicKey }, "Generated and persisted new VAPID keys");
  return cached;
}

export async function getVapidPublicKey(): Promise<string> {
  const { publicKey } = await ensureVapidKeys();
  return publicKey;
}

export interface WebPushSendResult {
  sent: number;
  failed: number;
  removed: number;
}

export async function sendWebPushNotifications(
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<WebPushSendResult> {
  await ensureVapidKeys();

  const subs = await db.select().from(webPushSubscriptionsTable);
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0 };

  const payload = JSON.stringify({ title, body, data });
  let sent = 0;
  let failed = 0;
  const expiredEndpoints: string[] = [];

  await Promise.all(
    subs.map(async (sub: WebPushSubscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          expiredEndpoints.push(sub.endpoint);
        } else {
          failed += 1;
          logger.warn({ err, endpoint: sub.endpoint }, "Web push send failed");
        }
      }
    }),
  );

  if (expiredEndpoints.length > 0) {
    await db
      .delete(webPushSubscriptionsTable)
      .where(inArray(webPushSubscriptionsTable.endpoint, expiredEndpoints));
  }

  return { sent, failed, removed: expiredEndpoints.length };
}
