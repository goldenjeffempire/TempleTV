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
export declare function startKeepAlive(): void;
export declare function stopKeepAlive(): void;
