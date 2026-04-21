import { Router } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";

/**
 * External log-sink hook for client-error reports.
 *
 * Set CLIENT_ERROR_SINK_URL in the production environment to forward each
 * client-error report to an external HTTP collector (e.g. Logtail, Datadog
 * Logs intake, Sentry's `/api/<id>/store/`, BetterStack). The endpoint is
 * fire-and-forget so it never blocks the response to the client.
 *
 * Optional: CLIENT_ERROR_SINK_TOKEN is sent as a Bearer token if set.
 *
 * For full source-map symbolication and breadcrumbs in production, install
 * `@sentry/react-native` on the mobile app — that flow runs alongside this
 * first-party endpoint and does not replace it.
 */
const SINK_URL = process.env.CLIENT_ERROR_SINK_URL;
const SINK_TOKEN = process.env.CLIENT_ERROR_SINK_TOKEN;

const SINK_TIMEOUT_MS = 5000;

async function forwardToExternalSink(payload: Record<string, unknown>): Promise<void> {
  if (!SINK_URL) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SINK_TIMEOUT_MS);
  try {
    const res = await fetch(SINK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(SINK_TOKEN ? { Authorization: `Bearer ${SINK_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    // Drain the body so the underlying socket is released back to the pool.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
  } catch (err) {
    logger.warn({ err }, "[ClientError] external sink delivery failed");
  } finally {
    clearTimeout(timer);
  }
}

const router = Router();

const ClientErrorSchema = z.object({
  platform: z.enum(["ios", "android", "web", "tv", "unknown"]).default("unknown"),
  appVersion: z.string().max(64).optional(),
  buildNumber: z.string().max(32).optional(),
  errorName: z.string().max(256).optional(),
  errorMessage: z.string().max(2048),
  stack: z.string().max(8192).optional(),
  componentStack: z.string().max(8192).optional(),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  occurredAt: z.string().datetime().optional(),
});

router.post("/client-errors", (req, res) => {
  const parsed = ClientErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_payload",
      message: "Invalid client error payload",
      issues: parsed.error.issues,
    });
  }

  const payload = parsed.data;
  const record = {
    clientError: true,
    platform: payload.platform,
    appVersion: payload.appVersion,
    buildNumber: payload.buildNumber,
    errorName: payload.errorName,
    errorMessage: payload.errorMessage,
    stack: payload.stack,
    componentStack: payload.componentStack,
    context: payload.context,
    occurredAt: payload.occurredAt ?? new Date().toISOString(),
  };
  logger.error(record, `[ClientError] ${payload.errorMessage}`);

  // Fire-and-forget external sink (Logtail / Datadog / Sentry / etc.)
  void forwardToExternalSink(record);

  return res.status(202).json({ ok: true });
});

export default router;
