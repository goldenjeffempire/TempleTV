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
 * Override-aware suppression: when a broadcast override is active (manual
 * YouTube/HLS/RTMP override OR the YouTube shuffle fallback), alerts are
 * downgraded from CRITICAL → INFO and from WARN → INFO so we don't flood
 * the ops inbox with false-positive exhaustion noise while the channel is
 * legitimately ON AIR via the override path.  The queue level is still
 * tracked and available in getExhaustionStatus() for the /health endpoint.
 *
 * Boot-time race protection: the initial check is intentionally deferred by
 * INITIAL_CHECK_DELAY_MS (default 90 s) so the orchestrator has enough time
 * to boot, hydrate its state from the DB, and activate the YouTube shuffle
 * fallback if needed.  A premature CRITICAL alert during the first ~30 s of
 * startup (before ytShuffleFallback activates) is a false positive and causes
 * unnecessary alert fatigue.
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
/**
 * Delay the very first exhaustion check so the orchestrator has time to boot
 * and activate ytShuffleFallback before we evaluate the queue state.
 * Without this guard a CRITICAL fires every restart for ~30 s until the
 * shuffle fallback warms up — pure alert fatigue.
 */
const INITIAL_CHECK_DELAY_MS = 90_000;

export interface ExhaustionStatus {
  timeToEmptyMs: number | null;
  timeToEmptyFmt: string | null;
  activeItemCount: number;
  level: "ok" | "warn" | "critical";
  lastCheckedAtMs: number | null;
  lastWarnAlertAtMs: number | null;
  lastCritAlertAtMs: number | null;
  /** True when an override is suppressing exhaustion alerts. */
  overrideSuppressed: boolean;
  overrideKind: string | null;
  overrideTitle: string | null;
}

