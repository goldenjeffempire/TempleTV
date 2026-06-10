/**
 * Broadcast health webhook service.
 *
 * Fires outbound HTTP POST payloads to a configurable URL on key broadcast
 * health events: dead-air escalation, item auto-deactivation, and recovery.
 * Useful for external monitoring, Slack/PagerDuty integration, or any webhook
 * receiver the operator controls.
 *
 * Configuration (all in env.ts):
 *   BROADCAST_WEBHOOK_URL            — target endpoint (required to enable)
 *   BROADCAST_WEBHOOK_SECRET         — HMAC-SHA256 signing secret (optional)
 *   BROADCAST_WEBHOOK_TIMEOUT_MS     — per-attempt timeout (default 5 000)
 *   BROADCAST_WEBHOOK_RETRY_ATTEMPTS — max retries (default 3, backoff 1/2/4 s)
 *
 * Payload shape:
 *   {
 *     "event":     "dead_air" | "item_deactivated" | "recovery" | "test",
 *     "timestamp": "<ISO-8601>",
 *     "channel":   "main",
 *     "data":      { ... event-specific fields ... }
 *   }
 *
 * Signature: when BROADCAST_WEBHOOK_SECRET is set, each request includes
 *   X-Temple-TV-Signature: sha256=<HMAC-SHA256 hex of the JSON body>
 * Verify on the receiver side using the same secret.
 */
import { createHmac, randomUUID } from "node:crypto";
import { env } from "../../../config/env.js";
import { logger } from "../../../infrastructure/logger.js";

// ─── Event types ─────────────────────────────────────────────────────────────

export type BroadcastWebhookEvent =
  | "dead_air"
  | "item_deactivated"
  | "recovery"
  | "test";

export interface WebhookPayload {
  event: BroadcastWebhookEvent;
  timestamp: string;
  channel: string;
  data: Record<string, unknown>;
}

// ─── Delivery tracking ────────────────────────────────────────────────────────

export type WebhookDeliveryStatus = "success" | "failed" | "pending";

export interface WebhookDelivery {
  id: string;
  event: BroadcastWebhookEvent;
  timestamp: number;
  status: WebhookDeliveryStatus;
  statusCode?: number;
  durationMs?: number;
  error?: string;
}

export interface WebhookDeliveryResult {
  deliveryId: string;
  status: "success" | "failed" | "not_configured";
  statusCode?: number;
  durationMs?: number;
  error?: string;
}

const DELIVERY_LOG_MAX = 20;
const deliveryLog: WebhookDelivery[] = [];

function recordDelivery(d: WebhookDelivery): void {
  // Most-recent first. Mutate the existing entry (identified by id) if already
  // present (e.g. after retries update a pending → success|failed).
  const idx = deliveryLog.findIndex((e) => e.id === d.id);
  if (idx !== -1) {
    deliveryLog[idx] = d;
  } else {
    deliveryLog.unshift(d);
    if (deliveryLog.length > DELIVERY_LOG_MAX) deliveryLog.length = DELIVERY_LOG_MAX;
  }
}

// ─── Public read API ──────────────────────────────────────────────────────────

export function isWebhookConfigured(): boolean {
  return !!env.BROADCAST_WEBHOOK_URL;
}

/** Mask the webhook URL for safe display: show scheme + host, redact path. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/***`;
  } catch {
    return "***";
  }
}

export function getWebhookStatus(): {
  configured: boolean;
  urlMasked?: string;
  recentDeliveries: WebhookDelivery[];
} {
  const url = env.BROADCAST_WEBHOOK_URL;
  return {
    configured: !!url,
    urlMasked: url ? maskUrl(url) : undefined,
    recentDeliveries: [...deliveryLog],
  };
}

// ─── HMAC signing ─────────────────────────────────────────────────────────────

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// Mirrors the policy enforced by universal-source-resolver without importing it.
// Private (non-loopback) ranges blocked in all environments; loopback only in
// production (local dev legitimately uses localhost for webhook receivers).

/** IPv4 private / loopback / link-local / CGNAT / multicast CIDRs. */
const _PRIVATE_IPV4_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|2(2[4-9]|[3-4]\d|5[0-5])\.)/;

function _isSsrfTarget(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1";
  const isPrivate = _PRIVATE_IPV4_RE.test(hostname);
  if (isPrivate && !isLoopback) return true;
  if (isLoopback && env.NODE_ENV === "production") return true;
  return false;
}

// ─── Core delivery ───────────────────────────────────────────────────────────

/**
 * Attempt a single HTTP POST to the webhook URL.
 * Returns the response status or throws on network error / timeout.
 */
