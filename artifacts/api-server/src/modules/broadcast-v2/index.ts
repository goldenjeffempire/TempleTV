import type { FastifyInstance } from "fastify";
import { restRoutes } from "./io/rest.routes.js";
import { sseRoutes } from "./io/sse.gateway.js";
import { wsRoutes } from "./io/ws.gateway.js";
import { broadcastOrchestrator } from "./engine/broadcast-orchestrator.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";
import { mediaIntegrityScanner } from "./engine/media-integrity-scanner.js";
import { queueIntegrityValidator } from "./engine/queue-integrity-validator.js";
import { orphanCleanupWorker } from "./engine/orphan-cleanup.js";
import { workerSupervisor } from "./engine/worker-supervisor.js";
import { broadcastFanout } from "./io/broadcast-fanout.js";
import { installYouTubeAutoOverride } from "../youtube-live/auto-override.js";
import { faststartRecoveryWorker } from "./engine/faststart-recovery.js";
import { reEnableAllSuspended } from "./repository/queue.repo.js";

/**
 * Broadcast v2 — server-authoritative streaming control plane.
 *
 * Mount under `/broadcast-v2` (in app.ts). Provides:
 *   - REST: GET /state, GET /rehydrate, POST /skip, /override/start|stop, /force-failover, /clear-failover, /reload
 *   - SSE:  GET /events
 *   - WS:   GET /ws
 *
 * Coexists with the v1 broadcast module until the cut-over (T008).
 */
export async function broadcastV2Routes(app: FastifyInstance) {
  await app.register(restRoutes);
  await app.register(sseRoutes);
  await app.register(wsRoutes);
}

let bootInFlight: Promise<void> | null = null;
let busBridgeInstalled = false;
let startAttempts = 0;
let lastStartError: string | null = null;
let lastStartAttemptAtMs: number | null = null;
let bootRetryTimer: NodeJS.Timeout | null = null;

/**
 * /health-visible bootstrap status. Lets external monitors and the
 * operator distinguish "bridge installed but start() throwing" from
 * "neither was ever attempted" — both surface as `sequence: 0` on
 * the snapshot endpoint without this.
 */
export function getBroadcastV2BootStatus(): {
  started: boolean;
  busBridgeInstalled: boolean;
  startAttempts: number;
  lastStartError: string | null;
  lastStartAttemptAtMs: number | null;
} {
  return {
    started: broadcastOrchestrator.isStarted(),
    busBridgeInstalled,
    startAttempts,
    lastStartError,
    lastStartAttemptAtMs,
  };
}

/**
 * Bridge the V1 admin event bus into the V2 orchestrator.
 *
 * The admin SPA still uses the V1 routes (`POST /admin/broadcast`,
 * `DELETE /admin/broadcast/:id`, `PUT /admin/broadcast/reorder`,
 * `PATCH /admin/broadcast/:id`) to mutate the queue. Those routes write
 * to the same `broadcast_queue` table that the V2 orchestrator reads —
 * but the orchestrator caches the rows in memory and only re-reads on
 * `reload()`. Without this bridge the queue change is invisible to V2
 * (and therefore to every player surface) until the next item-boundary
 * cycle, which can be hours.
 *
 * Every V1 mutation already emits `broadcast-queue-updated` on the bus;
 * we simply hook that signal and tell the orchestrator to re-read. A
 * 250 ms debounce coalesces drag-reorder bursts (one POST per moved
 * row) into a single reload call.
 *
 * Idempotent: runs once per process. Listeners are added with
 * `setMaxListeners(200)` headroom on the bus so we don't risk the
 * default warning even with many SSE clients also subscribed.
 */
function installBusBridge(): void {
  if (busBridgeInstalled) return;
  busBridgeInstalled = true;

  let pending: NodeJS.Timeout | null = null;
  adminEventBus.on("admin-event", (event: { type: string; data?: unknown }) => {
    if (event.type !== "broadcast-queue-updated") return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      broadcastOrchestrator
        .reload()
        .catch((err) =>
          logger.warn({ err }, "[broadcast-v2] auto-reload after queue mutation failed"),
        );
    }, 250);
    pending.unref?.();
  });
  logger.info("[broadcast-v2] admin event bus bridge installed");
}

