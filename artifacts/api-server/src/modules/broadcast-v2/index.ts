import type { FastifyInstance } from "fastify";
import { restRoutes } from "./io/rest.routes.js";
import { sseRoutes, closeAllSseSessions } from "./io/sse.gateway.js";
import { wsRoutes, closeAllBroadcastV2WsSessions } from "./io/ws.gateway.js";
import { broadcastOrchestrator } from "./engine/broadcast-orchestrator.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";
import { mediaIntegrityScanner } from "./engine/media-integrity-scanner.js";
import { queueIntegrityValidator } from "./engine/queue-integrity-validator.js";
import { orphanCleanupWorker } from "./engine/orphan-cleanup.js";
import { workerSupervisor } from "./engine/worker-supervisor.js";
import { eventLogRepo } from "./repository/event-log.repo.js";
import { broadcastFanout } from "./io/broadcast-fanout.js";
import { installYouTubeAutoOverride, uninstallYouTubeAutoOverride } from "../youtube-live/auto-override.js";
import { reEnableAllSuspended } from "./repository/queue.repo.js";
import { broadcastHealthMonitorScan, getBroadcastHealthMonitorStatus } from "./engine/broadcast-health-monitor.js";
import { contentRotationScan, getContentRotationStatus } from "./engine/content-rotation.js";
import { queueHealthGuard, getQueueHealthGuardStatus } from "./engine/queue-health-guard.js";
import { scheduleBridgeScan } from "./engine/schedule-bridge.js";
import { startExhaustionMonitor, stopExhaustionMonitor, getExhaustionStatus } from "./engine/queue-exhaustion-monitor.js";
import { startAutoQueueRefill, stopAutoQueueRefill, getAutoRefillStatus } from "./engine/auto-queue-refill.js";
import { refreshStorageStats, getStorageStats } from "../../infrastructure/storage.js";
import { env } from "../../config/env.js";
import { sendAdminAlert } from "../mail/mail.service.js";
import { installDeadAirTracker, getDeadAirStats } from "./engine/dead-air-tracker.js";
import { queueSelfHealingWorker } from "./engine/queue-self-healing-worker.js";
import { faststartRecoveryWorker } from "./engine/faststart-recovery.js";
import { autoHealMonitor } from "./engine/auto-heal-monitor.js";
import { autohealRoutes } from "./io/autoheal.routes.js";
import { uploadQueueReconciler } from "../broadcast/upload-queue-reconciler.js";

export { getExhaustionStatus, getAutoRefillStatus, getStorageStats };
export { getDeadAirStats };