async function attempt(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; ok: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), env.BROADCAST_WEBHOOK_TIMEOUT_MS);
  // Unref the abort timer so it never holds the event loop during SIGTERM.
  // The backoff timers in deliver() are also unref'd; this completes the set.
  (timer as NodeJS.Timeout).unref?.();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ac.signal,
    });
    // Always drain the response body regardless of status code.
    // In Node 24 (undici), an unconsumed body keeps the socket open until GC
    // decides to finalize it — under load this exhausts the connection pool.
    void res.body?.cancel().catch(() => {});
    return { status: res.status, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Internal delivery engine shared by fire-and-forget and synchronous paths.
 * Updates the in-process delivery log entry in-place across retries.
 */
async function deliver(
  deliveryId: string,
  payload: WebhookPayload,
  delivery: WebhookDelivery,
): Promise<void> {
  const url = env.BROADCAST_WEBHOOK_URL!;

  // SSRF guard: reject private/loopback targets before any network call so
  // the delivery loop is never entered for misconfigured URLs.  A single
  // synchronous check here is cheaper than letting all MAX retry attempts
  // fail with the same network error.
  if (_isSsrfTarget(url)) {
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    logger.warn(
      { deliveryId, host },
      "[broadcast-webhook] SSRF blocked — BROADCAST_WEBHOOK_URL targets a private network; delivery skipped",
    );
    Object.assign(delivery, {
      status: "failed" as WebhookDeliveryStatus,
      error: `SSRF blocked: private host (${host})`,
    });
    recordDelivery(delivery);
    return;
  }

  const body = JSON.stringify(payload);
  const MAX = env.BROADCAST_WEBHOOK_RETRY_ATTEMPTS;

  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "TempleTV-Webhook/1.0",
    "X-Temple-TV-Delivery": deliveryId,
    "X-Temple-TV-Event": payload.event,
  };
  if (env.BROADCAST_WEBHOOK_SECRET) {
    baseHeaders["X-Temple-TV-Signature"] = sign(body, env.BROADCAST_WEBHOOK_SECRET);
  }

  let lastError: string | undefined;

  for (let attempt_n = 1; attempt_n <= MAX; attempt_n++) {
    const start = Date.now();
    try {
      const { status, ok } = await attempt(url, body, {
        ...baseHeaders,
        "X-Temple-TV-Attempt": String(attempt_n),
      });
      const durationMs = Date.now() - start;

      if (ok) {
        Object.assign(delivery, {
          status: "success" as WebhookDeliveryStatus,
          statusCode: status,
          durationMs,
          error: undefined,
        });
        recordDelivery(delivery);
        logger.info(
          { deliveryId, event: payload.event, channel: payload.channel, statusCode: status, durationMs, attempt: attempt_n },
          "[broadcast-webhook] delivery succeeded",
        );
        return;
      }

      lastError = `HTTP ${status}`;
      delivery.statusCode = status;
      logger.warn(
        { deliveryId, event: payload.event, channel: payload.channel, statusCode: status, durationMs, attempt: attempt_n, maxAttempts: MAX },
        "[broadcast-webhook] non-2xx response — retrying if attempts remain",
      );
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { deliveryId, event: payload.event, channel: payload.channel, err: lastError, durationMs, attempt: attempt_n, maxAttempts: MAX },
        "[broadcast-webhook] network/timeout error — retrying if attempts remain",
      );
    }

    // Exponential backoff: 1 s, 2 s, 4 s, … before next attempt.
    if (attempt_n < MAX) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000 * 2 ** (attempt_n - 1));
        // Unref so the timer doesn't prevent graceful shutdown.
        (t as NodeJS.Timeout).unref?.();
      });
    }
  }

  Object.assign(delivery, {
    status: "failed" as WebhookDeliveryStatus,
    error: lastError,
  });
  recordDelivery(delivery);
  logger.error(
    { deliveryId, event: payload.event, channel: payload.channel, attempts: MAX, lastError },
    "[broadcast-webhook] delivery permanently failed after all retry attempts",
  );
}

// ─── Public send API ──────────────────────────────────────────────────────────

/**
 * Fire-and-forget webhook delivery. Errors are logged but never thrown to the
 * caller. Safe to call with `void` from any synchronous or async context.
 */
export function sendBroadcastWebhook(
  event: BroadcastWebhookEvent,
  channel: string,
  data: Record<string, unknown>,
): void {
  if (!env.BROADCAST_WEBHOOK_URL) return;

  const deliveryId = randomUUID();
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    channel,
    data,
  };

  const delivery: WebhookDelivery = {
    id: deliveryId,
    event,
    timestamp: Date.now(),
    status: "pending",
  };
  recordDelivery(delivery);

  void deliver(deliveryId, payload, delivery).catch((err: unknown) => {
    logger.error(
      { deliveryId, event, channel, err },
      "[broadcast-webhook] deliver() threw unexpectedly (non-fatal)",
    );
    Object.assign(delivery, { status: "failed", error: String(err) });
    recordDelivery(delivery);
  });
}

/**
 * Synchronous (awaitable) webhook delivery — used by the test endpoint so the
 * API can return the delivery result in the HTTP response body.
 */
export async function sendBroadcastWebhookSync(
  event: BroadcastWebhookEvent,
  channel: string,
  data: Record<string, unknown>,
): Promise<WebhookDeliveryResult> {
  if (!env.BROADCAST_WEBHOOK_URL) {
    return { deliveryId: "", status: "not_configured" };
  }

  const deliveryId = randomUUID();
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    channel,
    data,
  };

  const delivery: WebhookDelivery = {
    id: deliveryId,
    event,
    timestamp: Date.now(),
    status: "pending",
  };
  recordDelivery(delivery);

  await deliver(deliveryId, payload, delivery).catch((err: unknown) => {
    logger.error(
      { deliveryId, event, channel, err },
      "[broadcast-webhook] deliver() threw unexpectedly in sync path (non-fatal)",
    );
    Object.assign(delivery, { status: "failed", error: String(err) });
    recordDelivery(delivery);
  });

  return {
    deliveryId,
    status: delivery.status === "pending" ? "failed" : delivery.status,
    statusCode: delivery.statusCode,
    durationMs: delivery.durationMs,
    error: delivery.error,
  };
}
