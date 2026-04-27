import * as Sentry from "@sentry/node";

const dsn =
  process.env.SENTRY_DSN ??
  "https://e1d80a0a1acfca1dc8743cc701de446c@o4511258419462144.ingest.us.sentry.io/4511258444693504";

const environment = process.env.NODE_ENV ?? "development";
const release = process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT;

// Worker-only processes (RUN_MODE=worker, used by `temple-tv-transcoder` on
// Render) bundle express transitively because `index.ts` imports `app.ts`,
// but they NEVER serve HTTP. Sentry's express auto-instrumentation can't
// patch the bundled express (esbuild inlines it, defeating the require-time
// interception OpenTelemetry relies on) so on every worker boot it emitted
//   "[Sentry] express is not instrumented. Please make sure to initialize
//    Sentry in a separate file..."
// even though our `--import ./instrument.mjs` was already doing exactly that.
// The warning is harmless but it pollutes the production log stream and
// distracts during incident triage. Disabling the express integration on
// worker processes silences it cleanly and skips OTel patching the worker
// doesn't need.
const runMode = (process.env.RUN_MODE ?? "all").toLowerCase();
const isWorkerOnly = runMode === "worker";

Sentry.init({
  dsn,
  environment,
  release,
  sendDefaultPii: true,
  // ── Memory-conscious tracing ───────────────────────────────────────────────
  // Each sampled span keeps request/response metadata + headers in memory
  // until the next batch flush (~5 s). On a long-running API serving 50+
  // req/s, even 0.1 sampling means ~25 spans queued at any given moment.
  // 0.05 keeps incident-investigation visibility while halving the in-flight
  // span buffer (relevant to the 2026-04-27 RSS bloat incident on Render).
  tracesSampleRate: environment === "production" ? 0.05 : 1.0,
  // `@sentry/profiling-node` is NOT installed (intentional — its native
  // V8 CPU sampler holds C++ profile buffers in `external` memory and was
  // a suspected contributor to the RSS bloat). Setting profilesSampleRate
  // would be a no-op without the integration; we leave it unset for clarity.
  integrations: isWorkerOnly
    ? (defaults) => defaults.filter((i) => i.name !== "Express")
    : undefined,
});