export { getQueueHealthGuardStatus };

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
  await app.register(autohealRoutes);
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
  let validatorPending: NodeJS.Timeout | null = null;
  adminEventBus.on("admin-event", (event: { type: string; data?: unknown }) => {
    // Targeted source-quality upgrade — no full reload needed.
    // faststart.service.ts and transcoder.dispatcher.ts emit this event after
    // a source upgrade completes (MP4→MP4-faststart, MP4→HLS). The orchestrator
    // updates only the matching item's sourceQuality in-place and emits a
    // source.upgraded frame so connected clients see the badge update immediately.
    // The companion broadcast-queue-updated event (emitted at the same time) handles
    // the full reload with the new URL; upgradeItemSource handles the optimistic update.
    if (event.type === "broadcast-source-upgraded") {
      const payload = event.data as { videoId?: string; quality?: string; hlsMasterUrl?: string } | undefined;
      if (payload?.videoId && payload.quality) {
        const quality = payload.quality as "hls" | "mp4_faststart" | "mp4_raw";
        const upgraded = broadcastOrchestrator.upgradeItemSource({ videoId: payload.videoId, quality });
        logger.debug(
          { videoId: payload.videoId, quality, upgraded },
          "[broadcast-v2] bus: broadcast-source-upgraded processed",
        );
      }
      return;
    }
    if (event.type !== "broadcast-queue-updated") return;
    // Debounce orchestrator reload — coalesces drag-reorder bursts.
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
    // Also schedule a queue integrity validation shortly after the reload
    // so auto-fix logic (UNPLAYABLE_CORRUPT_UPLOAD, MISSING_VIDEO_JOIN, etc.)
    // runs immediately on every queue change — not only on the 10-min schedule.
    // Use a longer delay (3 s) than the reload debounce (250 ms) so the
    // orchestrator finishes its reload before the validator reads the queue.
    if (validatorPending) clearTimeout(validatorPending);
    validatorPending = setTimeout(() => {
      validatorPending = null;
      void queueIntegrityValidator.validate().catch((err) =>
        logger.debug({ err }, "[broadcast-v2] post-mutation queue validation failed (non-fatal)"),
      );
    }, 3_000);
    validatorPending.unref?.();
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

/**
 * Factory for a circuit-breaker alert callback shared across all critical
 * supervised workers.  When any worker's circuit breaker opens (i.e. the
 * worker has failed maxConsecutiveFailures times in a row), this fires:
 *   1. An SSE ops-alert so the admin dashboard surfaces a banner immediately.
 *   2. An out-of-band admin email so on-call operators are notified even when
 *      no one has the dashboard open (e.g. overnight).
 *
 * Non-critical workers (viewer-count-metrics-updater) do NOT use this callback
 * because their circuit opening has no user-visible broadcast impact.
 *
 * The callback must never throw — WorkerSupervisor wraps it in try/catch, but
 * being explicitly safe here makes the contract clear at the call site.
 */
function makeCircuitOpenCallback(workerName: string) {
  return (name: string, consecutiveFailures: number): void => {
    try {
      adminEventBus.push("ops-alert", {
        level: "critical",
        title: "Worker Suspended",
        message: `Background worker "${name}" has been suspended after ${consecutiveFailures} consecutive failures. Auto-reset in 10 min.`,
        detail: `Check Diagnostics → Workers for recent error details. The circuit will auto-reset and retry after 10 minutes.`,
        timestamp: new Date().toISOString(),
        source: "worker-supervisor",
        workerName: name,
      });
    } catch { /* non-fatal */ }

    void sendAdminAlert({
      subject: `Temple TV: background worker "${name}" suspended`,
      severity: "critical",
      body: [
        `The background worker "${name}" has been suspended after ${consecutiveFailures} consecutive failures.`,
        "",
        "The circuit breaker will auto-reset and retry after 10 minutes.",
        "",
        "What this means:",
        `  • If this is "broadcast-health-monitor" → stuck broadcasts may not self-recover.`,
        `  • If this is "queue-integrity-validator" → corrupt/unplayable items won't be auto-deactivated.`,
        `  • If this is "faststart-recovery" → MP4-only items may stay off-air.`,
        `  • If this is "media-integrity-scanner" → dead CDN URLs won't be proactively detected.`,
        "",
        "Action: check the admin dashboard → Diagnostics → Workers for the most recent error.",
        "If the issue persists after auto-reset, investigate the underlying cause and restart the server.",
      ].join("\n"),
    }).catch((err: unknown) => {
      logger.warn({ worker: workerName, err }, "[broadcast-v2] circuit-open admin alert email failed (non-fatal)");
    });
  };
}

function startSupervisedWorkers(): void {
  if (supervisedWorkersStarted) return;
  supervisedWorkersStarted = true;

  // Media integrity scanner: probes all active queue item URLs every 2 min.
  // Initial delay is configurable via MEDIA_SCANNER_INITIAL_DELAY_MS (default
  // 90 s) so transient 502/503 responses during a production restart window
  // don't generate false-positive "unreachable (first detection)" warnings.
  workerSupervisor.spawn({
    name: "media-integrity-scanner",
    fn: () => mediaIntegrityScanner.scan(),
    intervalMs: 2 * 60_000,
    initialDelayMs: env.MEDIA_SCANNER_INITIAL_DELAY_MS,
    backoffMs: [5_000, 15_000, 30_000, 60_000],
    onCircuitOpen: makeCircuitOpenCallback("media-integrity-scanner"),
  });

  // Orphan cleanup: sweeps stale event-log + orphaned queue refs every 4 h
  workerSupervisor.spawn({
    name: "orphan-cleanup",
    fn: () => orphanCleanupWorker.sweep(),
    intervalMs: 4 * 60 * 60_000,
    initialDelayMs: 10 * 60_000,
    backoffMs: [30_000, 60_000, 5 * 60_000],
  });

  // Event log pruner: deletes broadcast_event_log rows older than 24 h so
  // the table stays bounded regardless of uptime. Complements the per-channel
  // sequence-based trim (which keeps the last 1000 events per channel but
  // doesn't delete by age). Runs every 6 h with a 30 min initial delay so it
  // starts after the system is fully warmed up. Non-fatal: any failure is
  // logged and retried on the next scheduled run.
  workerSupervisor.spawn({
    name: "event-log-pruner",
    fn: () => eventLogRepo.pruneOldEvents(),
    intervalMs: 6 * 60 * 60_000,
    initialDelayMs: 30 * 60_000,
    backoffMs: [5 * 60_000, 15 * 60_000, 30 * 60_000],
  });

  // Queue integrity validator: validates active queue on demand; also runs
  // every 2 min so new additions and transcoding completions are caught
  // quickly without waiting for the bus bridge trigger. The bus bridge
  // (above) also triggers a run 3 s after every broadcast-queue-updated
  // event — including transcoding failures — so corrupt/failed items are
  // deactivated well within the 2-min window. Reduced from 5 min to 2 min
  // and initial delay from 30 s to 10 s so fresh uploads are validated within
  // minutes of being queued.
  workerSupervisor.spawn({
    name: "queue-integrity-validator",
    fn: () => queueIntegrityValidator.validate(),
    intervalMs: 2 * 60_000,
    initialDelayMs: 10_000,
    backoffMs: [5_000, 15_000, 30_000],
    onCircuitOpen: makeCircuitOpenCallback("queue-integrity-validator"),
  });

  // Viewer-count metrics updater: uses native V2 WS+SSE connection counts from
  // the broadcast-v2 gateways directly — no V1 broadcastEngine dependency.
  // WS (_activeSockets) + SSE (openSseSenders) together cover every connected
  // player surface (admin preview, TV, mobile, web). Polled every 5 s so
  // Prometheus scrapes never see stale data at any standard scrape interval.
  workerSupervisor.spawn({
    name: "viewer-count-metrics-updater",
    fn: async () => {
      const { getBroadcastV2WsViewerCount } = await import("./io/ws.gateway.js");
      const { getBroadcastV2SseViewerCount } = await import("./io/sse.gateway.js");
      const { broadcastViewerCount, SERVICE_LABELS } = await import(
        "../../infrastructure/metrics.js"
      );
      const total = getBroadcastV2WsViewerCount() + getBroadcastV2SseViewerCount();
      broadcastViewerCount.set(
        { channel: broadcastOrchestrator.channelId, ...SERVICE_LABELS },
        total,
      );
    },
    intervalMs: 5_000,
    initialDelayMs: 5_000,
    backoffMs: [5_000, 15_000, 30_000],
    // No onCircuitOpen — viewer-count silently stalling has no broadcast impact.
  });

  // Broadcast Health Monitor: external orchestrator watchdog that detects
  // sequence staleness from outside the orchestrator's own self-heal loop.
  // Tier 1 (STALE_MS=3min): calls reload(). Tier 2 (RECOVERY_MS=7min):
  // calls initiateFullRecovery() and emits ops-alert + broadcast webhook.
  // Initial delay reduced from 90 s → 45 s → 10 s: the orchestrator completes
  // its first reload in ~5 s; 10 s gives just enough grace for the first queue
  // load to settle before the health monitor starts checking for staleness.
  // Faster first pass means duration-backfill (via the sweep inside the monitor)
  // runs sooner, so newly-uploaded MP4s with 1800-s placeholder durations are
  // corrected before the first broadcast cycle fires.
  workerSupervisor.spawn({
    name: "broadcast-health-monitor",
    fn: () => broadcastHealthMonitorScan(),
    intervalMs: 60_000,
    initialDelayMs: 10_000,
    backoffMs: [15_000, 30_000, 60_000],
    onCircuitOpen: makeCircuitOpenCallback("broadcast-health-monitor"),
  });

  // Content Rotation Worker: shuffles broadcast queue sort_order periodically
  // so 24/7 broadcasts play content in a fresh order rather than the same
  // cycle forever. BROADCAST_ROTATION_STRATEGY=fifo disables the shuffle.
  //
  // initialDelayMs uses BROADCAST_ROTATION_INITIAL_DELAY_MS (default 3 min)
  // instead of the full rotation interval so the queue gets a fresh shuffle
  // shortly after every restart — not after waiting the full 30-minute window.
  // Subsequent shuffles use the full BROADCAST_ROTATION_INTERVAL_MS cadence.
  workerSupervisor.spawn({
    name: "content-rotation",
    fn: () => contentRotationScan(),
    intervalMs: env.BROADCAST_ROTATION_INTERVAL_MS,
    initialDelayMs: env.BROADCAST_ROTATION_INITIAL_DELAY_MS,
    backoffMs: [60_000, 5 * 60_000, 10 * 60_000],
    onCircuitOpen: makeCircuitOpenCallback("content-rotation"),
  });

  // Queue Reconciliation Guard: continuous full-library reconciliation that
  // ensures every eligible video is in the active broadcast queue.  Also
  // repairs zero-duration items and re-enables system-deactivated rows.
  //
  // Runs unconditionally (not gated on QUEUE_MIN_ITEMS > 0) because the
  // reconciliation is needed regardless of the minimum-threshold setting —
  // its primary purpose is ensuring all eligible videos enter rotation, not
  // just filling up to a threshold.
  //
  // Initial delay: 90 s — lets the DB pool warm, the integrity validator
  // run its first pass (which may deactivate invalid items), and the
  // orchestrator complete its first reload before we scan the full library.
  workerSupervisor.spawn({
    name: "queue-health-guard",
    fn: () => queueHealthGuard.scan(),
    intervalMs: 3 * 60_000,
    initialDelayMs: 90_000,
    backoffMs: [30_000, 60_000, 3 * 60_000],
    onCircuitOpen: makeCircuitOpenCallback("queue-health-guard"),
  });

  // Storage cleanup worker: sweeps orphaned upload sessions, expired corrupt
  // blobs, and stuck transcoding jobs. Runs every 30 min with a 5-min initial
  // delay so the system is fully warmed up before the first sweep.
  workerSupervisor.spawn({
    name: "storage-cleanup",
    fn: async () => {
      const { cleanupWorker } = await import("../media-uploads/cleanup.worker.js");
      await cleanupWorker.sweep();
    },
    intervalMs: 30 * 60_000,
    initialDelayMs: 5 * 60_000,
    backoffMs: [5 * 60_000, 15 * 60_000, 30 * 60_000],
  });

  // Schedule-to-Air Bridge: reads schedule_entries once per minute and fires
  // broadcast actions (override start, video enqueue, library scan) for entries
  // whose startTime matches the current wall-clock minute. Provides a direct
  // bridge between the programming calendar and the live broadcast engine.
  // Initial delay of 65 s aligns the first check with the next minute boundary
  // after a restart so the first check is never a false-negative mid-minute.
  workerSupervisor.spawn({
    name: "schedule-bridge",
    fn: () => scheduleBridgeScan(),
    intervalMs: 60_000,
    initialDelayMs: 65_000,
    backoffMs: [15_000, 30_000, 60_000],
  });

  // Storage capacity stats: refreshes total storage bytes + blob count from
  // object storage every 5 minutes and exposes them via getStorageStats() +
  // the /health endpoint. Initial delay of 30 s ensures DB is warm.
  workerSupervisor.spawn({
    name: "storage-capacity-stats",
    fn: () => refreshStorageStats(),
    intervalMs: 5 * 60_000,
    initialDelayMs: 30_000,
    backoffMs: [60_000, 5 * 60_000],
  });

  // Queue Self-Healing Worker: proactively detects quarantined / blocked /
  // unhealthy queue items and attempts automated repair (bad-URL cache clear,
  // re-probe, source-set clearance).  Runs every 2 min with a 5-min initial
  // delay so the integrity validator and media scanner have already completed
  // their first passes before the self-healer acts on their findings.
  // onCircuitOpen fires an ops-alert + admin email so the team is notified
  // if repair attempts fail repeatedly (e.g. persistent CDN outage).
  workerSupervisor.spawn({
    name: "queue-self-healing",
    fn: () => queueSelfHealingWorker.scan(),
    intervalMs: 2 * 60_000,
    initialDelayMs: 5 * 60_000,
    backoffMs: [30_000, 60_000, 2 * 60_000],
    onCircuitOpen: makeCircuitOpenCallback("queue-self-healing"),
  });

  // Faststart recovery worker: finds videos stuck in 'processing' (>15 min)
  // or marked 'ready' with faststartApplied=false, then re-runs the moov
  // relocation pipeline.  After max 3 attempts it permanently flags the row
  // and alerts ops so a human can review. Runs every 5 min; initial 3 min
  // delay lets the finalize background task finish its own faststart pass
  // before the recovery worker steps in.
  workerSupervisor.spawn({
    name: "faststart-recovery",
    fn: () => faststartRecoveryWorker.sweep(),
    intervalMs: 5 * 60_000,
    initialDelayMs: 3 * 60_000,
    backoffMs: [30_000, 60_000, 2 * 60_000],
    onCircuitOpen: makeCircuitOpenCallback("faststart-recovery"),
  });

  // Upload Queue Reconciler: final safety-net for the upload→queue pipeline.
  // Catches any upload whose primary enqueue call was silently dropped due to
  // a transient DB blip, process crash between blob commit and enqueue, or a
  // failed s3MirroredAt stamp. Scans local videos uploaded in the last 24 h
  // that have a confirmed blob (s3MirroredAt IS NOT NULL) but no active queue
  // row, and enqueues them immediately. Runs every 60 s with a 30 s initial
  // delay so the DB is warm and the first integrity-validator pass has run.
  workerSupervisor.spawn({
    name: "upload-queue-reconciler",
    fn: () => uploadQueueReconciler.scan(),
    intervalMs: 60_000,
    initialDelayMs: 30_000,
    backoffMs: [15_000, 30_000, 60_000],
  });

  // Queue exhaustion monitor + auto-refill run as lightweight interval-based
  // processes (not supervised workers) since they are computation-light and
  // must not count against the worker circuit-breaker budget.
  startExhaustionMonitor();
  startAutoQueueRefill();

  // Dead-air incident tracker: monitors orchestrator frame stream to record
  // every period the channel is off-air (no item, no override). Install after
  // all workers so the orchestrator is likely started on first frame.
  installDeadAirTracker();

  // Auto-Heal Monitor: 5-second lightweight watchdog that detects and responds
  // to acute failures (stuck sequence, dead air, empty queue, worker circuit opens,
  // memory pressure) faster than the longer-interval supervised workers.
  // Started after all workers so getWorkerStatuses() returns a full picture.
  autoHealMonitor.start();

  logger.info("[broadcast-v2] supervised workers registered");
}

let fanoutInitialised = false;
let fanoutRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Try to initialise the Redis fan-out.  If Redis is unavailable (standalone
 * mode), schedules a retry every 60 s so the fanout comes online automatically
 * once Redis recovers — without requiring a process restart.
 *
 * Idempotent: no-op once the fanout is successfully initialised.
 */
function tryInitFanout(): void {
  if (fanoutInitialised) return;
  broadcastFanout
    .init(broadcastOrchestrator)
    .then(() => {
      fanoutInitialised = true;
      if (fanoutRetryTimer !== null) {
        clearTimeout(fanoutRetryTimer);
        fanoutRetryTimer = null;
      }
      logger.info("[broadcast-v2] fanout initialised (role: %s)", broadcastFanout.getRole());
    })
    .catch((err) => {
      logger.warn({ err }, "[broadcast-v2] fanout init failed — retrying in 60 s (standalone mode)");
      // Schedule another attempt; clear any previous timer to avoid stacking.
      if (fanoutRetryTimer !== null) clearTimeout(fanoutRetryTimer);
      fanoutRetryTimer = setTimeout(() => {
        fanoutRetryTimer = null;
        tryInitFanout();
      }, 60_000);
      fanoutRetryTimer.unref?.();
    });
}

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

  // Initialise the Redis fan-out (with auto-retry on failure) so a Redis
  // outage at boot doesn't permanently strand the instance in standalone
  // mode — it will recover the moment Redis becomes available.
  tryInitFanout();

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
      .then(async () => {
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
        try {
          const { installYoutubeLiveStatusService } = await import("../youtube-live/live-status.service.js");
          installYoutubeLiveStatusService();
        } catch (err) {
          logger.warn({ err }, "[broadcast-v2] YouTube live-status service install failed (non-fatal)");
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
 *
 * Order of operations matters:
 *  1. Cancel pending boot/fanout retry timers so they never fire after
 *     shutdown begins (prevents a re-init race during app.close()).
 *  2. Force-close all open SSE streams so main.ts drain loop completes
 *     promptly (each connection is in sseCounter — ending them decrements
 *     the counter so the drain loop exits cleanly instead of timing out).
 *  3. Stop all supervised workers (media-scanner, orphan-cleanup,
 *     queue-validator, faststart-recovery, viewer-count-updater) — each
 *     runs on a timer and may hold open DB connections.
 *  4. Stop the orchestrator — clears its 7 internal timers (tick,
 *     checkpoint, trim, keepAlive, selfHealEmpty, selfHealStale,
 *     currentItemProbe) so the event loop can drain.
 *  5. Flush the final checkpoint so restarts resume from the exact
 *     playback position rather than the last periodic boundary.
 *  6. Close the Redis fan-out subscriber and leader renewal timer.
 *
 * Called from main.ts shutdown handler before app.close().
 */
export async function stopBroadcastV2(): Promise<void> {
  // 1. Cancel pending retry timers first — prevents any re-init after shutdown.
  if (bootRetryTimer) {
    clearTimeout(bootRetryTimer);
    bootRetryTimer = null;
  }
  if (fanoutRetryTimer) {
    clearTimeout(fanoutRetryTimer);
    fanoutRetryTimer = null;
  }

  // 2. Force-close all open SSE and WebSocket streams immediately so the
  //    main.ts drain loop can complete without waiting for SHUTDOWN_DRAIN_MS.
  //    SSE clients receive no close frame; WS clients get a clean terminate()
  //    which sends a Close frame before tearing down the socket.
  closeAllSseSessions();
  closeAllBroadcastV2WsSessions();

  // 3b. Stop supervised workers (clears their internal timers + circuit-reset timers).
  workerSupervisor.stopAll();
  supervisedWorkersStarted = false;
  stopExhaustionMonitor();
  stopAutoQueueRefill();

  // 4. Stop the orchestrator — clears 7 internal setInterval timers.
  broadcastOrchestrator.stop();

  // 5. Flush checkpoint so restart resumes from the correct playback position.
  await broadcastOrchestrator.flushCheckpointForShutdown().catch((err) =>
    logger.warn({ err }, "[broadcast-v2] final checkpoint flush failed (non-fatal)"),
  );

  // 6. Uninstall YouTube live services. These are installed on successful boot
  //    and run on their own timers. uninstallYouTubeAutoOverride clears the
  //    polling interval and the event listener; uninstallYoutubeLiveStatusService
  //    clears its setInterval sweep timer. Both are no-ops if not installed.
  uninstallYouTubeAutoOverride();
  await import("../youtube-live/live-status.service.js")
    .then(({ uninstallYoutubeLiveStatusService }) => uninstallYoutubeLiveStatusService())
    .catch((err) =>
      logger.warn({ err }, "[broadcast-v2] YouTube live-status service uninstall failed (non-fatal)"),
    );

  // 6b. Stop the YouTube live poller itself.
  //     uninstallYouTubeAutoOverride() un-subscribes listeners but does NOT stop
  //     the poller's 60-second setInterval.  The timer is .unref()ed so it won't
  //     block process exit — but it fires between SIGTERM and pool.end(), causing
  //     "Cannot use a pool after calling end" warnings in production logs.
  //     Explicit stop gives clean shutdown logs on every rolling deploy.
  await import("../youtube-live/youtube-live.poller.js")
    .then(({ ytPoller }) => ytPoller.stop())
    .catch((err) =>
      logger.warn({ err }, "[broadcast-v2] YouTube live poller stop failed (non-fatal)"),
    );

  // 7. Close Redis fan-out subscriber and leader renewal timer.
  await broadcastFanout.close().catch((err) =>
    logger.warn({ err }, "[broadcast-v2] fanout close error (non-fatal)"),
  );
}

export { broadcastOrchestrator, broadcastFanout, getBroadcastHealthMonitorStatus, getContentRotationStatus, mediaIntegrityScanner };
