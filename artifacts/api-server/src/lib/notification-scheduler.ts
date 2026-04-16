import { db, scheduledNotificationsTable, notificationsTable, pushTokensTable } from "@workspace/db";
import { eq, and, lte } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "./logger";

async function sendToExpo(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  const CHUNK = 100;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const messages = chunk.map((token) => ({ to: token, title, body, data, sound: "default" }));

    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      failed += chunk.length;
      continue;
    }

    const json = (await res.json()) as { data: { status: string }[] };
    for (const item of json.data ?? []) {
      if (item.status === "ok") sent++;
      else failed++;
    }
  }

  return { sent, failed };
}

let running = false;

async function processDueNotifications() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const due = await db
      .select()
      .from(scheduledNotificationsTable)
      .where(
        and(
          eq(scheduledNotificationsTable.status, "pending"),
          lte(scheduledNotificationsTable.scheduledAt, now),
        ),
      );

    if (due.length === 0) return;

    const tokenRows = await db.select({ token: pushTokensTable.token }).from(pushTokensTable);
    const tokens = tokenRows.map((r) => r.token);

    for (const notif of due) {
      try {
        const { sent, failed } = await sendToExpo(tokens, notif.title, notif.body, {
          type: notif.type,
          ...(notif.videoId ? { videoId: notif.videoId } : {}),
        });

        await db
          .update(scheduledNotificationsTable)
          .set({ status: "sent", sentCount: sent, sentAt: new Date() })
          .where(eq(scheduledNotificationsTable.id, notif.id));

        await db.insert(notificationsTable).values({
          id: randomUUID(),
          title: notif.title,
          body: notif.body,
          type: notif.type,
          videoId: notif.videoId ?? null,
          sentCount: sent,
        });

        logger.info({ id: notif.id, sent, failed }, "Scheduled notification dispatched");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db
          .update(scheduledNotificationsTable)
          .set({ status: "failed", errorMessage: msg })
          .where(eq(scheduledNotificationsTable.id, notif.id));
        logger.error({ id: notif.id, err }, "Failed to dispatch scheduled notification");
      }
    }
  } finally {
    running = false;
  }
}

export function startNotificationScheduler() {
  logger.info("Notification scheduler started (30s interval)");
  processDueNotifications().catch((err) => logger.error({ err }, "Scheduler error on startup"));
  setInterval(() => {
    processDueNotifications().catch((err) => logger.error({ err }, "Scheduler error"));
  }, 30_000);
}