/**
 * Boot retry schedule: 5 s, 15 s, 30 s, then 60 s forever. Mirrors how
 * the V1 broadcast scheduler treats engine-start failures — the server
 * stays up serving HTTP, and the orchestrator self-heals as soon as the
 * downstream blocker (DB pool warm-up, schema migration race, etc.) is
 * gone. Without retry, a single transient failure at boot left v2 stuck
 * at sequence=0 forever, which is the production bug we hit.
 */
const BOOT_RETRY_SCHEDULE_MS = [5_000, 15_000, 30_000, 60_000];

function scheduleBootRetry(): void {
  if (bootRetryTimer) return;
  const idx = Math.min(startAttempts - 1, BOOT_RETRY_SCHEDULE_MS.length - 1);
  const delay = BOOT_RETRY_SCHEDULE_MS[Math.max(0, idx)]!;
  bootRetryTimer = setTimeout(() => {
    bootRetryTimer = null;
    if (broadcastOrchestrator.isStarted()) return;
    logger.info({ attempt: startAttempts + 1 }, "[broadcast-v2] retrying orchestrator start");
    void ensureBroadcastV2Started().catch(() => {
      // Already logged inside ensureBroadcastV2Started; the next retry
      // is rescheduled there.
    });
  }, delay);
  bootRetryTimer.unref?.();
}

let supervisedWorkersStarted = false;

function startSupervisedWorkers(): void {
  if (supervisedWorkersStarted) return;
  supervisedWorkersStarted = true;

  // Media integrity scanner: probes all active queue item URLs every 2 min
  workerSupervisor.spawn({
    name: "media-integrity-scanner",
    fn: () => mediaIntegrityScanner.scan(),
    intervalMs: 2 * 60_000,
    initialDelayMs: 45_000,
    backoffMs: [5_000, 15_000, 30_000, 60_000],
  });

  // Orphan cleanup: sweeps stale event-log + orphaned queue refs every 4 h
  workerSupervisor.spawn({
    name: "orphan-cleanup",
    fn: () => orphanCleanupWorker.sweep(),
    intervalMs: 4 * 60 * 60_000,
    initialDelayMs: 10 * 60_000,
    backoffMs: [30_000, 60_000, 5 * 60_000],
  });

  // Queue integrity validator: validates active queue on demand; also runs
  // every 10 min so new additions are caught without manual invocation.
  workerSupervisor.spawn({
    name: "queue-integrity-validator",
    fn: () => queueIntegrityValidator.validate(),
    intervalMs: 10 * 60_000,
    initialDelayMs: 30_000,
    backoffMs: [5_000, 15_000, 30_000],
  });

  // Faststart recovery: detects active queue items whose joined video is
  // local-source + faststart_applied=false + status in (none/queued/encoding)
  // — exactly the rows that v2.loadActive() rejects from broadcast. Triggers
  // runFaststart() with an in-memory attempt cap so the orchestrator can
  // admit them on the next reload. Closes the v1/v2 admission gap that
  // produced "Off Air" despite a playable MP4 in the queue.
  faststartRecoveryWorker.markEnabled();
  workerSupervisor.spawn({
    name: "faststart-recovery",
    fn: () => faststartRecoveryWorker.sweep(),
    intervalMs: 60_000,
    initialDelayMs: 15_000,
    backoffMs: [5_000, 15_000, 30_000, 60_000],
  });

  // Viewer-count metrics updater: mirrors the v1 broadcastEngine viewer count
  // (sum of WS + SSE + recent REST polls) into the broadcast_viewer_count
  // Prometheus gauge so dashboards/alerts have a single source of truth.
  // v2 doesn't have its own viewer registry yet — the v1 engine is the
  // canonical concurrency signal across all surfaces (admin, TV, mobile).
  // Polled every 5 s so Prometheus scrapes never see stale data even at the
  // most aggressive default scrape interval.
  workerSupervisor.spawn({
    name: "viewer-count-metrics-updater",
    fn: async () => {
      const { broadcastEngine } = await import("../broadcast/queue.engine.js");
      const { broadcastViewerCount, SERVICE_LABELS } = await import(
        "../../infrastructure/metrics.js"
      );
      broadcastViewerCount.set(
        { channel: broadcastEngine.channelId, ...SERVICE_LABELS },
        broadcastEngine.getViewerCount(),
      );
    },
    intervalMs: 5_000,
    initialDelayMs: 5_000,
    backoffMs: [5_000, 15_000, 30_000],
  });

  logger.info("[broadcast-v2] supervised workers registered");
}

