import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import {
  resumePendingJobsOnStartup,
  startRetryTick,
  stopRetryTick,
  markWorkerGuardrailPassed,
} from "./lib/transcoder";
import { assertFfmpegAvailable } from "./lib/ffmpeg";
import { startNotificationScheduler } from "./lib/notification-scheduler";
import { startLiveOverrideScheduler } from "./lib/live-override-scheduler";
import { startSSEHeartbeat, closeAllSSEClients } from "./lib/liveEvents";
import { startBroadcastTransitionTicker } from "./routes/broadcast";
import { startSignedUrlCacheWatchdog } from "./lib/signedUrlCacheWatchdog";
import { startBroadcastLatencyWatchdog } from "./lib/broadcastLatencyWatchdog";
import { startLiveIngestHealthMonitor, stopLiveIngestHealthMonitor } from "./lib/liveIngestHealth";
import { startStreamHealthEmitter } from "./lib/streamHealth";
import { startYoutubeCatalogueScheduler } from "./routes/youtube";
import { cache } from "./lib/cache";
import { AWS_REGION, AWS_S3_BUCKET, isS3Configured } from "./lib/s3Storage";
import { runS3MirrorReconciliation } from "./lib/s3MirrorReconciler";
import { markDraining, markReady } from "./lib/lifecycle";
import { installFatalAppender } from "./lib/fatalLogBuffer";
import {
  installExitReasonInstrumentation,
  startMemoryPressureSampler,
} from "./lib/exitReason";

const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET"] as const;

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    throw new Error(
      `Required environment variable "${key}" is missing. Set it before starting the server.`,
    );
  }
}

const RUN_MODE = (process.env.RUN_MODE ?? "all").toLowerCase();
const VALID_RUN_MODES = new Set(["api", "worker", "all"]);

if (!VALID_RUN_MODES.has(RUN_MODE)) {
  throw new Error(
    `Invalid RUN_MODE "${process.env.RUN_MODE}". Must be one of: api, worker, all (default).`,
  );
}

const RUNS_API = RUN_MODE === "all" || RUN_MODE === "api";
const RUNS_WORKER = RUN_MODE === "all" || RUN_MODE === "worker";

logger.info(
  { runMode: RUN_MODE, runsApi: RUNS_API, runsWorker: RUNS_WORKER },
  "Process role resolved",
);

// Install the fatal-log circular buffer side-effect on `logger.fatal(...)`
// BEFORE any production-safety gates (e.g. S3 config) can fire one. Cache
// may not be fully ready yet — the appender swallows errors so that's safe;
// it just means the very-first fatal during cold boot may not be persisted
// (acceptable: those crash the process immediately and are visible in
// stdout/Sentry anyway, the buffer's purpose is recurring crashloops).
installFatalAppender();

// Install synchronous exit-reason instrumentation BEFORE any signal can be
// received. Production Render logs (2026-04-27) showed the API process
// disappearing every ~30–60 s with no shutdown log — this writes a single
// `EXIT_REASON {…}` line to stderr (sync, bypassing pino's buffer) on
// every catchable termination path so the next death leaves a definitive
// cause line. SIGKILL / OOM-kill remain uncatchable by design — but the
// ABSENCE of an EXIT_REASON line on the next death is now itself the
// diagnostic signal ("kernel-level termination, look at Render Events").
installExitReasonInstrumentation({ runMode: RUN_MODE, pid: process.pid });

type StartupGateVerdict =
  | { kind: "ok" }
  | { kind: "fatal-exit" }
  | { kind: "degraded-standby" };

