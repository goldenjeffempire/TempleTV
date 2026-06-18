/**
 * Queue Exhaustion Monitor
 *
 * Polls the broadcast queue every EXHAUSTION_CHECK_INTERVAL_MS (default 60 s)
 * and computes the estimated "time to empty" — total remaining content
 * duration across all active queue items.
 *
 * Ops-alerts are emitted at two thresholds (each with a cooldown so we don't
 * spam the inbox):
 *   WARN    — timeToEmpty < QUEUE_WARN_MS   (default 2 h)
 *   CRITICAL — timeToEmpty < QUEUE_CRIT_MS  (default 15 min)
 *
 * Exposes getExhaustionStatus() for the /health endpoint and Prometheus gauge.
 */
import { db } from "../../../infrastructure/db.js";
import { sql } from "drizzle-orm";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import {
  queueTimeToEmptySeconds,
  queueExhaustionWarnTotal,
} from "../../../infrastructure/metrics.js";

const INTERVAL_MS = 60_000;
const WARN_MS = Number(process.env["QUEUE_WARN_MS"] ?? 2 * 60 * 60 * 1000);
const CRIT_MS = Number(process.env["QUEUE_CRIT_MS"] ?? 15 * 60 * 1000);
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

export interface ExhaustionStatus {
  timeToEmptyMs: number | null;
  timeToEmptyFmt: string | null;
  activeItemCount: number;
  level: "ok" | "warn" | "critical";
  lastCheckedAtMs: number | null;
  lastWarnAlertAtMs: number | null;
  lastCritAlertAtMs: number | null;
}

let _status: ExhaustionStatus = {
  timeToEmptyMs: null,
  timeToEmptyFmt: null,
  activeItemCount: 0,
  level: "ok",
  lastCheckedAtMs: null,
  lastWarnAlertAtMs: null,
  lastCritAlertAtMs: null,
};
let _timer: NodeJS.Timeout | null = null;

export function getExhaustionStatus(): ExhaustionStatus {
  return { ..._status };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function check(): Promise<void> {
  try {
    const rows = await db.execute<{ total_secs: string; cnt: string }>(sql`
      SELECT
        COALESCE(SUM(duration_secs), 0)::text AS total_secs,
        COUNT(*)::text AS cnt
      FROM broadcast_queue
      WHERE is_active = true
    `);
    const row = rows.rows?.[0] ?? rows[0];
    if (!row) return;

    const totalSecs = parseFloat(String(row.total_secs ?? "0"));
    const count = parseInt(String(row.cnt ?? "0"), 10);
    const timeToEmptyMs = totalSecs * 1000;

    const now = Date.now();
    let level: "ok" | "warn" | "critical" = "ok";

    if (timeToEmptyMs < CRIT_MS) {
      level = "critical";
      if (!_status.lastCritAlertAtMs || now - _status.lastCritAlertAtMs > ALERT_COOLDOWN_MS) {
        _status.lastCritAlertAtMs = now;
        queueExhaustionWarnTotal.inc({ level: "critical", service: "temple-tv-api", env: process.env["NODE_ENV"] ?? "development" });
        adminEventBus.push("ops-alert", {
          level: "critical",
          message: `Broadcast queue will exhaust in ${formatDuration(timeToEmptyMs)} (${count} active items). Auto-refill or operator action required immediately.`,
          context: { timeToEmptyMs, activeItemCount: count },
        });
        logger.error(
          { timeToEmptyMs, activeItemCount: count },
          "[queue-exhaustion] CRITICAL — queue exhausts in < 15 min",
        );
      }
    } else if (timeToEmptyMs < WARN_MS) {
      level = "warn";
      if (!_status.lastWarnAlertAtMs || now - _status.lastWarnAlertAtMs > ALERT_COOLDOWN_MS) {
        _status.lastWarnAlertAtMs = now;
        queueExhaustionWarnTotal.inc({ level: "warn", service: "temple-tv-api", env: process.env["NODE_ENV"] ?? "development" });
        adminEventBus.push("ops-alert", {
          level: "warn",
          message: `Broadcast queue running low — ${formatDuration(timeToEmptyMs)} of content remaining (${count} active items).`,
          context: { timeToEmptyMs, activeItemCount: count },
        });
        logger.warn(
          { timeToEmptyMs, activeItemCount: count },
          "[queue-exhaustion] WARN — queue exhausts in < 2 h",
        );
      }
    }

    queueTimeToEmptySeconds.set(
      { channel: "main", service: "temple-tv-api", env: process.env["NODE_ENV"] ?? "development" },
      totalSecs,
    );

    _status = {
      ..._status,
      timeToEmptyMs,
      timeToEmptyFmt: formatDuration(timeToEmptyMs),
      activeItemCount: count,
      level,
      lastCheckedAtMs: now,
    };
  } catch (err) {
    logger.warn({ err }, "[queue-exhaustion] check failed (non-fatal)");
  }
}

export function startExhaustionMonitor(): void {
  if (_timer) return;
  void check();
  _timer = setInterval(() => { void check(); }, INTERVAL_MS);
  _timer.unref?.();
  logger.info("[queue-exhaustion] monitor started");
}

export function stopExhaustionMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
