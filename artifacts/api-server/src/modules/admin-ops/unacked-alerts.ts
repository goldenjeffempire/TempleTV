/**
 * Unacknowledged-alert escalation store.
 *
 * Listens to the admin SSE event bus for `ops-alert` events and records them
 * in an in-memory store.  A periodic sweeper escalates any alert that has
 * been pending (un-cleared) for more than ESCALATION_DELAY_MS (10 min) by
 * sending an email to the configured admin address.
 *
 * The GET /admin/ops-alerts/unacked endpoint allows the admin SPA to display
 * pending alerts and acknowledge (clear) them — after which the email is no
 * longer sent for that alert.
 *
 * Design notes:
 *  • In-memory only: intentionally ephemeral.  On restart the slate is clean.
 *    This avoids a DB migration and is acceptable because the ops dashboard
 *    is real-time and server restarts clear the alert condition anyway.
 *  • Email cooldown (5 min) prevents alert storms from flooding the inbox.
 *  • stopUnackedAlertSweeper() is called on graceful shutdown.
 */

import { adminEventBus } from "./admin-event-bus.js";
import { sendMail } from "../../infrastructure/mailer.js";
import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";

const ESCALATION_DELAY_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS   = 60_000;
const EMAIL_COOLDOWN_MS   = 5 * 60_000;

export interface UnackedAlert {
  id: string;
  level: string;
  message: string;
  receivedAtMs: number;
  emailedAtMs: number | null;
}

const store = new Map<string, UnackedAlert>();
let sweepTimer: NodeJS.Timeout | null = null;
let emailCooldownUntilMs = 0;

function handleEvent(payload: unknown): void {
  const p = payload as { type?: string; data?: unknown } | null;
  if (!p || p.type !== "ops-alert") return;
  const d = (p.data && typeof p.data === "object" ? p.data : {}) as Record<string, unknown>;
  const id = String(
    d.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  const level   = String(d.level   ?? "warn");
  const message = String(d.message ?? "System alert");
  if (!store.has(id)) {
    store.set(id, { id, level, message, receivedAtMs: Date.now(), emailedAtMs: null });
  }
}

async function sweep(): Promise<void> {
  const now = Date.now();
  const pending = Array.from(store.values()).filter(
    (a) => a.emailedAtMs === null && now - a.receivedAtMs >= ESCALATION_DELAY_MS,
  );
  if (pending.length === 0) return;
  if (now < emailCooldownUntilMs) {
    logger.debug({ count: pending.length }, "[unacked-alerts] escalation pending — email on cooldown");
    return;
  }

  const alertTo = env.SMTP_USER;
  if (!alertTo || !env.SMTP_HOST) {
    logger.warn(
      { count: pending.length },
      "[unacked-alerts] escalation threshold reached but SMTP not configured — marking emailed to suppress repeat logs",
    );
    for (const a of pending) a.emailedAtMs = now;
    return;
  }

  const criticals = pending.filter((a) => a.level === "critical");
  const subject   = criticals.length > 0
    ? `[TempleTV] ${criticals.length} CRITICAL ops alert(s) unacknowledged >10 min`
    : `[TempleTV] ${pending.length} ops alert(s) unacknowledged >10 min`;

  const bullets = pending
    .map(
      (a) =>
        `• [${a.level.toUpperCase()}] ${a.message} (received ${new Date(a.receivedAtMs).toISOString()})`,
    )
    .join("\n");

  const html = [
    "<p>The following ops alerts have not been acknowledged for more than 10 minutes.</p>",
    "<ul>",
    ...pending.map(
      (a) =>
        `<li><strong>[${a.level.toUpperCase()}]</strong> ${a.message} <em>(${new Date(a.receivedAtMs).toISOString()})</em></li>`,
    ),
    "</ul>",
    "<p>Please review and acknowledge them in the Temple TV admin console (Master Control → Ops Alerts).</p>",
  ].join("");

  try {
    await sendMail({
      to: alertTo,
      subject,
      text: `${subject}\n\n${bullets}\n\nPlease review in the Temple TV admin console.`,
      html,
    });
    emailCooldownUntilMs = now + EMAIL_COOLDOWN_MS;
    for (const a of pending) a.emailedAtMs = now;
    logger.info(
      { count: pending.length, criticals: criticals.length, to: alertTo },
      "[unacked-alerts] escalation email sent",
    );
  } catch (err) {
    logger.warn({ err }, "[unacked-alerts] escalation email failed (non-fatal)");
  }
}

export function startUnackedAlertSweeper(): void {
  adminEventBus.on("admin-event", handleEvent);
  sweepTimer = setInterval(() => {
    void sweep().catch((err) =>
      logger.warn({ err }, "[unacked-alerts] sweep error (non-fatal)"),
    );
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  logger.info(
    { escalationDelayMs: ESCALATION_DELAY_MS, emailCooldownMs: EMAIL_COOLDOWN_MS },
    "[unacked-alerts] sweeper started — alerts escalated to email after 10 min unacknowledged",
  );
}

export function stopUnackedAlertSweeper(): void {
  adminEventBus.off("admin-event", handleEvent);
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function acknowledgeAlert(id: string): boolean {
  return store.delete(id);
}

export function acknowledgeAll(): void {
  store.clear();
}

export function getUnackedAlerts(): UnackedAlert[] {
  return Array.from(store.values()).sort((a, b) => b.receivedAtMs - a.receivedAtMs);
}