function logInfrastructureStatus(): StartupGateVerdict {
  const s3Configured = isS3Configured();
  const redisConfigured = Boolean(process.env.REDIS_URL?.trim());

  // The Replit object-storage shim (`PUBLIC_OBJECT_SEARCH_PATHS`,
  // `PRIVATE_OBJECT_DIR`) is an OPTIONAL alternative storage backend used
  // only on Replit deployments. When AWS S3 is wired up directly (the
  // production path on Render), the shim is intentionally not configured —
  // logging "not set" for these in production was misleading operators into
  // thinking object storage was misconfigured. We now report the shim
  // explicitly as `disabled (direct AWS S3 active)` when S3 is configured.
  const shimConfigured =
    Boolean(process.env.PUBLIC_OBJECT_SEARCH_PATHS?.trim()) ||
    Boolean(process.env.PRIVATE_OBJECT_DIR?.trim());
  const shimStatus = s3Configured
    ? shimConfigured
      ? "configured (overrides direct AWS S3)"
      : "disabled (direct AWS S3 active)"
    : shimConfigured
      ? "configured"
      : "not configured";

  logger.info(
    {
      objectStorage: {
        provider: "aws-s3",
        configured: s3Configured,
        bucket: s3Configured
          ? AWS_S3_BUCKET
          : "not set — uploads will use local FS only",
        region: s3Configured ? AWS_REGION : "not set",
        replitShim: shimStatus,
      },
      distributedCache: {
        redis: redisConfigured ? "configured" : "not configured",
        pgCache: "active (cache_entries table)",
        note: redisConfigured
          ? "Redis primary, PostgreSQL secondary"
          : "PostgreSQL distributed cache active across all instances",
      },
      hlsTranscoder: {
        ffmpegPath: process.env.FFMPEG_PATH ?? "system PATH",
        cloudUpload: s3Configured ? "enabled (AWS S3)" : "disabled (no bucket)",
        runsInThisProcess: RUNS_WORKER,
      },
    },
    "Infrastructure status at startup",
  );

  // ── Production safety gate ─────────────────────────────────────────────────
  // In production, AWS S3 is mandatory: without it, every uploaded video and
  // every transcoded HLS segment lands on the ephemeral container disk and
  // disappears on the next deploy/restart — a silent data-loss path that
  // must never reach users.
  //
  // The two roles handle the missing-config case differently because the
  // operational trade-offs differ:
  //
  //   • API (`role=api` / `role=all`) — serves user uploads and HLS reads in
  //     real time. Continuing to accept uploads with no backing storage would
  //     cause silent data loss. Hard-exit so Render's load balancer stops
  //     routing traffic; the previous good revision keeps serving until the
  //     operator populates the env vars and redeploys.
  //
  //   • Worker (`role=worker`) — picks transcoding jobs from a queue and
  //     uploads HLS variants to S3. Hard-exit here used to crashloop the
  //     entire deploy red even though no live traffic was ever at risk:
  //     the only consequence of "worker missing S3" is that pending jobs
  //     stay queued (not lost). Crashlooping made the operator's deploy
  //     dashboard look catastrophically broken and obscured the real fix
  //     (populate AWS_* on the worker service / `temple-tv-aws` env-var
  //     group). We now enter a "degraded standby" mode instead: the process
  //     stays alive so the deploy goes green, the retry tick is NEVER armed
  //     (so no job is ever transcoded onto ephemeral disk), and a fatal log
  //     line is re-emitted every 5 minutes so the operator can spot the
  //     misconfig in the Render log viewer. As soon as the operator sets
  //     the env vars, Render auto-restarts the service and it boots fully
  //     active — no manual intervention beyond the env-var update needed.
  if (process.env.NODE_ENV === "production" && !s3Configured) {
    const missing = [
      process.env.AWS_S3_BUCKET ? null : "AWS_S3_BUCKET",
      process.env.AWS_REGION ? null : "AWS_REGION",
      process.env.AWS_ACCESS_KEY_ID ? null : "AWS_ACCESS_KEY_ID",
      process.env.AWS_SECRET_ACCESS_KEY ? null : "AWS_SECRET_ACCESS_KEY",
    ].filter(Boolean);

    const baseMessage =
      `AWS S3 is not configured on this '${RUN_MODE}' service. ` +
      "Each Render service has its OWN environment-variable scope — the web service env vars do NOT propagate to the worker service. " +
      "Set AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY directly on this service, " +
      "or populate the shared 'temple-tv-aws' env-var group in render.yaml so every service inherits the credentials in one place.";

    if (RUN_MODE === "worker") {
      logger.fatal(
        { runMode: RUN_MODE, missing, mode: "degraded-standby" },
        `Worker entering DEGRADED STANDBY (no transcode jobs will be picked up): ${baseMessage}`,
      );
      // Keep the process alive so the deploy is green; re-emit the fatal
      // every 5 minutes so the operator notices in the Render log viewer
      // and the fatalLogBuffer (Mission Control) keeps surfacing it.
      const reLogIntervalMs = 5 * 60_000;
      setInterval(() => {
        logger.fatal(
          { runMode: RUN_MODE, missing, mode: "degraded-standby" },
          `Worker still in DEGRADED STANDBY — AWS S3 not configured. ${baseMessage}`,
        );
      }, reLogIntervalMs);
      return { kind: "degraded-standby" };
    }

    logger.fatal(
      { runMode: RUN_MODE, missing },
      `Refusing to start (role=${RUN_MODE}): ${baseMessage} ` +
        "Continuing to accept uploads would silently lose every file on the next deploy.",
    );
    setTimeout(() => process.exit(1), 250);
    return { kind: "fatal-exit" };
  }

  return { kind: "ok" };
}