let fanoutInitialised = false;

export function ensureBroadcastV2Started(): Promise<void> {
  // Critical ordering fix: install the bus bridge UNCONDITIONALLY before
  // attempting start(). Even if the first start() throws (DB pool not
  // ready, transient network blip, etc.), the bridge is then live so
  // any subsequent admin queue mutation will *try* to reload — and the
  // first reload that succeeds also drives the orchestrator into a
  // started state via reloadInner. This is the difference between
  // "stuck at sequence 0 forever" and "self-recovers within 30 s of
  // any admin write".
  installBusBridge();
  startSupervisedWorkers();

  // Initialise the Redis fan-out once, non-blocking so a Redis outage
  // never delays the HTTP listener from accepting connections.
  if (!fanoutInitialised) {
    fanoutInitialised = true;
    broadcastFanout.init(broadcastOrchestrator).catch((err) =>
      logger.warn({ err }, "[broadcast-v2] fanout init error (non-fatal — standalone mode)"),
    );
  }

  if (broadcastOrchestrator.isStarted()) {
    return Promise.resolve();
  }
  if (!bootInFlight) {
    // Increment startAttempts only when an attempt actually fails (see
    // .catch() below) so successful boots and concurrent callers during
    // the same boot do not burn through the 5→15→30→60 s backoff tiers.
    // Without this gate, two routes calling ensureBroadcastV2Started()
    // during a cold start jumped straight to the 60 s ceiling.
    lastStartAttemptAtMs = Date.now();
    bootInFlight = reEnableAllSuspended()
      .catch((err) =>
        logger.warn({ err }, "[broadcast-v2] startup: reEnableAllSuspended failed (non-fatal)"),
      )
      .then(() => broadcastOrchestrator.start())
      .then(() => {
        lastStartError = null;
        // Run an initial queue integrity validation on successful boot
        // so operators see any pre-existing issues immediately in /diagnostics.
        void queueIntegrityValidator.validate().catch((err) =>
          logger.warn({ err }, "[broadcast-v2] post-boot queue validation failed (non-fatal)"),
        );
        // Install the YouTube live auto-override bridge once the orchestrator
        // is started. Idempotent + safe to call multiple times. Gated by the
        // YOUTUBE_AUTO_OVERRIDE_DISABLE env var and the presence of
        // YOUTUBE_CHANNEL_ID — both checks live in the bridge itself.
        try {
          installYouTubeAutoOverride();
        } catch (err) {
          logger.warn({ err }, "[broadcast-v2] YouTube auto-override install failed (non-fatal)");
        }
      })
      .catch((err) => {
        startAttempts += 1;
        lastStartError = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, attempt: startAttempts },
          "[broadcast-v2] orchestrator start failed — scheduling retry",
        );
        scheduleBootRetry();
        throw err;
      })
      .finally(() => {
        bootInFlight = null;
      });
  }
  return bootInFlight;
}

/**
 * Graceful shutdown for the broadcast-v2 module.
 * 1. Flushes the current playback position checkpoint to the database so
 *    restarts resume from the exact position rather than the last periodic
 *    checkpoint boundary (up to 5 s stale without this flush).
 * 2. Closes the Redis fan-out subscriber and stops the leader renewal timer.
 * Called from main.ts shutdown handler before app.close().
 */
export async function stopBroadcastV2(): Promise<void> {
  await broadcastOrchestrator.flushCheckpointForShutdown().catch((err) =>
    logger.warn({ err }, "[broadcast-v2] final checkpoint flush failed (non-fatal)"),
  );
  await broadcastFanout.close().catch((err) =>
    logger.warn({ err }, "[broadcast-v2] fanout close error (non-fatal)"),
  );
}

export { broadcastOrchestrator, broadcastFanout };