let _status: ExhaustionStatus = {
  timeToEmptyMs: null,
  timeToEmptyFmt: null,
  activeItemCount: 0,
  level: "ok",
  lastCheckedAtMs: null,
  lastWarnAlertAtMs: null,
  lastCritAlertAtMs: null,
  overrideSuppressed: false,
  overrideKind: null,
  overrideTitle: null,
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

/**
 * Lazily queries the orchestrator and ytShuffleFallback singleton for the
 * current broadcast state.  Uses dynamic imports to avoid circular dependencies
 * since the orchestrator imports many engine modules including this one.
 *
 * Returns null if the module is not yet importable (extremely early boot).
 * Returns `{ orchestratorStarted: false }` before the first `start()` call.
 */
async function getBroadcastContext(): Promise<{
  orchestratorStarted: boolean;
  override: { kind: string; title: string; endsAtMs: number | null; isYtShuffle: boolean } | null;
  ytShuffleActive: boolean;
} | null> {
  try {
    const [{ broadcastOrchestrator }, { ytShuffleFallback }] = await Promise.all([
      import("../index.js"),
      import("./youtube-shuffle-fallback.js"),
    ]);
    return {
      orchestratorStarted: broadcastOrchestrator.isStarted(),
      override: broadcastOrchestrator.getOverrideState(),
      ytShuffleActive: ytShuffleFallback.isActive,
    };
  } catch {
    return null;
  }
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
    const row = rows.rows?.[0];
    if (!row) return;

    const totalSecs = parseFloat(String(row.total_secs ?? "0"));
    const count = parseInt(String(row.cnt ?? "0"), 10);
    const timeToEmptyMs = totalSecs * 1000;

    const now = Date.now();
    let level: "ok" | "warn" | "critical" = "ok";

    // Resolve current broadcast context before deciding whether to fire alerts.
    const ctx = await getBroadcastContext();

    // Suppress all alerts when the orchestrator hasn't finished booting yet.
    // The self-heal loop needs ~30 s to activate ytShuffleFallback on a
    // YouTube-only deployment — firing CRITICAL before that is a false positive.
    if (ctx && !ctx.orchestratorStarted) {
      logger.debug(
        { timeToEmptyMs, activeItemCount: count },
        "[queue-exhaustion] orchestrator still booting — deferring exhaustion alert",
      );
      _status = {
        ..._status,
        timeToEmptyMs,
        timeToEmptyFmt: formatDuration(timeToEmptyMs),
        activeItemCount: count,
        level: "ok",
        lastCheckedAtMs: now,
        overrideSuppressed: false,
        overrideKind: null,
        overrideTitle: null,
      };
      return;
    }

    // An override (manual or ytShuffleFallback) means the channel is ON AIR
    // even though the local queue is empty.  Suppress alerting — log at INFO.
    const overrideActive = !!(ctx?.override || ctx?.ytShuffleActive);
    const override = ctx?.override ?? null;

    if (timeToEmptyMs < CRIT_MS) {
      level = "critical";
      if (!_status.lastCritAlertAtMs || now - _status.lastCritAlertAtMs > ALERT_COOLDOWN_MS) {
        _status.lastCritAlertAtMs = now;
        queueExhaustionWarnTotal.inc({ level: "critical", service: "temple-tv-api", env: process.env["NODE_ENV"] ?? "development" });

        if (overrideActive) {
          logger.info(
            {
              timeToEmptyMs,
              activeItemCount: count,
              overrideKind: override?.kind ?? "yt-shuffle",
              overrideTitle: override?.title ?? null,
              ytShuffleActive: ctx?.ytShuffleActive ?? false,
            },
            "[queue-exhaustion] local queue is empty but broadcast is ON AIR via override — CRITICAL alert suppressed",
          );
        } else {
          adminEventBus.push("ops-alert", {
            level: "critical",
            code: "queue-exhaustion-critical",
            message: `Broadcast queue will exhaust in ${formatDuration(timeToEmptyMs)} (${count} active items). Auto-refill or operator action required immediately.`,
            context: { timeToEmptyMs, activeItemCount: count },
          });
          logger.error(
            { timeToEmptyMs, activeItemCount: count },
            "[queue-exhaustion] CRITICAL — queue exhausts in < 15 min",
          );
        }
      }
    } else if (timeToEmptyMs < WARN_MS) {
      level = "warn";
      if (!_status.lastWarnAlertAtMs || now - _status.lastWarnAlertAtMs > ALERT_COOLDOWN_MS) {
        _status.lastWarnAlertAtMs = now;
        queueExhaustionWarnTotal.inc({ level: "warn", service: "temple-tv-api", env: process.env["NODE_ENV"] ?? "development" });

        if (overrideActive) {
          logger.info(
            {
              timeToEmptyMs,
              activeItemCount: count,
              overrideKind: override?.kind ?? "yt-shuffle",
              overrideTitle: override?.title ?? null,
              ytShuffleActive: ctx?.ytShuffleActive ?? false,
            },
            "[queue-exhaustion] local queue is low but broadcast is ON AIR via override — WARN alert suppressed",
          );
        } else {
          adminEventBus.push("ops-alert", {
            level: "warn",
            code: "queue-exhaustion-warn",
            message: `Broadcast queue running low — ${formatDuration(timeToEmptyMs)} of content remaining (${count} active items).`,
            context: { timeToEmptyMs, activeItemCount: count },
          });
          logger.warn(
            { timeToEmptyMs, activeItemCount: count },
            "[queue-exhaustion] WARN — queue exhausts in < 2 h",
          );
        }
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
      overrideSuppressed: overrideActive,
      overrideKind: override?.kind ?? (ctx?.ytShuffleActive ? "yt-shuffle" : null),
      overrideTitle: override?.title ?? null,
    };
  } catch (err) {
    logger.warn({ err }, "[queue-exhaustion] check failed (non-fatal)");
  }
}

export function startExhaustionMonitor(): void {
  if (_timer) return;
  // Defer the first check so the orchestrator has time to boot and activate
  // the YouTube shuffle fallback before we evaluate alert thresholds.
  // The regular interval then fires every INTERVAL_MS thereafter.
  const firstCheckTimer = setTimeout(() => {
    void check();
    _timer = setInterval(() => { void check(); }, INTERVAL_MS);
    _timer.unref?.();
  }, INITIAL_CHECK_DELAY_MS);
  firstCheckTimer.unref?.();
  // Keep a sentinel value in _timer so re-entrant calls to startExhaustionMonitor()
  // are blocked even during the initial delay window.
  _timer = firstCheckTimer as unknown as NodeJS.Timeout;
  logger.info(
    { initialDelayMs: INITIAL_CHECK_DELAY_MS, intervalMs: INTERVAL_MS },
    "[queue-exhaustion] monitor started (first check deferred to allow orchestrator boot)",
  );
}

export function stopExhaustionMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    clearTimeout(_timer);
    _timer = null;
  }
}