function startTranscoderRole() {
  // Verify ffmpeg + ffprobe are present BEFORE the worker can pick up jobs.
  assertFfmpegAvailable()
    .then(() => {
      logger.info("FFmpeg preflight passed — transcoding pipeline active");
      resumePendingJobsOnStartup().catch((err) => {
        logger.error({ err }, "Failed to resume pending transcoding jobs");
      });
      startRetryTick();
    })
    .catch((err) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "FFmpeg preflight failed — transcoder disabled until binaries are available",
      );
    });
}

async function startApiSchedulers() {
  startNotificationScheduler();
  startLiveOverrideScheduler();
  startSSEHeartbeat();
  startBroadcastTransitionTicker();
  startStreamHealthEmitter();
  startYoutubeCatalogueScheduler();
  startLiveIngestHealthMonitor();
  startSignedUrlCacheWatchdog();
  startBroadcastLatencyWatchdog();

  // Log cache backend once it has had time to connect (2s warm-up).
  setTimeout(() => {
    const status = cache.status();
    logger.info({ cacheStatus: status }, "Cache backend resolved");
  }, 2_000);

  // Reconcile any local uploads whose S3 mirror failed at finalize time.
  // Fire-and-forget so a slow/large backlog never blocks request serving.
  // The reconciler is internally bounded-concurrency and idempotent.
  runS3MirrorReconciliation().catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "s3MirrorReconciler: pass crashed",
    );
  });

  // Pre-warm the broadcast snapshot BEFORE flipping health to ready, so the
  // first viewer after a deploy never sees the ~1s cold-build path observed
  // in production logs (994ms responseTime on a freshly-rotated instance).
  // The build path resolves in <50ms once PG warm-ups finish, and bounding
  // the warm-up at 3s prevents a slow DB from delaying readiness indefinitely
  // — a slow PG also surfaces immediately via the health probe rather than
  // hiding behind a slow first request.
  try {
    const { buildBroadcastCurrentPayload } = await import("./routes/broadcast");
    await Promise.race([
      buildBroadcastCurrentPayload(true),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Broadcast pre-warm failed — first /broadcast/current may be slow",
    );
  }

  // All schedulers armed and the HTTP server is already listening at this
  // point — flip /healthz from `starting` (503) to `ok` (200) so load
  // balancers begin routing traffic to this instance.
  markReady();
  logger.info("Lifecycle: ready (healthz now reports 200)");
}

let server: http.Server | null = null;
// Worker-only ref'd keep-alive (see the long comment in the worker branch
// below). Cleared during graceful shutdown so SIGTERM can drain the loop.
let workerKeepAlive: ReturnType<typeof setInterval> | null = null;

