/**
 * Loaded via `--import` BEFORE the application bundle so any
 * APM / tracing / source-map hook is installed before our modules
 * evaluate. Keep this file dependency-light — it must not require
 * the bundled artifact, only Node + optional peer deps.
 *
 * Two optional instrumentation layers are initialised here:
 *   1. Sentry   — crash reporting + performance tracing (requires SENTRY_DSN)
 *   2. OpenTelemetry SDK — auto-instrumentation for Fastify/HTTP/pg/ioredis;
 *      exposes a PrometheusExporter that the /metrics route merges with the
 *      prom-client custom registry.  All three @opentelemetry/* packages are
 *      optional — the app boots fine when they are absent.
 */
export {};
