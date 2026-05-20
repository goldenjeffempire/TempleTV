/**
 * keep-alive — OMEGA Hardening: free-tier cold-start prevention.
 *
 * Render and Replit free-tier services sleep after ~15 minutes of
 * inactivity. This module pings the server's own /healthz endpoint
 * every 14 minutes so the process never crosses the inactivity threshold.
 *
 * Only active in production (NODE_ENV=production) — dev servers are
 * always hot and the extra request would pollute dev logs. The interval
 * is `.unref()`'d so it never prevents clean shutdown.
 */

import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

const PING_INTERVAL_MS = 14 * 60 * 1000;

let keepAliveInterval: NodeJS.Timeout | null = null;

export function startKeepAlive(): void {
  if (env.NODE_ENV !== "production") return;
  if (keepAliveInterval) return;

  const selfUrl = `http://127.0.0.1:${env.PORT}/healthz`;

  keepAliveInterval = setInterval(async () => {
    try {
      const res = await fetch(selfUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "[keep-alive] self-ping returned non-OK status");
      }
    } catch (err) {
      logger.warn({ err }, "[keep-alive] self-ping failed");
    }
  }, PING_INTERVAL_MS);

  keepAliveInterval.unref();
  logger.info({ intervalMs: PING_INTERVAL_MS, url: selfUrl }, "[keep-alive] started");
}

export function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}