if (RUNS_API) {
  const rawPort = process.env["PORT"];
  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required for api mode but was not provided.",
    );
  }
  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  server = http.createServer(app);
  // ── HTTP keep-alive tuning for HLS segment delivery ──────────────────────
  // Node's defaults (`keepAliveTimeout: 5_000`, `headersTimeout: 60_000`) are
  // tuned for short request/response APIs, not the 6-second HLS segment
  // cadence this server fronts. With the default 5 s keepalive, a viewer's
  // TCP+TLS connection drops between consecutive segment fetches — every
  // `.ts` request then pays a fresh handshake (~150–300 ms on a warm CDN
  // edge, more on a cold one). Multiplied across thousands of viewers and
  // continuous playback, that's measurable startup + mid-stream latency.
  //
  // We bump keepalive to 75 s (one segment cadence past the 60 s typical
  // segment-list horizon, so a slow viewer never accidentally races the
  // close), and headersTimeout to 80 s (must exceed keepAliveTimeout per
  // Node docs to avoid spurious 408s from in-flight clients). Tunable via
  // env in case a future Render plan or fronting LB needs a different
  // envelope. requestTimeout intentionally left at the default (0 = no
  // wall-clock cap at this layer) because the per-request timeout
  // middleware (`middlewares/requestTimeout.ts`) handles that with
  // SSE/upload/HLS exemptions, which the raw socket-level timeout can't.
  const keepAliveTimeoutMs = Number(process.env.HTTP_KEEPALIVE_MS ?? 75_000);
  const headersTimeoutMs = Number(process.env.HTTP_HEADERS_TIMEOUT_MS ?? 80_000);
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.listen(port, "0.0.0.0", () => {
    logger.info({ port, host: "0.0.0.0" }, "Server listening");
    const verdict = logInfrastructureStatus();
    // For the API role the gate either passes or hard-exits — we never reach
    // here in the degraded-standby branch because that branch is worker-only.
    if (verdict.kind !== "ok") return;

    // Memory pressure sampler: emits a structured `memory sample` line
    // every 60 s and escalates to WARN at >=1.5 GiB RSS (75 % of the
    // Render `standard` 2 GiB plan ceiling, configurable via
    // MEMORY_WARN_RSS_MB). The sampler is `.unref()`'d so it never holds
    // the event loop open during graceful shutdown. Combined with the
    // EXIT_REASON instrumentation, this gives us the OOM-kill diagnostic
    // chain end-to-end: `Memory pressure: RSS X >= Y` → no EXIT_REASON →
    // process restart = OOM-kill (uncatchable SIGKILL by kernel).
    const warnAtMb = Number(process.env.MEMORY_WARN_RSS_MB ?? 1500);
    startMemoryPressureSampler({
      runMode: RUN_MODE,
      intervalMs: 60_000,
      warnAtRssBytes: warnAtMb * 1024 * 1024,
    });

    // Fire-and-forget: schedulers start synchronously, the awaited section
    // (broadcast pre-warm) runs in the background. `markReady()` inside
    // awaits the warm-up so /healthz only flips to 200 once we're hot.
    startApiSchedulers().catch((err) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "startApiSchedulers crashed",
      );
    });
    if (RUNS_WORKER) {
      startTranscoderRole();
    }
  });

  server.on("error", (err) => {
    logger.error({ err }, "Server error");
    process.exit(1);
  });
} else {
  // Pure worker process: no HTTP listener. Render `worker` services do not
  // expose a port and do not require a health endpoint.
  //
  // ── Event-loop keep-alive (the silent-exit fix) ───────────────────────────
  // Every timer the worker process owns is intentionally `.unref()`'d so that
  // a SIGTERM during graceful shutdown drains them cleanly:
  //   - transcoder.ts:retryTickHandle.unref()
  //   - cache.ts:MemoryCache gc interval .unref()
  //   - cache.ts:PgCache       gc interval .unref()
  // In RUN_MODE=all (local dev / the historical single-process deploy) the
  // HTTP `server.listen()` is a ref'd handle that holds the event loop open
  // forever, which masked the fact that the worker side has nothing keeping
  // it alive on its own. The moment we split the worker off into its own
  // Render service (RUN_MODE=worker, no HTTP server, no API schedulers), the
  // event loop drains as soon as the cache `init()` promise settles — Node
  // exits cleanly with code 0, and Render reports
  //   "Application exited early while running your code"
  // and restarts in an infinite loop with no error in the logs.
  //
  // The fix: install a single ref'd interval that does nothing but keep the
  // event loop alive. It runs once a minute (negligible cost), unref'd by
  // SIGTERM via the shutdown handler, so graceful shutdown still works.
  const keepAlive = setInterval(() => {
    // intentional no-op — sole purpose is to hold the event loop open
  }, 60_000);
  // Stash on the shutdown path so SIGTERM stops it (otherwise the 15s force
  // timer in shutdown() would fire and we'd exit with code 1 every redeploy).
  workerKeepAlive = keepAlive;

  logger.info("Starting in worker-only mode (no HTTP listener)");
  const verdict = logInfrastructureStatus();
  if (verdict.kind === "degraded-standby") {
    // The 5-minute fatal-log heartbeat (set up inside logInfrastructureStatus)
    // keeps the event loop alive on its own. Deliberately do NOT call
    // startTranscoderRole(): we must not arm the retry tick or claim any
    // transcoding job from the queue while S3 is missing — doing so would
    // write HLS variants to ephemeral disk and lose them on the next deploy.
    // The deploy succeeds (process stays up), pending jobs simply queue up
    // until the operator populates AWS_* and Render restarts this service.
    logger.warn(
      { runMode: RUN_MODE },
      "Worker armed in degraded-standby mode — transcoding queue will not be drained until AWS S3 is configured.",
    );
  } else if (verdict.kind === "ok") {
    startTranscoderRole();
  }
  // verdict.kind === "fatal-exit" cannot happen for worker mode: the gate
  // chooses degraded-standby for workers and only fatal-exits for api/all.

  // ── Startup self-check guardrail ────────────────────────────────────────
  // Defence-in-depth against the silent-exit class of bug fixed by the
  // keep-alive interval above. If a future change accidentally removes the
  // keep-alive, OR a future module-load side-effect calls `.unref()` on
  // every handle the worker owns, this check fires LOUDLY rather than
  // letting the process exit silently and crashloop on Render with the
  // useless "Application exited early" message in the dashboard.
  //
  // Mechanism: 2 s after worker setup, inspect the active-resources list.
  // If no Timeout handle is present we know the keep-alive is gone — log
  // fatal (which the fatalLogBuffer surfaces in Mission Control) and exit
  // with code 1 so Render reports a real failed deploy instead of a
  // mysterious silent restart loop. The setTimeout itself is `.unref()`'d
  // so it can NEVER be the thing holding the loop alive.
  const guardrail = setTimeout(() => {
    const resources = process.getActiveResourcesInfo();
    const hasTimer = resources.some(
      (r) => r === "Timeout" || r === "Immediate",
    );
    if (!hasTimer) {
      logger.fatal(
        { activeResources: resources },
        "Worker startup guardrail TRIPPED: no active timers in event loop. " +
          "The keep-alive interval is missing or has been unref'd. Without a " +
          "ref'd handle the process will exit cleanly with code 0 and Render " +
          "will report 'Application exited early' on every restart. Aborting " +
          "with code 1 so the failure is visible.",
      );
      process.exit(1);
    }
    logger.info(
      { activeResources: resources.length },
      "Worker startup guardrail OK — event loop has ref'd handles, process is stable",
    );
    // Latch the guardrail-passed flag so every subsequent worker heartbeat
    // carries `guardrailPassed: true`. Mission Control reads this off the
    // heartbeat to render a green "self-check OK" badge — concrete proof
    // the worker survived the silent-exit window, not just a freshness
    // signal that could be 60 s stale by the time anyone looks at it.
    markWorkerGuardrailPassed();
  }, 2_000);
  guardrail.unref();
}

