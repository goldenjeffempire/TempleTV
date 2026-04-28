/**
 * Loaded via `--import` BEFORE the application bundle so any
 * APM / tracing / source-map hook is installed before our modules
 * evaluate. Keep this file dependency-light — it must not require
 * the bundled artifact, only Node + optional peer deps.
 */
export {};

async function bootInstrumentation(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    // Dynamic + string-built specifier so TypeScript doesn't try to resolve
    // @sentry/node at compile time (it is an optional peer dep).
    const moduleName = "@sentry/node";
    const Sentry = await import(/* @vite-ignore */ moduleName).catch(() => null);
    if (Sentry && typeof (Sentry as { init?: unknown }).init === "function") {
      (Sentry as { init: (opts: Record<string, unknown>) => void }).init({
        dsn,
        environment: process.env.NODE_ENV ?? "development",
        tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0.05),
      });
      // eslint-disable-next-line no-console
      console.log("[instrument] Sentry initialized");
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[instrument] Sentry init failed (non-fatal):", err);
  }
}

await bootInstrumentation();
