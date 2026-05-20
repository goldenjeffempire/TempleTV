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

async function bootSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const moduleName = "@sentry/node";
    const Sentry = await import(/* @vite-ignore */ moduleName).catch(() => null);
    if (Sentry && typeof (Sentry as { init?: unknown }).init === "function") {
      (Sentry as { init: (opts: Record<string, unknown>) => void }).init({
        dsn,
        environment: process.env.NODE_ENV ?? "development",
        tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0.05),
      });
      console.log("[instrument] Sentry initialized");
    }
  } catch (err) {
    console.warn("[instrument] Sentry init failed (non-fatal):", err);
  }
}

async function bootOtel(): Promise<void> {
  try {
    const sdkName = "@opentelemetry/sdk-node";
    const autoName = "@opentelemetry/auto-instrumentations-node";
    const exporterName = "@opentelemetry/exporter-prometheus";

    const [sdkPkg, autoPkg, exporterPkg] = await Promise.all([
      import(/* @vite-ignore */ sdkName).catch(() => null),
      import(/* @vite-ignore */ autoName).catch(() => null),
      import(/* @vite-ignore */ exporterName).catch(() => null),
    ]);

    if (!sdkPkg || !autoPkg || !exporterPkg) return;

    const exporter = new exporterPkg.PrometheusExporter({
      preventServerStart: true,
    });

    const sdk = new sdkPkg.NodeSDK({
      metricReader: exporter,
      instrumentations: [
        autoPkg.getNodeAutoInstrumentations({
          // Disable fs instrumentation — too noisy and high cardinality
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    sdk.start();

    // Expose exporter for the /metrics route to merge OTel metrics with
    // the prom-client custom registry (see metrics.routes.ts).
    (globalThis as Record<string, unknown>).__otelPrometheusExporter = exporter;

    console.log("[instrument] OpenTelemetry SDK + Prometheus exporter initialized");
  } catch (err) {
    console.warn("[instrument] OpenTelemetry init failed (non-fatal):", err);
  }
}

await bootSentry();
await bootOtel();