let isShuttingDown = false;

/**
 * Two-phase graceful shutdown.
 *
 * Phase 1 — DRAIN (default 5 s, override via SHUTDOWN_DRAIN_MS):
 *   Flip /healthz to 503 `draining` immediately. The HTTP server keeps
 *   accepting and serving requests so in-flight calls finish cleanly.
 *   The drain window gives the LB time to observe ≥1 failed health probe
 *   and stop routing new traffic to this instance. Without this window,
 *   `server.close()` would race the LB and produce mid-request TCP resets
 *   (the symptom users see as "API connection lost").
 *
 * Phase 2 — CLOSE:
 *   Stop schedulers, close SSE clients, then `server.close()` to drain
 *   any remaining in-flight requests. A hard 15 s overall timer prevents
 *   a stuck connection from blocking the deploy forever.
 */
function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const drainMs = Math.max(
    0,
    Number(process.env.SHUTDOWN_DRAIN_MS ?? 5_000) || 0,
  );

  logger.info(
    { signal, runMode: RUN_MODE, drainMs },
    "Graceful shutdown initiated — entering drain phase",
  );

  // Phase 1: announce drain via /healthz so the LB can divert new traffic.
  if (RUNS_API) {
    markDraining();
  }

  // Hard cap on the total shutdown — fires regardless of which phase we're in.
  const forceTimer = setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 15_000);
  forceTimer.unref();

  const closePhase = () => {
    if (RUNS_WORKER) {
      try {
        stopRetryTick();
      } catch (err) {
        logger.warn({ err }, "Error stopping retry tick");
      }
      // Release the ref'd keep-alive interval so the event loop can drain
      // and the process can exit on its own without waiting for the 15 s
      // forceTimer to fire (which would exit with code 1 and cause Render
      // to misreport the redeploy as a crash).
      if (workerKeepAlive) {
        clearInterval(workerKeepAlive);
        workerKeepAlive = null;
      }
    }

    if (RUNS_API) {
      try {
        stopLiveIngestHealthMonitor();
      } catch (err) {
        logger.warn({ err }, "Error stopping live ingest health monitor");
      }
    }

    if (server) {
      closeAllSSEClients();
      server.close((err) => {
        if (err) {
          logger.error({ err }, "Error closing server");
          process.exit(1);
        }
        logger.info("Server closed cleanly");
        process.exit(0);
      });
    } else {
      // Worker-only process — exit immediately after stopping the tick.
      logger.info("Worker stopped cleanly");
      setTimeout(() => process.exit(0), 100);
    }
  };

  if (drainMs > 0 && RUNS_API) {
    setTimeout(closePhase, drainMs).unref();
  } else {
    closePhase();
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});
