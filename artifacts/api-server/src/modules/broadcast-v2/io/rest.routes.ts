import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { broadcastOrchestrator } from "../engine/broadcast-orchestrator.js";
import { eventLogRepo } from "../repository/event-log.repo.js";
import { getBroadcastV2BootStatus, broadcastFanout, getBroadcastHealthMonitorStatus, getContentRotationStatus, getQueueHealthGuardStatus } from "../index.js";
import { getDbPoolHealthStatus } from "../../../infrastructure/db-pool-health.js";
import { getStorageHealthStatus } from "../../../infrastructure/storage-health-monitor.js";
import { prodQueueSync } from "../../prod-sync/prod-queue-sync.js";
import { getViewerSlopeStatus } from "../../admin-ops/viewer-slope-monitor.js";
import { registerNamedStore } from "../../../infrastructure/cache.js";
import { getYouTubeAutoOverrideStats } from "../../youtube-live/auto-override.js";
import {
  ForceFailoverCommand,
  PlayNowCommand,
  ReportStallCommand,
  SkipCommand,
  StartOverrideCommand,
  StopOverrideCommand,
} from "../domain/commands.js";
import { requireAuth } from "../../../middleware/auth.js";
import { broadcastService } from "../../broadcast/broadcast.service.js";
import { scanLibraryAndEnqueue, listMissingFromQueue } from "../../broadcast/auto-enqueue.service.js";
import { markBadUrl, markBadUrlWithTtl, clearAllBadUrls, getItemsHealth, queueRepo, incrementBadUrlSkipCount, autoSuspendQueueItem, BAD_URL_SKIP_THRESHOLD, SUSPENSION_TTL_MS, getRecentlySuspended, reEnableAllSuspended, normalizeQueueUrl } from "../repository/queue.repo.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { faststartRecoveryWorker } from "../engine/faststart-recovery.js";
import { db, schema } from "../../../infrastructure/db.js";
import { eq, and, isNull, isNotNull, sql, inArray } from "drizzle-orm";
import { enqueueTranscode, boostTranscodePriority } from "../../transcoder/transcoder.queue.js";
import { transcoderDispatcher } from "../../transcoder/transcoder.dispatcher.js";
import { logger } from "../../../infrastructure/logger.js";
import { mediaIntegrityScanner } from "../engine/media-integrity-scanner.js";
import { queueIntegrityValidator } from "../engine/queue-integrity-validator.js";
import { workerSupervisor } from "../engine/worker-supervisor.js";
import { orphanCleanupWorker } from "../engine/orphan-cleanup.js";
import { playbackAnalytics } from "../engine/playback-analytics.js";
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { env } from "../../../config/env.js";
import {
  getWebhookStatus,
  isWebhookConfigured,
  sendBroadcastWebhookSync,
} from "../webhook/webhook.service.js";
import { runFaststart } from "../../transcoder/faststart.service.js";
import { driftAggregator } from "../engine/drift-aggregator.js";

const adminGuard = { preHandler: requireAuth("editor") } as const;
const adminOnlyGuard = { preHandler: requireAuth("admin") } as const;
// userGuard kept for future per-viewer routes — unused at module level now
const _userGuard = { preHandler: requireAuth("user") } as const; void _userGuard;

// Per-process idempotency cache. Architect-flagged: we accept the same
// `idempotencyKey` only once within a 5-minute window per channel.
// Note: single-process design (Replit single-instance). In a load-balanced
// multi-instance environment this should move to Redis.
const seenIdempotencyKeys = new Map<string, number>();
registerNamedStore("broadcast-v2-idempotency-keys", () => seenIdempotencyKeys.size);
const IDEMPOTENCY_TTL_MS = 5 * 60_000;
function checkIdempotency(key: string): boolean {
  const now = Date.now();
  // Lazy GC: prune on size threshold
  if (seenIdempotencyKeys.size > 500) {
    for (const [k, ts] of seenIdempotencyKeys) {
      if (now - ts > IDEMPOTENCY_TTL_MS) seenIdempotencyKeys.delete(k);
    }
  }
  const seen = seenIdempotencyKeys.get(key);
  if (seen && now - seen < IDEMPOTENCY_TTL_MS) return false;
  seenIdempotencyKeys.set(key, now);
  return true;
}

// ── naturalItemEnd dedup ──────────────────────────────────────────────────────
// When a video ends, every connected player simultaneously POSTs /natural-end.
// This causes a thundering-herd: 50+ concurrent HTTP requests all entering the
// orchestrator's naturalItemEnd() in the same event-loop drain cycle. Although
// the orchestrator is safe (the first call advances cycleStartedAtMs and all
// subsequent callers get `snap.current.id !== itemId`), the burst still creates
// unnecessary DB connections (persistCheckpoint), log noise, and CPU pressure.
//
// This dedup map short-circuits the route handler itself: only ONE request per
// `${itemId}:${cycleAnchor}` passes through to the orchestrator within a 10 s
// window. The rest return `{ ok: true, advanced: false, reason: "dedup" }`.
// 10 s covers the typical "all players fire within 2-3 s of each other" window
// while being short enough that a legitimate second call on the NEXT cycle
// (same itemId, next loop iteration) is not suppressed.
const naturalEndDedup = new Map<string, number>();
const NATURAL_END_DEDUP_TTL_MS = 10_000;

// Scheduled GC: sweep both maps every 10 minutes regardless of traffic
// so stale entries don't accumulate during quiet periods (e.g. overnight).
const _idempotencyGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of seenIdempotencyKeys) {
    if (now - ts > IDEMPOTENCY_TTL_MS) seenIdempotencyKeys.delete(k);
  }
  for (const [k, ts] of naturalEndDedup) {
    if (now - ts > NATURAL_END_DEDUP_TTL_MS) naturalEndDedup.delete(k);
  }
}, 10 * 60_000);
// Allow Node to exit cleanly even if this module is loaded in a test context.
_idempotencyGcTimer.unref?.();

// Process boot time — used by /health to surface uptime so external
// monitors can correlate `sequence=0` with "just restarted" vs
// "stuck for an hour". Kept module-scoped so the value is stable
// across the lifetime of the API process.
const PROCESS_BOOTED_AT_MS = Date.now();

// ── Auto-enqueue missing HLS ─────────────────────────────────────────────────
// Scans every active queue item backed by a local video that has no
// hlsMasterUrl and enqueues a high-priority HLS job for each one.
//
// Used by both the /prepare-hls operator endpoint and the boot-time background
// scan so the same idempotent logic runs in both contexts.
//
// enqueueTranscode handles all cases:
//   • No job exists          → INSERT a new queued job at priority 10
//   • Existing failed job    → re-arm (reset attempts, status = queued)
//   • Queued/processing job  → leave it, return existing id (idempotent)
//   • Done job with HLS set  → skipped by the hlsMasterUrl IS NULL filter
//
// In-flight guard: if a scan is already running (e.g. boot timer and an
// event both fire within the same 200 ms window on Render multi-instance,
// or a route call races the timer), the second invocation is a no-op.
// This prevents duplicate FFmpeg jobs and redundant DB round-trips.
let _hlsScanInFlight = false;

// Boot-scan guard: registerDomainRoutes is registered twice in app.ts
// (once for /api/v1 and once for /api legacy prefix). Without this guard
// two separate _bootHlsScanTimer instances would be created — one fires,
// completes in <300 ms, and the second fires immediately after, causing a
// redundant DB scan and an unnecessary orchestrator reload on every restart.
// Module-scoped so it survives both plugin instantiations in the same process.
let _bootScanScheduled = false;
async function autoEnqueueMissingHls(): Promise<{ triggered: number }> {
  if (_hlsScanInFlight) {
    logger.info("[broadcast-v2] auto-enqueue-missing-hls: scan already in flight, skipping");
    return { triggered: 0 };
  }
  _hlsScanInFlight = true;
  try {
    return await _doAutoEnqueueMissingHls();
  } finally {
    _hlsScanInFlight = false;
  }
}
// How long to suppress a missing-HLS item's URL in the bad-URL cache.
// Matches SUSPENSION_TTL_MS (5 min) from queue.repo so the item stays
// out of the orchestrator's rotation while transcoding is in progress.
// Once the TTL expires the orchestrator tries again — if HLS is still
// absent another autoEnqueueMissingHls call re-suppresses it.
const MISSING_HLS_SUPPRESS_TTL_MS = SUSPENSION_TTL_MS;

async function _doAutoEnqueueMissingHls(): Promise<{ triggered: number }> {
  const q = schema.broadcastQueueTable;
  const v = schema.videosTable;
  let rows: Array<{
    videoId: string | null;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    transcodingStatus: string | null;
  }>;
  try {
    rows = await db
      .select({
        videoId: q.videoId,
        localVideoUrl: v.localVideoUrl,
        hlsMasterUrl: v.hlsMasterUrl,
        transcodingStatus: v.transcodingStatus,
      })
      .from(q)
      .leftJoin(v, eq(q.videoId, v.id))
      .where(
        and(
          eq(q.isActive, true),
          isNotNull(q.videoId),
          isNull(v.hlsMasterUrl),
        ),
      );
  } catch (err) {
    logger.warn({ err }, "[broadcast-v2] auto-enqueue-missing-hls: DB query failed (non-fatal)");
    return { triggered: 0 };
  }

  let triggered = 0;
  for (const row of rows) {
    if (!row.videoId || !row.localVideoUrl) continue;
    if (row.transcodingStatus === "hls_ready") continue;
    await enqueueTranscode({
      videoId: row.videoId,
      videoPath: row.localVideoUrl,
      priority: 10,
    }).catch((err: unknown) => {
      logger.warn({ err, videoId: row.videoId }, "[broadcast-v2] auto-enqueue-missing-hls: enqueueTranscode error (non-fatal)");
    });
    // Also boost any already-queued job — enqueueTranscode doesn't change
    // priority on existing queued rows so we need the explicit boost.
    void boostTranscodePriority(row.videoId, 10).catch((err: unknown) => {
      logger.warn({ err, videoId: row.videoId }, "[broadcast-v2] auto-enqueue-missing-hls: boostTranscodePriority error (non-fatal)");
    });

    // ── Suppress this item's raw MP4 URL in the bad-URL cache ────────────
    // Without this, the orchestrator keeps serving the raw localVideoUrl as
    // a fallback while transcoding is queued — but that MP4 often fails too
    // (missing faststart, large file, or blob absent from storage), causing:
    //   RECOVERING_PRIMARY → RECOVERING_FAILOVER → SKIP_PENDING (×3) → FATAL
    // for every player. Marking the URL bad immediately removes the item from
    // the orchestrator's rotation for MISSING_HLS_SUPPRESS_TTL_MS (5 min),
    // causing snapshot().current to advance to the next playable item. The
    // item auto-recovers once HLS transcoding completes (the bad-URL entry
    // expires and the HLS URL replaces the raw MP4 as the primary source).
    const suppressUrl = normalizeQueueUrl(row.localVideoUrl);
    if (suppressUrl) {
      markBadUrlWithTtl(suppressUrl, MISSING_HLS_SUPPRESS_TTL_MS);
    }

    triggered++;
  }
  if (triggered > 0) {
    void broadcastOrchestrator.reload().catch((err) => {
      logger.warn({ err }, "[broadcast-v2] auto-enqueue-missing-hls: background reload failed (non-fatal)");
    });
    transcoderDispatcher.nudge();
  }
  logger.info({ triggered }, "[broadcast-v2] auto-enqueue-missing-hls: scan complete");
  return { triggered };
}

// ── Remote-transcode disk pre-flight ────────────────────────────────────────
//
// Before the route creates any DB rows or kicks off a download it checks:
//   1. Content-Length of the remote source via HTTP HEAD (10 s timeout).
//   2. Free bytes on the transcoder scratch filesystem via statfs.
//
// Required headroom = REMOTE_TRANSCODE_DISK_MULTIPLIER × Content-Length:
//   1× for the raw download on disk
//   ≈3× for multi-rendition HLS segments + manifest files + thumbnail
// Total = 4×. This matches the existing in-transcoder check (3× source size
// already on disk) so both gates use the same conservative bound.
//
// Returns a human-readable error string when space is tight, null when the
// check passes or cannot be performed (absent Content-Length, statfs error,
// or HEAD failure).  All failures are non-fatal so operators aren't blocked
// when the remote origin doesn't support HEAD or omits the header.
const REMOTE_TRANSCODE_DISK_MULTIPLIER = 4;

async function checkRemoteTranscodeDiskSpace(
  sourceUrl: string,
  itemId: string,
): Promise<string | null> {
  try {
    const headRes = await fetch(sourceUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    if (!headRes.ok) return null; // non-2xx — URL issue, not a disk issue

    const rawLen = headRes.headers.get("content-length");
    if (!rawLen) return null; // server didn't advertise size — skip check

    const remoteBytes = parseInt(rawLen, 10);
    if (!Number.isFinite(remoteBytes) || remoteBytes <= 0) return null;

    // Check the filesystem where the transcoder scratch dir lives.
    // Fall back to os.tmpdir() if the scratch root doesn't exist yet (first boot).
    const scratchRoot = env.TRANSCODER_SCRATCH_DIR ?? path.join(os.tmpdir(), "transcoder");
    const fsInfo = await statfs(scratchRoot).catch(() => statfs(os.tmpdir()));
    const availableBytes = fsInfo.bavail * fsInfo.bsize;
    const requiredBytes = remoteBytes * REMOTE_TRANSCODE_DISK_MULTIPLIER;

    if (availableBytes < requiredBytes) {
      const remoteMb  = Math.round(remoteBytes   / 1024 / 1024);
      const requiredMb = Math.round(requiredBytes / 1024 / 1024);
      const availMb   = Math.round(availableBytes / 1024 / 1024);
      return (
        `Insufficient disk space for remote transcode. ` +
        `The remote source is ~${remoteMb} MB; ` +
        `download + HLS encoding needs ~${requiredMb} MB ` +
        `(${REMOTE_TRANSCODE_DISK_MULTIPLIER}× for raw download + multi-rendition HLS segments) ` +
        `but only ${availMb} MB is free on the transcoder scratch filesystem. ` +
        `Free up disk space and retry.`
      );
    }

    logger.info(
      { itemId, remoteBytes, availableBytes, requiredBytes, scratchRoot },
      "[broadcast-v2] remote transcode disk pre-flight passed",
    );
    return null;
  } catch (err) {
    // Non-fatal: HEAD or statfs failure must not block the operator.
    logger.warn(
      { itemId, sourceUrl, err: String(err) },
      "[broadcast-v2] remote transcode disk pre-flight skipped (HEAD or statfs failed)",
    );
    return null;
  }
}

export async function restRoutes(app: FastifyInstance) {
  // ── Shared response schemas ───────────────────────────────────────────
  // Defined once at the top of the function (not module scope) to avoid
  // the temporal dead zone when referenced by the first routes registered.
  const _400err = z.object({ error: z.string() });
  const _429err = z.object({ error: z.string() });
  const _200ok = z.object({ ok: z.literal(true), duplicate: z.boolean().optional() });
  const _200okSeq = z.object({
    ok: z.literal(true),
    sequence: z.number().int().nonnegative(),
    duplicate: z.boolean().optional(),
    reEnabled: z.number().int().optional(),
  });

  // ── Public: lightweight health probe ─────────────────────────────────
  // Unauthenticated, in-memory only (no DB round-trip), safe to expose
  // on the open internet. Designed for external uptime monitors and
  // for the operator's "is v2 actually loading the queue?" question.
  // A healthy v2 with a populated queue should report `sequence > 0`
  // and `mode != "idle"` within ~10s of any queue mutation. Persistent
  // `sequence: 0` with `uptimeMs > 30000` is the signature of the bug
  // we hit in May 2026 where the orchestrator booted into an empty
  // queue and never reloaded — `scheduleSelfHealReload()` should make
  // that impossible now, but the probe stays as a safety net.
  app.get("/health", {
    schema: { response: { 429: _429err } },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const snap = broadcastOrchestrator.snapshot();
    const boot = getBroadcastV2BootStatus();
    const reload = broadcastOrchestrator.getReloadStats();
    const sync = prodQueueSync.getStatus();
    const sequence = broadcastOrchestrator.getSequence();
    const itemCount = broadcastOrchestrator.getItemCount();
    const uptimeMs = Date.now() - PROCESS_BOOTED_AT_MS;
    // Composite "stuck" indicator so external monitors don't have to
    // reproduce the signature locally. True iff the orchestrator booted
    // (>30s uptime), the bus bridge is installed, the queue has items,
    // but the sequence has never advanced — the exact pathology from
    // the May 2026 broadcast-v2 boot-resilience incident. Empty-queue
    // sequence:0 is NOT stuck; an unbooted process is NOT stuck.
    const stuck =
      sequence === 0 &&
      uptimeMs > 30_000 &&
      itemCount > 0 &&
      boot.busBridgeInstalled === true &&
      boot.started === true;

    // Post-start sequence-stale detection: catches hangs where the orchestrator
    // booted and advanced at least once (sequence > 0) but its tick loop has
    // since died or gotten stuck. Only flagged when the queue is non-empty — an
    // empty queue that has never advanced since restart is not stale, just idle.
    //
    // IMPORTANT: when an item is actively playing, the sequence legitimately
    // won't advance until item.advanced fires at end-of-item. A fixed 5-minute
    // threshold would false-positive on any sermon/video longer than 5 minutes.
    // We only mark stale when elapsed has exceeded the item's own duration plus
    // a 2-minute grace period — meaning the orchestrator should have fired
    // item.advanced but didn't (genuine loop/stuck). When there is no current
    // item, the plain 5-minute threshold still applies.
    const SEQUENCE_STALE_THRESHOLD_MS = 5 * 60_000; // 5 minutes (no-current fallback)
    const SEQUENCE_STALE_GRACE_MS = 2 * 60_000;     // 2-minute post-item grace
    const lastSequenceAdvanceMs = broadcastOrchestrator.getLastSequenceAdvanceMs();
    const sequenceStaleSec = Math.floor((Date.now() - lastSequenceAdvanceMs) / 1000);
    // If a current item is playing and elapsed < duration + grace, the sequence
    // is NOT stale — item.advanced simply hasn't fired yet.
    const currentItemElapsedMs = snap.current != null
      ? Math.max(0, Date.now() - snap.current.startsAtMs)
      : 0;
    const currentItemDurationMs = snap.current != null
      ? snap.current.durationSecs * 1000
      : 0;
    const withinPlaybackWindow =
      snap.current != null &&
      currentItemElapsedMs < currentItemDurationMs + SEQUENCE_STALE_GRACE_MS;
    const sequenceStale =
      sequence > 0 &&
      itemCount > 0 &&
      Date.now() - lastSequenceAdvanceMs > SEQUENCE_STALE_THRESHOLD_MS &&
      !withinPlaybackWindow;

    const allBlocked = broadcastOrchestrator.getAllBlockedInfo();
    const now = Date.now();

    // Public fields — safe to expose to unauthenticated uptime monitors and
    // player clients. Reveals only broadcast liveness state (no internal
    // infra metrics, no blocked-source URL list, no airing history).
    const publicPayload = {
      ok: !stuck && !sequenceStale,
      stuck,
      sequenceStale,
      sequenceStaleSec,
      channelId: broadcastOrchestrator.channelId,
      sequence,
      mode: snap.mode,
      hasCurrent: snap.current !== null,
      hasOverride: snap.override !== null,
      failoverActive: snap.failover.active,
      /** Current item title — null when off air or in override mode. */
      currentTitle: snap.current?.title ?? null,
      /** Next item title — null when queue has ≤1 active item. */
      nextTitle: snap.next?.title ?? null,
      /** Current item duration in seconds — useful for monitoring dashboards. */
      currentDurationSecs: snap.current?.durationSecs ?? null,
      /** Seconds elapsed on the current item (wall-clock estimate). */
      currentElapsedSecs: snap.current
        ? Math.max(0, Math.floor((now - snap.current.startsAtMs) / 1000))
        : null,
      /** Off-air reason when nothing is playing and mode is not override. */
      offAirReason: snap.offAirReason ?? null,
      itemCount,
      uptimeMs,
      serverTimeMs: now,
      boot,
      reload,
      /** True when queue has items but nothing is on air and sources are not all blocked. */
      deadAir: !stuck && !allBlocked.allSourcesBlocked && itemCount > 0 && snap.current === null && snap.mode !== "override",
      /**
       * Milliseconds since the first item started airing in the current
       * uninterrupted broadcast run. Null when the broadcast is off-air.
       */
      continuousOnAirMs: broadcastOrchestrator.getContinuousOnAirMs(),
      /** Milliseconds since the sequence last advanced. */
      sequenceAdvanceAgeMs: now - broadcastOrchestrator.getLastSequenceAdvanceMs(),
    };

    // Authenticated operators get the full internal diagnostics payload —
    // infra metrics, blocked-source details, airing history, drift stats, etc.
    // Any valid JWT/ADMIN_API_TOKEN principal (editor or above) qualifies.
    const isAuthenticated = Boolean(req.principal);
    if (!isAuthenticated) {
      return publicPayload;
    }

    const hmStatus = getBroadcastHealthMonitorStatus();
    return {
      ...publicPayload,
      prodSync: sync,
      drift: broadcastOrchestrator.getDriftInfo(),
      allBlocked,
      skipInfo: broadcastOrchestrator.getSkipInfo(),
      redis: {
        connected: broadcastFanout.isConnected(),
        role: broadcastFanout.getRole(),
      },
      airingHistory: broadcastOrchestrator.getAiringHistory(),
      youtubeAutoOverride: getYouTubeAutoOverrideStats(),
      viewerSlope: getViewerSlopeStatus(),
      /** Broadcast health monitor (external orchestrator watchdog) status. */
      healthMonitor: hmStatus,
      /** Content rotation worker status (queue shuffle). */
      contentRotation: getContentRotationStatus(),
      /** DB connection pool utilization (shared-infra monitor). */
      dbPool: getDbPoolHealthStatus(),
      /** Object storage probe health (write/head/delete circuit breaker). */
      storageHealth: getStorageHealthStatus(),
      /** Queue health guard — active item count vs. minimum threshold. */
      queueHealthGuard: getQueueHealthGuardStatus(),
      /** Recovery eligibility — true when a full recovery could improve the situation. */
      recovery: {
        eligible: (stuck || sequenceStale) && !hmStatus.recoveryInFlight,
        inFlight: hmStatus.recoveryInFlight,
        fullRecoveryCount: hmStatus.fullRecoveryCount,
        lastFullRecoveryAtMs: hmStatus.lastFullRecoveryAtMs,
      },
      /**
       * Viewer-reported drift aggregated over the last 90 s.
       * Computed from POST /report-position samples sent by player clients
       * every ~30 s while content is playing.  Positive = viewers are behind
       * the server's authoritative position.  All fields null when no samples
       * are present in the window.
       */
      viewerSync: driftAggregator.getStats(),
    };
  });

  // ── Public: snapshot + rehydrate ─────────────────────────────────────
  // Snapshot is the cold-start authority for every player surface and the
  // recover-frame refetch target. We must never let an upstream proxy or
  // the browser HTTP cache serve a stale `sequence` — the client uses it
  // to decide whether to replay events. `no-store` is correct here even
  // though the response is small; the cost is one round-trip per cold
  // start and that's already the design.
  //
  // In-process state cache: absorbs reconnect-storm bursts when many
  // clients reconnect simultaneously (e.g. after a brief API restart).
  // Invalidated immediately on any frame emission (sequence advance,
  // mode change, item advance) so the value is always authoritative.
  // The 2 s TTL is a safety-net backstop only — in practice the frame
  // listener fires within milliseconds of any real state change.
  {
    type SnapValue = ReturnType<typeof broadcastOrchestrator.snapshot>;
    let _stateCache: { snap: SnapValue; expiresAt: number } | null = null;
    broadcastOrchestrator.on("frame", () => { _stateCache = null; });

    app.get("/state", {
      schema: { response: { 304: z.void(), 429: _429err } },
      config: {
        // Cold-start authority for every player surface and the recover-frame
        // refetch target. Rate-limited to absorb aggressive polling from
        // reconnecting clients without letting a single bad actor hammer the
        // server. 120 req/min ≈ 1 req/500 ms — well above any legitimate
        // polling cadence (keep-alive is 15 s).
        rateLimit: { max: 120, timeWindow: "1 minute" } },
    }, (req, reply) => {
      reply.header("Cache-Control", "no-store, max-age=0");
      const now = Date.now();
      if (!_stateCache || _stateCache.expiresAt <= now) {
        _stateCache = { snap: broadcastOrchestrator.snapshot(), expiresAt: now + 2_000 };
      }
      // ETag based on sequence so clients can send If-None-Match for
      // conditional GET — avoids re-parsing an identical snapshot body when
      // the broadcast has not advanced since the last fetch (e.g. reconnect
      // storms where the queue is paused or the same item is still playing).
      const seq = (_stateCache.snap as { sequence?: number }).sequence ?? 0;
      const etag = `W/"seq-${seq}"`;
      reply.header("ETag", etag);
      const ifNoneMatch = req.headers["if-none-match"] as string | undefined;
      if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === "*")) {
        return reply.code(304).send();
      }
      return { state: _stateCache.snap };
    });
  }

const _rehydrateQS = z.object({ fromSequence: z.coerce.number().int().nonnegative().default(0) });

  app.get("/rehydrate", {
    schema: {
      querystring: _rehydrateQS,
      response: {
        200: z.object({
          sequence: z.number().int(),
          events: z.array(z.object({
            sequence: z.number().int(),
            type: z.string(),
            payload: z.unknown(),
            createdAt: z.string(),
          })),
        }),
        400: _400err,
        429: _429err,
        503: z.object({ error: z.string() }),
      },
    },
    config: {
      // Each call triggers a DB query (eventLogRepo.replayFrom). Limit to
      // 10 req/min per IP — replay is only needed on cold start and after
      // reconnect, not on every keep-alive tick.
      rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const fromSeq = (req.query as z.infer<typeof _rehydrateQS>).fromSequence;
    try {
      const events = await eventLogRepo.replayFrom(broadcastOrchestrator.channelId, fromSeq, 200);
      return {
        sequence: broadcastOrchestrator.getSequence(),
        events: events.map((e) => ({
          sequence: e.sequence,
          type: e.eventType,
          payload: e.payload,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    } catch (err) {
      req.log.warn({ err, fromSeq }, "[broadcast-v2] rehydrate: event log query failed");
      return reply.code(503).send({ error: "Event log temporarily unavailable — retry in a moment" });
    }
  });

  // ── Admin commands ───────────────────────────────────────────────────
  // Authz piggybacks on the existing /admin RBAC chain — these routes get
  // mounted under both /broadcast-v2 (public read) and /admin/broadcast-v2
  // (full command surface) by the parent plugin.
  app.post("/skip", {
    ...adminGuard,
    bodyLimit: 1048576,
    schema: { body: SkipCommand, response: { 200: _200okSeq, 400: _400err, 429: _429err } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof SkipCommand>;
    if (!checkIdempotency(body.idempotencyKey)) {
      return { ok: true, sequence: broadcastOrchestrator.getSequence(), duplicate: true };
    }
    await broadcastOrchestrator.skip();
    return { ok: true, sequence: broadcastOrchestrator.getSequence() };
  });

  app.post("/override/start", {
    ...adminOnlyGuard,
    bodyLimit: 1048576,
    schema: {
      body: StartOverrideCommand,
      response: {
        200: z.object({ ok: z.literal(true), override: z.unknown(), duplicate: z.boolean().optional() }),
        400: _400err,
        429: _429err,
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof StartOverrideCommand>;
    if (!checkIdempotency(body.idempotencyKey)) {
      return { ok: true, override: broadcastOrchestrator.snapshot().override, duplicate: true };
    }
    const ov = await broadcastOrchestrator.startOverride({
      kind: body.kind,
      url: body.url,
      title: body.title,
      endsAtMs: body.endsAtMs ?? null,
      resumeQueueOnEnd: body.resumeQueueOnEnd,
    });
    return { ok: true, override: ov };
  });

  app.post("/override/stop", {
    ...adminOnlyGuard,
    bodyLimit: 1048576,
    schema: { body: StopOverrideCommand, response: { 200: _200ok, 400: _400err, 429: _429err } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof StopOverrideCommand>;
    if (!checkIdempotency(body.idempotencyKey)) return { ok: true, duplicate: true };
    await broadcastOrchestrator.stopOverride();
    return { ok: true };
  });

  // Force-failover switches to the failover source immediately.
  // 5/min — a rapid loop could cycle through sources faster than the
  // orchestrator can establish a stable stream.
  app.post("/force-failover", {
    ...adminOnlyGuard,
    bodyLimit: 1048576,
    schema: { body: ForceFailoverCommand, response: { 200: _200ok, 400: _400err, 429: _429err } },
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof ForceFailoverCommand>;
    if (!checkIdempotency(body.idempotencyKey)) return { ok: true, duplicate: true };
    await broadcastOrchestrator.forceFailover(body.reason);
    return { ok: true };
  });

  // `/clear-failover` and `/reload` are mutating operator commands and
  // must enforce the same body-idempotency contract as every other v2
  // POST. We reuse `StopOverrideCommand` because its shape is exactly
  // `{ idempotencyKey: string }`. Without this, the SSE-driven auto-
  // reload (one POST per queue mutation) and the operator's "Reload"
  // button could race and apply twice — harmless for `reload()` today
  // but a contract violation that future engine refactors could exploit.
  app.post("/clear-failover", {
    ...adminOnlyGuard,
    bodyLimit: 1048576,
    schema: { body: StopOverrideCommand, response: { 200: _200ok, 400: _400err, 429: _429err } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof StopOverrideCommand>;
    if (!checkIdempotency(body.idempotencyKey)) return { ok: true, duplicate: true };
    await broadcastOrchestrator.clearFailover();
    return { ok: true };
  });

  // Reload queue from DB (used after admin queue mutations on v1 routes).
  // 30/min — called automatically on every queue mutation via the SSE bus
  // bridge, but the bridge already deduplicates; this caps any runaway clients.
  //
  // Self-healing: before reloading, re-enable any items that were auto-suspended
  // in a previous server session (old code wrote is_active=false to the DB) and
  // clear the in-process bad-URL cache so previously-failing items get a fresh
  // attempt. This turns the operator "Reload from queue" button into a full
  // recovery action that rescues a permanently Off Air broadcast without a deploy.
  app.post("/reload", {
    ...adminGuard,
    bodyLimit: 1048576,
    schema: { body: StopOverrideCommand, response: { 200: _200okSeq, 400: _400err, 429: _429err } },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof StopOverrideCommand>;
    if (!checkIdempotency(body.idempotencyKey)) {
      return { ok: true, sequence: broadcastOrchestrator.getSequence(), duplicate: true };
    }
    const reEnabled = await reEnableAllSuspended();
    if (reEnabled > 0) {
      logger.info({ reEnabled }, "[broadcast-v2] reload: re-enabled suspended queue items before reload");
    }
    clearAllBadUrls();
    faststartRecoveryWorker.resetAttempts();
    void faststartRecoveryWorker.sweep().catch((err) =>
      logger.warn({ err }, "[broadcast-v2] reload: faststart-recovery sweep failed (non-fatal)"),
    );
    await broadcastOrchestrator.reload();
    return { ok: true, sequence: broadcastOrchestrator.getSequence(), reEnabled };
  });

  // ── Unauthenticated: client stall report ─────────────────────────────
  // Players (TV, mobile, web) call this when the FSM reaches SKIP_PENDING
  // — i.e. the active source failed to load after all local retries. After
  // STALL_VOTE_THRESHOLD votes for the same active item the orchestrator
  // auto-skips so a broken URL never leaves every viewer on a black screen.
  //
  // Rate-limited to 5 req/min per IP (not per client session) so a single
  // misbehaving player cannot cycle through the entire queue instantly.
  const stallVotes = new Map<string, { count: number; ts: number }>();
  // Require 1 stall report before blocking a source.
  // The client-side FSM already performs 3 independent retry/recovery
  // attempts (RECOVERING_PRIMARY → RECOVERING_FAILOVER → SKIP_PENDING)
  // before sending a stall report.  By the time a report arrives the
  // source has been confirmed broken 3 times in a row — one independent
  // confirmation is sufficient evidence.  A threshold of 2 (previous)
  // meant a single viewer could never trigger a skip (e.g. solo admin
  // testing), leaving the broadcast stuck on a 404 source until manual
  // intervention.
  const STALL_VOTE_THRESHOLD = 1;
  const STALL_VOTE_TTL_MS = 15_000; // aligned with BAD_URL_TTL_MS

  /**
   * Per-item stall action cooldown.
   *
   * When STALL_VOTE_THRESHOLD is 1, two simultaneous clients sending
   * a stall report for the same item can both pass the vote check before
   * either sees the skip take effect (the vote-map entry is deleted just
   * before the async `skip()` awaits). Without a cooldown this causes:
   *   1. Client A: count = 1 ≥ threshold → delete key → await skip()
   *   2. Client B (same tick): count = 1 ≥ threshold → delete key → await skip() again
   *
   * The second skip advances to the NEXT item, silently removing a good
   * video from the broadcast. The cooldown ensures only one action fires
   * per item per STALL_ACTION_COOLDOWN_MS window, regardless of concurrent
   * requests. Keyed by itemId (not URL) to prevent the same item from
   * being double-skipped even if it appears under different URLs.
   */
  const stallActionCooldown = new Map<string, number>();
  const STALL_ACTION_COOLDOWN_MS = 10_000;

  // Scheduled GC for stall votes and cooldown: prune entries whose TTL has
  // expired without reaching the threshold (e.g. a single client stalled
  // once then recovered). Without this, every never-promoted vote accumulates
  // permanently — on a 24/7 server this compounds across weeks of operation.
  const _stallVotesGcTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of stallVotes) {
      if (now - v.ts > STALL_VOTE_TTL_MS) stallVotes.delete(k);
    }
    for (const [k, ts] of stallActionCooldown) {
      if (now - ts > STALL_ACTION_COOLDOWN_MS) stallActionCooldown.delete(k);
    }
  }, 60_000);
  _stallVotesGcTimer.unref?.();
  registerNamedStore("broadcast-v2-stall-votes", () => stallVotes.size);
  registerNamedStore("broadcast-v2-stall-cooldown", () => stallActionCooldown.size);

  app.post("/report-stall", {
    bodyLimit: 1048576,
    schema: {
      body: ReportStallCommand,
      response: {
        200: z.object({
          ok: z.boolean(),
          acted: z.boolean().optional(),
          reason: z.string().optional(),
          count: z.number().int().optional(),
          skipped: z.boolean().optional(),
          failCount: z.number().int().optional(),
        }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof ReportStallCommand>;

    const snap = broadcastOrchestrator.snapshot();
    // Only count votes for the item that is *currently* playing. Stale
    // reports (client reconnected but server already advanced) are no-ops.
    if (!snap.current || snap.current.id !== body.itemId) {
      return { ok: true, acted: false, reason: "item-not-current" };
    }

    const key = `${broadcastOrchestrator.channelId}:${body.itemId}`;
    const now = Date.now();
    const prev = stallVotes.get(key);
    const count =
      prev && now - prev.ts < STALL_VOTE_TTL_MS ? prev.count + 1 : 1;
    stallVotes.set(key, { count, ts: now });

    // Record stall in analytics regardless of threshold
    playbackAnalytics.record({
      type: "stall",
      itemId: body.itemId,
      itemTitle: snap.current.title ?? null,
      ts: Date.now(),
      meta: { voteCount: count },
    });

    if (count >= STALL_VOTE_THRESHOLD) {
      stallVotes.delete(key);

      // ── Cooldown guard ────────────────────────────────────────────────
      // With threshold=1 two simultaneous stall reports for the same item
      // can both pass the vote check (the map key is deleted before either
      // await resolves). The cooldown ensures only one skip+blacklist action
      // fires per item within STALL_ACTION_COOLDOWN_MS, preventing the second
      // report from advancing to a perfectly-good next item.
      const cooldownKey = `cooldown:${broadcastOrchestrator.channelId}:${body.itemId}`;
      const lastActionAt = stallActionCooldown.get(cooldownKey);
      if (lastActionAt && Date.now() - lastActionAt < STALL_ACTION_COOLDOWN_MS) {
        return { ok: true, acted: false, reason: "cooldown", count };
      }
      stallActionCooldown.set(cooldownKey, Date.now());

      // Blacklist the failing source URLs so the orchestrator's toItem()
      // returns null for these URLs for the next 2 minutes. Without this,
      // the orchestrator continues presenting the same broken URL as
      // "current" after every skip, causing an endless cycle of:
      //   player loads URL → 502 → RECOVERING → SKIP_PENDING → stall report
      //   → server skips → SAME broken URL becomes current again → repeat.
      // With the bad-URL cache, the first stall report immediately removes
      // that URL from the rotation. If all items share the same broken URL,
      // snapshot().current becomes null → FSM → SYNCING → overlay: "Off air".
      const snapForBlacklist = broadcastOrchestrator.snapshot();
      if (snapForBlacklist.current?.source?.url) {
        markBadUrl(snapForBlacklist.current.source.url);
      }
      if (snapForBlacklist.current?.failoverSource?.url) {
        markBadUrl(snapForBlacklist.current.failoverSource.url);
      }
      await broadcastOrchestrator.skip();
      // Increment the per-item failure counter and auto-suspend if it has
      // exceeded the threshold. The item is deactivated in the DB and a
      // queue reload removes it from the in-memory cycle immediately.
      const failCount = incrementBadUrlSkipCount(body.itemId);
      if (failCount >= BAD_URL_SKIP_THRESHOLD) {
        const itemTitle = snapForBlacklist.current?.title ?? null;
        // Pass primaryUrl so autoSuspendQueueItem extends the bad-URL cache TTL
        // from 90 s (BAD_URL_TTL_MS, set above by markBadUrl) to the full 5-min
        // SUSPENSION_TTL_MS.  Without it the item re-enters rotation after 90 s,
        // immediately fails again, and the stall-report → auto-suspend cycle
        // repeats continuously instead of giving the operator 5 min to intervene.
        autoSuspendQueueItem(
          body.itemId,
          itemTitle,
          failCount,
          snapForBlacklist.current?.source?.url ?? undefined,
        );
        void broadcastOrchestrator.reload().catch((err) => {
          logger.warn({ err, itemId: body.itemId }, "[broadcast-v2] stall-report: background reload after auto-suspend failed (non-fatal)");
        });
      }
      // Push a real-time event to all connected admin SSE clients so the
      // Master Control dashboard reflects stalls immediately — without waiting
      // for the next diagnostics poll (up to 15 s later). The event carries
      // enough detail for the StreamQualityPanel and alert banners to update.
      adminEventBus.push("broadcast-v2-stall", {
        itemId: body.itemId,
        itemTitle: snapForBlacklist.current?.title ?? null,
        failCount,
        autoSuspended: failCount >= BAD_URL_SKIP_THRESHOLD,
        ts: Date.now(),
      });
      return { ok: true, acted: true, skipped: true, failCount };
    }
    return { ok: true, acted: false, count };
  });

  // ── Client position checkpoint ───────────────────────────────────────
  // Players (TV, mobile, web) periodically push their current playback
  // position to the server so operators and external monitors can detect
  // client–server drift without polling /state on every viewer's behalf.
  //
  // Algorithm:
  //   1. Accept the client's reported positionSecs for itemId.
  //   2. Compare against the orchestrator's expected position
  //      (Date.now() - item.startsAtMs) / 1000 for the same item.
  //   3. If drift > CHECKPOINT_DRIFT_THRESHOLD_S, log a warning and
  //      surface the drift value in the response — operators can act.
  //   4. Never mutate the orchestrator from this endpoint. Client
  //      drift is purely observational here; the auto-skip mechanism
  //      in /report-stall handles truly stuck sources.
  //
  // No auth required — any player can call this. Rate-limited to prevent
  // abuse. Designed to be called by clients every 30 s while in PLAYING.
  //
  // NOTE: this endpoint is deliberately lightweight (no DB write) so it
  // can be called by all connected clients simultaneously without risk.
  const CHECKPOINT_DRIFT_THRESHOLD_S = 30;
  app.post("/checkpoint", {
    bodyLimit: 1048576,
    schema: {
      body: z.object({ itemId: z.string().min(1).max(128), positionSecs: z.number().min(0).max(86400) }),
      response: {
        200: z.object({
          ok: z.boolean(),
          accepted: z.boolean().optional(),
          reason: z.string().optional(),
          itemId: z.string().optional(),
          positionSecs: z.number().optional(),
          expectedPositionSecs: z.number().optional(),
          driftSecs: z.number().optional(),
          driftExceeded: z.boolean().optional(),
        }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const { itemId, positionSecs } = req.body as { itemId: string; positionSecs: number };

    const snap = broadcastOrchestrator.snapshot();
    if (!snap.current || snap.current.id !== itemId) {
      return { ok: true, accepted: false, reason: "item-not-current" };
    }

    const expectedPositionSecs = (Date.now() - snap.current.startsAtMs) / 1000;
    const driftSecs = Math.abs(positionSecs - expectedPositionSecs);
    const driftExceeded = driftSecs > CHECKPOINT_DRIFT_THRESHOLD_S;

    if (driftExceeded) {
      logger.warn(
        {
          itemId,
          positionSecs,
          expectedPositionSecs: Math.round(expectedPositionSecs),
          driftSecs: Math.round(driftSecs),
        },
        "[broadcast-v2] client position checkpoint: drift exceeds threshold",
      );
    }

    return {
      ok: true,
      accepted: true,
      itemId,
      positionSecs,
      expectedPositionSecs: Math.round(expectedPositionSecs),
      driftSecs: Math.round(driftSecs),
      driftExceeded,
    };
  });

  // ── Admin: atomic promote-and-play ───────────────────────────────────
  // Single round-trip that:
  //   1. Reorders the queue to put `queueItemId` at the front (sort_order).
  //   2. Reloads the v2 orchestrator from DB so the new order is live.
  //   3. Skips the orchestrator to advance to the (now first) item.
  // Combining all three in one endpoint eliminates the race window that
  // exists when callers do reorder + skip as two sequential API calls.
  app.post("/play-now", {
    ...adminGuard,
    bodyLimit: 1048576,
    schema: {
      body: PlayNowCommand,
      response: {
        200: _200okSeq,
        400: _400err,
        404: z.object({ error: z.string() }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = req.body as z.infer<typeof PlayNowCommand>;
    if (!checkIdempotency(body.idempotencyKey)) {
      return { ok: true, sequence: broadcastOrchestrator.getSequence(), duplicate: true };
    }

    // Build new ordered id list from the DB — target item first, rest in
    // their current sort order. Using DB rows instead of orchestrator memory
    // ensures Play Now works regardless of the orchestrator's current mode
    // (failover, offline_hold, or an empty queue where getItems() returns []).
    const targetId = body.queueItemId;
    const activeRows = await queueRepo.loadActive();
    const targetExists = activeRows.some((r) => r.id === targetId);
    if (!targetExists) {
      return reply.code(404).send({ error: "Queue item not found in active broadcast queue" });
    }
    const newOrder = [
      targetId,
      ...activeRows.filter((r) => r.id !== targetId).map((r) => r.id),
    ];

    // 1. Persist new sort order in DB (broadcastService also pushes the bus
    //    bridge event, but we call reload() directly below for immediacy).
    await broadcastService.reorder(newOrder);

    // 2. Reload v2 orchestrator immediately (don't wait for the 250 ms bus
    //    bridge debounce that broadcastService's adminEventBus push triggers).
    await broadcastOrchestrator.reload();

    // 3. Skip so the orchestrator advances to the now-front item — but ONLY
    //    if the target item is not already current. Skipping an already-current
    //    item would advance to the item AFTER it (wrong behaviour). After
    //    reload() the snapshot reflects the new sort order, so we can reliably
    //    check whether the target is now playing before deciding to skip.
    const snapAfterReload = broadcastOrchestrator.snapshot();
    if (snapAfterReload.current?.id !== targetId) {
      await broadcastOrchestrator.skip();
    }

    return { ok: true, sequence: broadcastOrchestrator.getSequence() };
  });

  // ── Admin: source health ──────────────────────────────────────────────
  // Returns per-item URL health status from the in-process bad-URL cache.
  // Powers the "Source blocked" badges on the Master Control page.
  // Admin-protected (editors + admins) — no rate-limit needed since it's
  // authenticated and does only one DB read + in-memory cache lookups.
  app.get("/source-health", {
    ...adminGuard,
    schema: { response: { 429: _429err } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const rows = await queueRepo.loadActive();
    const healthByItemId = getItemsHealth(rows);
    return { healthByItemId };
  });

  // ── Admin: clear all source blocks ───────────────────────────────────
  // Flushes the entire bad-URL cache so every source URL is retried
  // on the next playback cycle. Useful when an operator has fixed a
  // broken stream or replaced a bad file and wants immediate retry
  // without waiting for the 2-minute TTL to expire.
  app.post("/clear-bad-urls", {
    ...adminGuard,
    bodyLimit: 1048576,
    schema: { body: StopOverrideCommand, response: { 200: _200okSeq, 400: _400err, 429: _429err } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as z.infer<typeof StopOverrideCommand>;
    if (!checkIdempotency(body.idempotencyKey)) return { ok: true, sequence: broadcastOrchestrator.getSequence(), duplicate: true };
    clearAllBadUrls();
    // Reload the orchestrator so it immediately re-evaluates all items now
    // that the cache is empty — without this the orchestrator's next drift-
    // poll would be up to 10 s away and the operator would see no change.
    await broadcastOrchestrator.reload();
    return { ok: true, sequence: broadcastOrchestrator.getSequence() };
  });

  // ── Natural item end ─────────────────────────────────────────────────
  // Called by player clients when a video finishes playing before the
  // server's scheduled wall-clock slot expires (i.e. durationSecs on the
  // queue row is longer than the actual video file).  Without this the
  // orchestrator holds its cycle anchor on the old item, and the next
  // snapshot re-binds every connected player back to the already-finished
  // video — causing it to replay for the remaining slot time.
  //
  // No auth required — any player can call this. Rate-limited to prevent
  // abuse. The call is item-level idempotent: the first client to call it
  // advances the anchor; subsequent calls for the same itemId are no-ops
  // because the anchor has already moved past that item.
  app.post("/natural-end", {
    bodyLimit: 1048576,
    schema: {
      body: z.object({ itemId: z.string().min(1).max(128) }),
      response: {
        200: z.object({ ok: z.boolean(), advanced: z.boolean().optional(), reason: z.string().optional() }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const { itemId } = req.body as { itemId: string };

    // Gate 1: early-exit if this itemId is no longer current.
    // This handles late calls that arrive AFTER the orchestrator has already
    // advanced (e.g. a network-delayed /natural-end that finally lands after
    // the queue moved on). naturalItemEnd() would be a no-op at the
    // orchestrator level, but we can save the DB call and log noise entirely.
    const snap = broadcastOrchestrator.snapshot();
    if (snap.current !== null && snap.current.id !== itemId) {
      return { ok: true, advanced: false, reason: "not-current" };
    }

    // Gate 2: thundering-herd dedup for simultaneous end events.
    // Build dedup key from itemId + cycleStartedAtMs so the NEXT cycle of the
    // same item (same itemId, new anchor) is not suppressed. Only ONE of the
    // concurrent /natural-end calls passes through to the orchestrator.
    const cycleAnchor = snap.current?.startsAtMs ?? 0;
    const dedupKey = `${itemId}:${cycleAnchor}`;
    const now = Date.now();
    const lastSeen = naturalEndDedup.get(dedupKey);
    if (lastSeen !== undefined && now - lastSeen < NATURAL_END_DEDUP_TTL_MS) {
      return { ok: true, advanced: false, reason: "dedup" };
    }
    naturalEndDedup.set(dedupKey, now);

    const result = await broadcastOrchestrator.naturalItemEnd(itemId);
    return { ok: true, ...result };
  });

  // ── Viewer position report (sync telemetry) ──────────────────────────
  //
  // Called by every player client every ~30 s while content is playing.
  // The client sends its locally-computed position for the current item.
  // The server derives the authoritative expected position from the
  // orchestrator's cycle-anchor arithmetic and records the difference as a
  // drift sample in the in-process DriftAggregator.
  //
  // This is OPTIONAL telemetry — the broadcast path is entirely unaffected
  // by whether clients call this endpoint.
  // No auth required — the transport sends this from every player surface
  // including unauthenticated TV and web viewers. Auth was previously set
  // to "user" level here but the transport never included an Authorization
  // header, causing every position report to return 401.
  //
  // Rate-limited to 6/min per IP (one per 30 s interval + burst allowance
  // for reconnects/page-loads that fire the reporter immediately).
  app.post("/report-position", {
    bodyLimit: 1_024,
    schema: {
      body: z.object({
        itemId: z.string().min(1).max(128),
        positionMs: z.number().int().nonnegative().max(86_400_000),
      }),
      response: {
        200: z.object({
          ok: z.boolean(),
          serverPositionMs: z.number().nullable(),
          driftMs: z.number().nullable(),
        }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
  }, (req, _reply) => {
    const { itemId, positionMs } = req.body as { itemId: string; positionMs: number };
    const snap = broadcastOrchestrator.snapshot();
    if (!snap.current || snap.current.id !== itemId) {
      // Item is no longer current — stale report, discard silently.
      return { ok: true, serverPositionMs: null, driftMs: null };
    }
    const serverPositionMs = Math.max(0, Date.now() - snap.current.startsAtMs);
    const driftMs = serverPositionMs - positionMs;
    driftAggregator.record(itemId, driftMs);
    return { ok: true, serverPositionMs, driftMs };
  });

  // ── Public: sync reference ────────────────────────────────────────────
  //
  // Returns the server's authoritative position with sub-second precision.
  // Use this from test harnesses, monitoring scripts, or multi-device sync
  // verification tools to measure how far any individual player is from the
  // ground truth without relying on the player's own clock estimate.
  //
  // No auth required — it exposes only what the broadcast already makes
  // public via SSE/WS snapshots. Aggressively rate-limited (60/min) since
  // it's intended for occasional point-in-time checks, not polling.
  app.get("/sync-reference", {
    schema: {
      response: {
        200: z.object({
          ok: z.literal(true),
          channelId: z.string(),
          sequence: z.number().int(),
          serverTimeMs: z.number().int(),
          itemId: z.string().nullable(),
          serverPositionMs: z.number().int().nullable(),
          durationMs: z.number().int().nullable(),
        }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const snap = broadcastOrchestrator.snapshot();
    const serverTimeMs = Date.now();
    const serverPositionMs = snap.current
      ? Math.max(0, serverTimeMs - snap.current.startsAtMs)
      : null;
    return {
      ok: true as const,
      channelId: broadcastOrchestrator.channelId,
      sequence: broadcastOrchestrator.getSequence(),
      serverTimeMs,
      itemId: snap.current?.id ?? null,
      serverPositionMs,
      durationMs: snap.current ? Math.round(snap.current.durationSecs * 1000) : null,
    };
  });

  // ── Admin: trigger HLS transcoding for all queue items missing it ─────
  // Delegates to autoEnqueueMissingHls() — the same function that runs
  // automatically 15 s after boot. Idempotent; rate-limited to 3/min
  // because each call may spawn real FFmpeg processes.
  app.post("/prepare-hls", {
    ...adminGuard,
    bodyLimit: 1048576,
    schema: {
      body: StopOverrideCommand,
      response: {
        200: z.object({ ok: z.literal(true), triggered: z.number().int().nonnegative(), duplicate: z.boolean().optional() }),
        400: _400err,
        429: _429err,
      },
    },
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const body = req.body as z.infer<typeof StopOverrideCommand>;
    if (!checkIdempotency(body.idempotencyKey)) return { ok: true, triggered: 0, duplicate: true };

    const { triggered } = await autoEnqueueMissingHls();
    logger.info({ triggered }, "[broadcast-v2] prepare-hls: triggered HLS jobs for queue items");
    return { ok: true as const, triggered };
  });

  // ── Admin: repair HLS_STORAGE_MISSING items ───────────────────────────
  //
  // POST /broadcast-v2/repair-hls-storage-missing
  //
  // One-click operator repair for videos whose HLS master blob is absent from
  // storage but whose managed_videos row still shows transcodingStatus='hls_ready'.
  // This happens when storage blobs are deleted externally (migration, S3 lifecycle,
  // manual cleanup) while the DB metadata is not updated.
  //
  // For each confirmed-missing item this endpoint:
  //   1. Clears hls_master_url on managed_videos (stops the dead URL being served)
  //   2. Re-enqueues transcoding from localVideoUrl (resets status to 'queued')
  //   3. When no source URL is available, resets transcodingStatus to 'none'
  //      so the video appears as "needs re-upload" rather than falsely hls_ready
  //   4. Deactivates the broadcast_queue item with validator_deactivated_reason=
  //      'hls_storage_missing' so the orchestrator won't serve the dead HLS URL
  //      while transcoding runs. The reverse pass re-activates it on completion.
  //
  // Checks up to 100 active hls_ready queue items per call.
  app.post(
    "/repair-hls-storage-missing",
    {
      preHandler: requireAuth("admin"),
      bodyLimit: 1048576,
      schema: {
        response: {
          200: z.object({ repaired: z.number().int(), noSource: z.number().int(), alreadyHealthy: z.number().int(), message: z.string() }),
          429: _429err,
          500: z.object({ error: z.string() }),
          503: z.object({ error: z.string() }),
        },
      },
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
    },
    async (_req, reply) => {
      reply.header("Cache-Control", "no-store, max-age=0");

      // 1. Find all active queue items with hls_ready videos
      type HlsRow = {
        queue_id: string;
        video_id: string;
        title: string | null;
        local_video_url: string | null;
      };
      let hlsReadyItems: HlsRow[];
      try {
        const result = await db.execute<HlsRow>(sql`
          SELECT
            q.id        AS queue_id,
            v.id        AS video_id,
            q.title,
            v.local_video_url
          FROM broadcast_queue q
          JOIN managed_videos v ON v.id = q.video_id
          WHERE q.is_active = true
            AND v.transcoding_status = 'hls_ready'
          ORDER BY q.sort_order
          LIMIT 100
        `);
        hlsReadyItems = (result.rows as HlsRow[]) ?? [];
      } catch (err) {
        logger.warn({ err }, "[broadcast-v2] repair-hls-storage-missing: DB query failed");
        return reply.code(500).send({ error: "DB query failed" });
      }

      if (hlsReadyItems.length === 0) {
        return { repaired: 0, noSource: 0, alreadyHealthy: 0, message: "No hls_ready active queue items found." };
      }

      // 2. Check storage_blobs for which HLS keys are actually present
      const checkKeys = hlsReadyItems.map((r) => `transcoded/${r.video_id}/master.m3u8`);
      let presentKeys: Set<string>;
      try {
        const pr = await db
          .select({ key: schema.storageBlobsTable.key })
          .from(schema.storageBlobsTable)
          .where(inArray(schema.storageBlobsTable.key, checkKeys));
        presentKeys = new Set(pr.map((r) => r.key));
      } catch (err) {
        logger.warn({ err }, "[broadcast-v2] repair-hls-storage-missing: storage_blobs check failed");
        return reply.code(503).send({ error: "storage_blobs check failed — cannot confirm which blobs are missing" });
      }

      // 3. For each missing blob: clear hls_master_url, re-enqueue transcoding, deactivate queue item
      let repaired = 0;
      let noSource = 0;
      let alreadyHealthy = 0;

      for (const row of hlsReadyItems) {
        const hlsKey = `transcoded/${row.video_id}/master.m3u8`;
        if (presentKeys.has(hlsKey)) {
          alreadyHealthy++;
          continue;
        }

        try {
          // Deactivate queue item
          await db
            .update(schema.broadcastQueueTable)
            .set({ isActive: false, validatorDeactivatedReason: "hls_storage_missing" })
            .where(eq(schema.broadcastQueueTable.id, row.queue_id));

          if (row.local_video_url) {
            // Clear dead HLS URL + re-enqueue transcoding (enqueueTranscode resets status → 'queued')
            await db
              .update(schema.videosTable)
              .set({ hlsMasterUrl: null })
              .where(eq(schema.videosTable.id, row.video_id));
            await enqueueTranscode({
              videoId: row.video_id,
              videoPath: row.local_video_url,
              priority: 8,
            });
            repaired++;
            logger.info(
              { videoId: row.video_id, queueId: row.queue_id },
              "[broadcast-v2] repair-hls-storage-missing: cleared hls_master_url + re-enqueued transcoding",
            );
          } else {
            // No source — reset to 'none' so the video shows as "needs re-upload"
            await db
              .update(schema.videosTable)
              .set({ hlsMasterUrl: null, transcodingStatus: "none" })
              .where(eq(schema.videosTable.id, row.video_id));
            noSource++;
            logger.warn(
              { videoId: row.video_id, queueId: row.queue_id },
              "[broadcast-v2] repair-hls-storage-missing: no source URL — reset to 'none'; operator must re-upload",
            );
          }
        } catch (err) {
          logger.warn({ err, videoId: row.video_id }, "[broadcast-v2] repair-hls-storage-missing: repair failed for item (non-fatal)");
        }
      }

      if (repaired + noSource > 0) {
        transcoderDispatcher.nudge();
        adminEventBus.push("broadcast-queue-updated", {
          reason: "repair-hls-storage-missing",
          repaired,
          noSource,
        });
        void broadcastOrchestrator.reload().catch((err) => {
          logger.warn({ err }, "[broadcast-v2] repair-hls-storage-missing: reload failed (non-fatal)");
        });
      }

      logger.warn(
        { repaired, noSource, alreadyHealthy, checked: hlsReadyItems.length },
        "[broadcast-v2] repair-hls-storage-missing: complete",
      );

      return {
        repaired,
        noSource,
        alreadyHealthy,
        message:
          repaired > 0
            ? `Repair triggered for ${repaired} item${repaired !== 1 ? "s" : ""}. Transcoding will rebuild HLS; items return to air automatically on completion.`
            : noSource > 0
            ? `${noSource} item${noSource !== 1 ? "s" : ""} had no source file — reset to 'needs re-upload'. Re-upload the source videos to restore them.`
            : "All checked items already have healthy HLS blobs in storage.",
      };
    },
  );

  // ── Admin: comprehensive diagnostics ─────────────────────────────────
  // Aggregates all subsystem health into a single authenticated JSON
  // response for operators and monitoring tools. Covers boot state,
  // orchestrator runtime, media scanner, queue validation, worker
  // health, orphan cleanup, prod-sync, and analytics summary.
  app.get("/diagnostics", {
    ...adminGuard,
    schema: { response: { 429: _429err } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const boot = getBroadcastV2BootStatus();
    const snap = broadcastOrchestrator.snapshot();
    const drift = broadcastOrchestrator.getDriftInfo?.() ?? null;
    const allBlocked = broadcastOrchestrator.getAllBlockedInfo?.() ?? null;
    const reloadStats = broadcastOrchestrator.getReloadStats?.() ?? null;
    const prodSync = prodQueueSync.getStatus();
    const mediaScan = mediaIntegrityScanner.getReport();
    const queueValidation = queueIntegrityValidator.getLastReport();
    const workers = workerSupervisor.getHealth();
    const cleanup = orphanCleanupWorker.getStats();
    const analyticsWindow = 60 * 60_000; // 1 hour
    const analyticsSummary = playbackAnalytics.getReport(analyticsWindow);
    const itemsHealth = (() => {
      try {
        return getItemsHealth(broadcastOrchestrator.getItems().map((i) => ({
          id: i.id,
          videoId: null,
          youtubeId: "",
          title: "",
          thumbnailUrl: null,
          durationSecs: 0,
          localVideoUrl: i.localVideoUrl ?? null,
          hlsMasterUrl: i.hlsMasterUrl ?? null,
          faststartApplied: false,
          videoDuration: null,
        })));
      } catch {
        return {};
      }
    })();

    return {
      generatedAtMs: Date.now(),
      uptimeMs: Date.now() - PROCESS_BOOTED_AT_MS,
      boot,
      orchestrator: {
        sequence: broadcastOrchestrator.getSequence(),
        mode: snap.mode,
        itemCount: broadcastOrchestrator.getItems().length,
        currentItemId: snap.current?.id ?? null,
        currentItemTitle: snap.current?.title ?? null,
        failover: snap.failover,
        drift,
        allBlocked,
        reload: reloadStats,
      },
      sourceHealth: itemsHealth,
      autoSuspended: getRecentlySuspended(),
      mediaScan,
      queueValidation,
      workers,
      cleanup,
      prodSync,
      analytics: {
        windowMs: analyticsWindow,
        activeSessions: analyticsSummary.sessions.active,
        peakSessionsLast5Min: analyticsSummary.sessions.peakInLast5Min,
        totalSessions: analyticsSummary.sessions.total,
        eventCounts: analyticsSummary.counts,
        bufferUtilizationPct: analyticsSummary.bufferUtilizationPct,
        lastEventAtMs: analyticsSummary.lastEventAtMs,
      },
    };
  });

  // ── Admin: playback analytics ─────────────────────────────────────────
  // Returns the full in-memory analytics report with per-item breakdown.
  // Accepts optional `windowMs` query parameter (default: 1 hour).
  app.get("/analytics", {
    ...adminGuard,
    schema: { response: { 429: _429err } },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const q = req.query as Record<string, string>;
    const windowMs = q.windowMs ? Math.min(Math.max(Number(q.windowMs), 60_000), 24 * 60 * 60_000) : 60 * 60_000;
    return playbackAnalytics.getReport(windowMs);
  });

  // ── Admin: manual library → queue sync ───────────────────────────────
  // Scans managed_videos for playable rows not yet in broadcast_queue and
  // inserts them. Idempotent — already-queued videos are silently skipped.
  // Typical use: after a bulk YouTube import, after a DB migration, or
  // whenever the operator wants to confirm nothing was missed by the
  // automatic pipeline. Rate-limited to prevent accidental double-clicks
  // from hammering the DB with back-to-back full-library scans.
  app.post("/sync-library", {
    ...adminGuard,
    bodyLimit: 1048576,
    schema: {
      response: {
        200: z.object({ ok: z.literal(true), scanned: z.number().int(), enqueued: z.number().int(), skipped: z.number().int() }),
        429: _429err,
      },
    },
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const result = await scanLibraryAndEnqueue({ reason: "manual", maxToAdd: 500 });
    return { ok: true, ...result };
  });

  // ── Admin: queue sync status ──────────────────────────────────────────
  // Returns how many library videos are currently missing from the broadcast
  // queue and a sample list of them. Used by the admin console to surface a
  // "N videos not in queue — Sync now?" banner without running a full scan.
  app.get("/queue-sync-status", {
    ...adminGuard,
    schema: { response: { 429: _429err } },
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");

    // listMissingFromQueue is capped (returns first N rows) — fine for the
    // `sample` and per-row reason breakdown, but its `.length` is an UNDERCOUNT
    // for any library with >100 missing rows. The off-air diagnostic card in
    // the admin shows these numbers verbatim ("Library has X videos…"), so an
    // undercount actively misleads operators. Run two cheap COUNT(*) queries
    // alongside the sample fetch to return uncapped, authoritative totals.
    //
    // libraryTotal      — every managed_video row regardless of source/state
    // libraryPlayable   — rows that satisfy isPlayableForBroadcast (hls OR
    //                     local+faststart, excluding YouTube). This is the
    //                     true ceiling on what auto-enqueue could ever add.
    // missingCountExact — playable rows NOT yet in broadcast_queue. Replaces
    //                     the capped missingCount for the diagnostic card.
    const [missing, totals] = await Promise.all([
      listMissingFromQueue(100),
      (async () => {
        const rows = await db.execute<{
          library_total: string;
          library_playable: string;
          missing_playable: string;
        }>(sql`
          SELECT
            COUNT(*)::text AS library_total,
            COUNT(*) FILTER (
              WHERE video_source <> 'youtube'
                AND (
                  (hls_master_url IS NOT NULL AND hls_master_url <> '')
                  OR (local_video_url IS NOT NULL AND local_video_url <> ''
                      AND faststart_applied = true)
                )
            )::text AS library_playable,
            COUNT(*) FILTER (
              WHERE video_source <> 'youtube'
                AND (
                  (hls_master_url IS NOT NULL AND hls_master_url <> '')
                  OR (local_video_url IS NOT NULL AND local_video_url <> ''
                      AND faststart_applied = true)
                )
                AND NOT EXISTS (
                  SELECT 1 FROM broadcast_queue bq
                  WHERE bq.video_id = managed_videos.id
                )
            )::text AS missing_playable
          FROM managed_videos
        `);
        const r = rows.rows[0] ?? { library_total: "0", library_playable: "0", missing_playable: "0" };
        return {
          libraryTotal: Number(r.library_total) || 0,
          libraryPlayable: Number(r.library_playable) || 0,
          missingPlayable: Number(r.missing_playable) || 0,
        };
      })(),
    ]);
    const missingReady = missing.filter((m) => m.reason === "ready");
    return {
      // Back-compat fields (capped at 100).
      missingCount: missing.length,
      missingReadyCount: missingReady.length,
      sample: missing.slice(0, 10),
      // Authoritative uncapped totals — use these for any UI that displays
      // a number to the operator.
      libraryTotal: totals.libraryTotal,
      libraryPlayable: totals.libraryPlayable,
      missingPlayable: totals.missingPlayable,
    };
  });

  // ── Remote-transcode endpoint ─────────────────────────────────────────────
  //
  // POST /broadcast-v2/queue/:id/transcode-remote
  //
  // Intended for prod-sync queue items that have a remote `localVideoUrl` (pointing
  // to the production API) but no local managed_videos entry (videoId === null).
  // Creates a managed_videos placeholder, stores the remote URL as the objectPath
  // (the transcoder's downloadSourceToTempFile detects http(s):// keys and fetches
  // from the external server directly), then enqueues local HLS transcoding.
  app.post<{ Params: { id: string } }>(
    "/queue/:id/transcode-remote",
    {
      preHandler: requireAuth("admin"),
      bodyLimit: 1048576,
      schema: { response: { 429: _429err } },
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const [queueItem] = await db
        .select()
        .from(schema.broadcastQueueTable)
        .where(eq(schema.broadcastQueueTable.id, id))
        .limit(1);

      if (!queueItem) {
        return reply.code(404).send({ error: "Queue item not found" });
      }
      if (queueItem.videoId) {
        return reply.code(409).send({
          error: "Queue item already has a linked managed video. Use the standard retry flow.",
        });
      }
      if (!queueItem.localVideoUrl || !/^https?:\/\//i.test(queueItem.localVideoUrl)) {
        return reply.code(400).send({
          error: "Queue item has no accessible remote source URL to download from.",
        });
      }

      const sourceUrl = queueItem.localVideoUrl;

      // ── Disk-space pre-flight ──────────────────────────────────────────
      // HEAD the remote URL to determine download size, then verify the
      // transcoder scratch filesystem has enough headroom before touching the DB.
      // Returns null when the check passes or cannot be determined; returns an
      // error string when the disk is too full to proceed.
      const diskError = await checkRemoteTranscodeDiskSpace(sourceUrl, id);
      if (diskError) {
        return reply.code(507).send({ error: diskError });
      }

      const videoId = randomUUID();

      // Create managed_videos placeholder.
      // objectPath stores the HTTP URL — downloadSourceToTempFile in the transcoder
      // detects http(s):// and fetches from the remote server directly.
      await db.insert(schema.videosTable).values({
        id: videoId,
        title: queueItem.title,
        videoSource: "local",
        objectPath: sourceUrl,
        transcodingStatus: "queued",
        broadcastOnly: true,
      });

      // Link broadcast_queue row to the new managed_videos entry
      await db
        .update(schema.broadcastQueueTable)
        .set({ videoId })
        .where(eq(schema.broadcastQueueTable.id, id));

      // Enqueue HLS transcoding (uses sourceUrl as the objectPath/videoPath)
      await enqueueTranscode({ videoId, videoPath: sourceUrl, priority: 5 });
      transcoderDispatcher.nudge();

      // Reload orchestrator so the updated row is visible immediately
      void broadcastOrchestrator.reload().catch(() => {});
      // Notify all connected admin clients so library and queue panels refresh
      // immediately — without this, other admin sessions miss the new video
      // and the broadcast queue update until their next poll cycle (up to 60 s).
      adminEventBus.push("videos-library-updated", { videoId, reason: "transcode-remote" });
      adminEventBus.push("broadcast-queue-updated", { reason: "transcode-remote", itemId: id });

      req.log.info({ itemId: id, videoId, sourceUrl }, "[broadcast-v2] remote transcode queued");
      return reply.code(202).send({
        ok: true,
        videoId,
        message: "Remote source download and HLS transcoding queued.",
      });
    },
  );

  // ── Duration re-probe ────────────────────────────────────────────────────
  //
  // POST /broadcast-v2/queue/:id/reprobe
  //
  // Re-runs ffprobe against the queue item's best available source URL and
  // writes the real duration to broadcast_queue.duration_secs (and
  // managed_videos.duration_secs when a linked video row exists). Designed
  // for items stuck at the 1800 s upload-time placeholder (ffprobe failed
  // during upload finalize). Returns the old and new duration in seconds.
  app.post<{ Params: { id: string } }>(
    "/queue/:id/reprobe",
    {
      preHandler: requireAuth("editor"),
      bodyLimit: 1048576,
      schema: { response: { 429: _429err } },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const [queueItem] = await db
        .select()
        .from(schema.broadcastQueueTable)
        .where(eq(schema.broadcastQueueTable.id, id))
        .limit(1);
      if (!queueItem) return reply.code(404).send({ error: "Queue item not found" });

      // Prefer HLS master playlist (lighter probe — ffprobe reads only the
      // manifest) over a raw MP4 URL (requires downloading container header).
      // normalizeQueueUrl absolutizes relative /api/... paths using the
      // server's own origin so ffprobe can fetch via HTTP.
      const rawUrl = queueItem.hlsMasterUrl ?? queueItem.localVideoUrl;
      if (!rawUrl) return reply.code(400).send({ error: "Queue item has no probeable source URL" });
      const probeUrl = normalizeQueueUrl(rawUrl) ?? rawUrl;
      if (!probeUrl) return reply.code(400).send({ error: "Queue item has no probeable source URL" });

      const oldDurSecs = queueItem.durationSecs;

      // ffprobe: extract duration from the container format headers only.
      // 45-second timeout matches the prod-sync probe budget.
      const newDur = await new Promise<number | null>((resolve) => {
        const proc = spawn("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          probeUrl,
        ]);
        // unref() so a long-running probe (up to 45 s) does not prevent Node
        // from completing a graceful shutdown when SIGTERM arrives mid-probe.
        // The timer's proc.kill() still fires via the event loop if the process
        // outlives its budget during normal operation.
        proc.unref?.();
        let out = "";
        const timer = setTimeout(() => { proc.kill(); resolve(null); }, 45_000).unref();
        proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        proc.on("close", (code) => {
          clearTimeout(timer);
          const v = parseFloat(out.trim());
          resolve(code === 0 && Number.isFinite(v) && v > 0 ? v : null);
        });
        proc.on("error", () => { clearTimeout(timer); resolve(null); });
      });

      if (newDur === null) {
        return reply.code(422).send({ error: "ffprobe could not determine duration for this source URL" });
      }

      const newDurSecs = Math.round(newDur);

      // Write new duration to broadcast_queue
      await db
        .update(schema.broadcastQueueTable)
        .set({ durationSecs: newDurSecs })
        .where(eq(schema.broadcastQueueTable.id, id));

      // Also sync to managed_videos when a linked video row exists.
      // managed_videos.duration is a text column ("1800", "3723", etc.) that
      // stores seconds as a string — see faststart-recovery.ts for precedent.
      if (queueItem.videoId) {
        await db
          .update(schema.videosTable)
          .set({ duration: String(newDurSecs) })
          .where(eq(schema.videosTable.id, queueItem.videoId))
          .catch((err: unknown) => {
            req.log.warn({ err, videoId: queueItem.videoId }, "[broadcast-v2] reprobe: managed_videos update failed (non-fatal)");
          });
      }

      // Reload orchestrator so the updated duration is used immediately
      void broadcastOrchestrator.reload().catch(() => {});
      // Notify all connected admin clients so their queue panels refresh
      // without waiting for the next poll cycle (up to 60 s without this).
      adminEventBus.push("broadcast-queue-updated", { reason: "reprobe", itemId: id });

      req.log.info(
        { itemId: id, oldDurSecs, newDurSecs, probeUrl },
        "[broadcast-v2] duration re-probed successfully",
      );
      return { ok: true, oldDurSecs, newDurSecs };
    },
  );

  // POST /broadcast-v2/queue/:id/retry-repair
  //
  // Attempts to recover a CORRUPT_SOURCE video by re-running the faststart
  // remux repair. Only valid for 'structure_invalid' items (borderline
  // container damage where a stream-copy remux may rebuild the moov atom)
  // OR items with no kind recorded (pre-column legacy items that may still
  // be recoverable). Refuses 'moov_absent' items — the moov is permanently
  // lost and re-upload is the only option.
  //
  // Flow:
  //   1. Validates: queue item exists, has a linked video, video has
  //      transcodingErrorCode='CORRUPT_SOURCE', video has an objectPath
  //      (source blob in storage), kind is NOT 'moov_absent'.
  //   2. Resets the video row: status → "queued", clears error fields,
  //      resets faststartApplied → false.
  //   3. Re-activates the broadcast queue item (validator may have deactivated it).
  //   4. Fires bus events immediately so the admin UI refreshes.
  //   5. Returns 202. Runs faststart in the background:
  //        • On success: fire bus events + enqueue for HLS transcoding.
  //        • On failure: write CORRUPT_SOURCE error back, re-deactivate
  //          queue item, fire bus events.
  app.post<{ Params: { id: string } }>(
    "/queue/:id/retry-repair",
    {
      preHandler: requireAuth("editor"),
      bodyLimit: 1048576,
      schema: { response: { 429: _429err } },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      // ── 1. Fetch and validate queue item ──────────────────────────────────
      const [queueItem] = await db
        .select()
        .from(schema.broadcastQueueTable)
        .where(eq(schema.broadcastQueueTable.id, id))
        .limit(1);
      if (!queueItem) return reply.code(404).send({ error: "Queue item not found" });
      if (!queueItem.videoId) {
        return reply.code(422).send({ error: "Queue item has no linked video — retry-repair is only available for uploaded videos" });
      }

      const [video] = await db
        .select()
        .from(schema.videosTable)
        .where(eq(schema.videosTable.id, queueItem.videoId))
        .limit(1);
      if (!video) return reply.code(404).send({ error: "Linked video not found" });

      if (video.transcodingErrorCode !== "CORRUPT_SOURCE") {
        return reply.code(422).send({
          error: `Video transcodingErrorCode is '${video.transcodingErrorCode ?? "null"}' — retry-repair only applies to CORRUPT_SOURCE failures`,
        });
      }
      if (video.transcodingErrorKind === "moov_absent") {
        return reply.code(422).send({
          error: "Cannot repair: moov atom is permanently absent (recording was interrupted before moov was written). Re-upload the original source file.",
        });
      }
      if (!video.objectPath) {
        return reply.code(422).send({ error: "Video has no object path — source blob is missing. Re-upload the original file." });
      }

      const objectPath = video.objectPath;
      const videoId = video.id;

      req.log.info(
        { itemId: id, videoId, objectPath, kind: video.transcodingErrorKind ?? "null" },
        "[broadcast-v2] retry-repair: starting faststart remux repair",
      );

      // ── 2. Reset video error state ─────────────────────────────────────────
      await db
        .update(schema.videosTable)
        .set({
          transcodingStatus: "queued",
          transcodingErrorCode: null,
          transcodingErrorKind: null,
          transcodingErrorMessage: null,
          faststartApplied: false,
        })
        .where(eq(schema.videosTable.id, videoId));

      // ── 3. Re-activate queue item (validator may have deactivated it) ──────
      await db
        .update(schema.broadcastQueueTable)
        .set({ isActive: true, validatorDeactivatedReason: null })
        .where(eq(schema.broadcastQueueTable.id, id))
        .catch(() => {});

      // ── 4. Notify admin UI immediately ─────────────────────────────────────
      adminEventBus.push("videos-library-updated", { videoId, reason: "retry-repair-started" });
      adminEventBus.push("broadcast-queue-updated", { reason: "retry-repair-started", itemId: id, videoId });

      // ── 5. Background repair ────────────────────────────────────────────────
      void (async () => {
        try {
          // skipStatusUpdate: true — we manage transcodingStatus ourselves so
          // faststart does not set it to "processing" (which would cause a brief
          // status flicker) and does not restore it on failure. faststartApplied
          // is still written unconditionally by faststart on success.
          await runFaststart(videoId, objectPath, { skipStatusUpdate: true });
          req.log.info({ videoId, itemId: id }, "[broadcast-v2] retry-repair: faststart succeeded");

          // Set faststartApplied explicitly (faststart writes it, but be safe)
          // and enqueue for HLS transcoding so the video gets the best possible
          // stream quality after remux recovery.
          await db
            .update(schema.videosTable)
            .set({ transcodingStatus: "queued" })
            .where(eq(schema.videosTable.id, videoId))
            .catch(() => {});

          try {
            await enqueueTranscode({ videoId, videoPath: objectPath });
            if (!env.TRANSCODER_DISABLE) transcoderDispatcher.nudge();
            req.log.info({ videoId }, "[broadcast-v2] retry-repair: HLS transcode queued after remux recovery");
          } catch (tErr: unknown) {
            req.log.warn({ err: tErr, videoId }, "[broadcast-v2] retry-repair: enqueueTranscode failed (non-fatal — video will broadcast as MP4)");
          }

          adminEventBus.push("videos-library-updated", { videoId, reason: "retry-repair-succeeded" });
          adminEventBus.push("broadcast-queue-updated", { reason: "retry-repair-succeeded", itemId: id, videoId });
          void broadcastOrchestrator.reload().catch(() => {});
        } catch (err: unknown) {
          const errKind = (err as { kind?: string }).kind ?? null;
          const errMsg = err instanceof Error ? err.message : String(err);
          req.log.error(
            { err, videoId, itemId: id, kind: errKind },
            "[broadcast-v2] retry-repair: faststart remux repair failed — marking CORRUPT_SOURCE again",
          );

          await db
            .update(schema.videosTable)
            .set({
              transcodingStatus: "failed",
              transcodingErrorCode: "CORRUPT_SOURCE",
              transcodingErrorKind: errKind,
              transcodingErrorMessage:
                `Remux repair failed (retry-repair): ${errMsg.slice(0, 500)}. ` +
                (errKind === "moov_absent"
                  ? "The moov atom is permanently absent — re-upload the original source file."
                  : "All remux strategies exhausted — re-upload the original source file."),
            })
            .where(eq(schema.videosTable.id, videoId))
            .catch(() => {});

          // Re-deactivate the queue item so the orchestrator doesn't try to
          // play a video that is still corrupt.
          await db
            .update(schema.broadcastQueueTable)
            .set({ isActive: false, validatorDeactivatedReason: "retry-repair-failed" })
            .where(eq(schema.broadcastQueueTable.id, id))
            .catch(() => {});

          adminEventBus.push("videos-library-updated", { videoId, reason: "retry-repair-failed" });
          adminEventBus.push("broadcast-queue-updated", { reason: "retry-repair-failed", itemId: id, videoId });
        }
      })();

      return reply.code(202).send({ ok: true, videoId, message: "Faststart remux repair started in background" });
    },
  );

  // ── GET /api/broadcast-v2/remediation-report ─────────────────────────────
  // Returns a structured health report of HLS / transcoding issues in the
  // active broadcast queue. Designed for operator dashboards and uptime
  // monitors. Auth: editor+. In-process 60 s cache keeps monitor pollers
  // from hammering the DB.
  {
    const REMEDIATION_TTL_MS = 60_000;
    let remediationCache: {
      ts: number;
      data: Awaited<ReturnType<typeof buildRemediationReport>>;
    } | null = null;

    app.get(
      "/remediation-report",
      {
        ...adminGuard,
        schema: { response: { 429: _429err } },
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      },
      async (_req, reply) => {
        const now = Date.now();
        if (remediationCache && now - remediationCache.ts < REMEDIATION_TTL_MS) {
          return reply.send(remediationCache.data);
        }
        const data = await buildRemediationReport();
        remediationCache = { ts: now, data };
        return reply.send(data);
      },
    );
  }

  // ── Boot-time auto-enqueue scan ──────────────────────────────────────────
  // Automatically fixes "missing HLS" on startup — handles the case where
  // queue items existed before the transcoder ran, after a crash recovery,
  // or after a failed job was cleared without re-arming.
  //
  // 15 s delay: lets the DB connection pool warm up, the transcoder
  // dispatcher start its poll loop, and the orchestrator complete its first
  // reload before we spawn FFmpeg processes.
  //
  // Idempotent — autoEnqueueMissingHls() never double-enqueues; items with
  // a live queued/processing job or a completed hlsMasterUrl are skipped.
  //
  // _bootScanScheduled guard: registerDomainRoutes is registered at both
  // /api/v1 and /api prefixes — without this guard the plugin body runs twice
  // creating two timers. The second fires 288 ms after the first completes,
  // causing a redundant DB scan + orchestrator reload on every restart.
  if (!_bootScanScheduled) {
    _bootScanScheduled = true;
    const _bootHlsScanTimer = setTimeout(() => {
      autoEnqueueMissingHls().catch((err: unknown) => {
        logger.warn({ err }, "[broadcast-v2] boot-time auto-enqueue HLS scan failed (non-fatal)");
      });
    }, 15_000);
    _bootHlsScanTimer.unref?.();
  }

  // ── Webhook status & test ──────────────────────────────────────────────────

  const _webhookDeliverySchema = z.object({
    id: z.string(),
    event: z.string(),
    timestamp: z.number(),
    status: z.enum(["success", "failed", "pending"]),
    statusCode: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  });

  /**
   * GET /api/broadcast-v2/webhook/status
   *
   * Returns webhook configuration state and the last ≤20 delivery attempts.
   * The webhook URL is masked (scheme + host only) for safe display in the UI.
   */
  app.get("/webhook/status", {
    ...adminGuard,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    schema: {
      response: {
        200: z.object({
          configured: z.boolean(),
          urlMasked: z.string().optional(),
          recentDeliveries: z.array(_webhookDeliverySchema),
        }),
        429: z.object({ error: z.string() }),
      },
    },
  }, async (_req, reply) => {
    return reply.send(getWebhookStatus());
  });

  /**
   * POST /api/broadcast-v2/webhook/test
   *
   * Fires a test webhook event to the configured URL and returns the delivery
   * result synchronously (waits for all retry attempts to complete). Useful
   * for verifying connectivity and HMAC signing before relying on the webhook
   * in production monitoring.
   *
   * Returns `{ status: "not_configured" }` when BROADCAST_WEBHOOK_URL is unset.
   */
  app.post("/webhook/test", {
    ...adminGuard,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: {
      body: z.object({}),
      response: {
        200: z.object({
          deliveryId: z.string(),
          status: z.enum(["success", "failed", "not_configured"]),
          statusCode: z.number().optional(),
          durationMs: z.number().optional(),
          error: z.string().optional(),
        }),
        429: z.object({ error: z.string() }),
      },
    },
  }, async (_req, reply) => {
    if (!isWebhookConfigured()) {
      return reply.send({ deliveryId: "", status: "not_configured" as const });
    }
    const result = await sendBroadcastWebhookSync("test", "main", {
      message: "This is a test webhook from Temple TV Admin — your endpoint is correctly configured.",
      triggeredAt: new Date().toISOString(),
    });
    return reply.send(result);
  });

}

// ── Module-level remediation helpers ────────────────────────────────────────
// These are hoisted function declarations so they can be referenced both
// inside the export default plugin (route handler) and by runBootRemediationReport.

interface RemediationIssue {
  videoId: string | null;
  title: string | null;
  code: string;
  severity: "error" | "warn";
  message: string;
}

interface RemediationReportData {
  generatedAtMs: number;
  /** 0–100. Decrements by 10 per error issue and 3 per warning. */
  healthScore: number;
  totalQueueItems: number;
  issueCount: number;
  issues: RemediationIssue[];
  summary: {
    hlsStorageMissing: number;
    stuckEncoding: number;
    failedInQueue: number;
    placeholderDuration: number;
  };
  /**
   * True when the storage_blobs connectivity check failed during this report
   * generation.  The hlsStorageMissing count may be under-reported; the health
   * score is penalised by 5 points to reflect the uncertainty.
   */
  storageCheckUnknown: boolean;
}

async function buildRemediationReport(): Promise<RemediationReportData> {
  const issues: RemediationIssue[] = [];
  let hlsStorageMissing = 0;
  let stuckEncoding = 0;
  let failedInQueue = 0;
  let placeholderDuration = 0;
  let storageCheckUnknown = false;

  // 1. Active queue items with video join.
  const queueResult = await db.execute<{
    id: string;
    title: string | null;
    video_id: string | null;
    duration_secs: number;
    transcoding_status: string | null;
    error_code: string | null;
  }>(sql`
    SELECT
      q.id,
      q.title,
      q.video_id,
      q.duration_secs,
      v.transcoding_status,
      v.transcoding_error_code AS error_code
    FROM broadcast_queue q
    LEFT JOIN managed_videos v ON q.video_id = v.id
    WHERE q.is_active = true
    ORDER BY q.sort_order ASC
    LIMIT 500
  `);

  const queueRows = queueResult.rows as Array<{
    id: string;
    title: string | null;
    video_id: string | null;
    duration_secs: number;
    transcoding_status: string | null;
    error_code: string | null;
  }>;

  // 2. Detect failed transcoding and HLS-placeholder duration in active queue.
  for (const row of queueRows) {
    if (row.transcoding_status === "failed") {
      failedInQueue++;
      issues.push({
        videoId: row.video_id,
        title: row.title,
        code: "FAILED_IN_QUEUE",
        severity: "error",
        message:
          `Active queue item '${row.title ?? row.id}' has transcodingStatus='failed'` +
          (row.error_code ? ` (errorCode: ${row.error_code})` : ""),
      });
    }
    if (row.duration_secs === 1800 && row.transcoding_status === "hls_ready") {
      placeholderDuration++;
      issues.push({
        videoId: row.video_id,
        title: row.title,
        code: "HLS_PLACEHOLDER_DURATION",
        severity: "warn",
        message:
          `Active queue item '${row.title ?? row.id}' is hls_ready but still has the 1800-s ` +
          `upload-time placeholder duration — re-probe via reprobe-duration endpoint to fix`,
      });
    }
  }

  // 3. HLS storage missing: check whether master.m3u8 actually exists in
  // object storage for up to 50 hls_ready active queue items.
  const hlsReadyItems = queueRows.filter(
    (r) => r.transcoding_status === "hls_ready" && r.video_id,
  );
  if (hlsReadyItems.length > 0) {
    const sample = hlsReadyItems.slice(0, 50);
    const checkKeys = sample.map((r) => `transcoded/${r.video_id}/master.m3u8`);
    try {
      const pr = await db
        .select({ key: schema.storageBlobsTable.key })
        .from(schema.storageBlobsTable)
        .where(inArray(schema.storageBlobsTable.key, checkKeys));
      const presentKeys = new Set(pr.map((r) => r.key));
      for (const row of sample) {
        const key = `transcoded/${row.video_id}/master.m3u8`;
        if (!presentKeys.has(key)) {
          hlsStorageMissing++;
          issues.push({
            videoId: row.video_id,
            title: row.title,
            code: "HLS_STORAGE_MISSING",
            severity: "error",
            message:
              `Video '${row.video_id}' is marked hls_ready but storage key ` +
              `'${key}' is absent — HLS URL will 404 for every player client`,
          });
        }
      }
    } catch (err) {
      // Fail-closed: surface the uncertainty rather than silently omitting it.
      // The old behaviour ("omitted from report") inflated healthScore by hiding
      // potential HLS_STORAGE_MISSING issues entirely during storage outages.
      storageCheckUnknown = true;
      logger.warn(
        { err },
        "[broadcast-v2] remediation-report: storage_blobs check failed — " +
        "hlsStorageMissing count may be under-reported; healthScore penalised",
      );
      issues.push({
        videoId: null,
        title: null,
        code: "STORAGE_BLOBS_UNREACHABLE",
        severity: "warn",
        message:
          "storage_blobs connectivity check failed — HLS storage validation result is UNKNOWN; " +
          "hlsStorageMissing count may be under-reported until connectivity is restored",
      });
    }
  }

  // 4. Videos stuck at 'encoding' >2 h with no active / done transcoding job.
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    const stuckResult = await db.execute<{
      id: string;
      title: string | null;
    }>(sql`
      SELECT v.id, v.title
      FROM managed_videos v
      WHERE v.transcoding_status = 'encoding'
        AND v.updated_at < ${twoHoursAgo}
        AND NOT EXISTS (
          SELECT 1 FROM transcoding_jobs j
          WHERE j.video_id = v.id
            AND j.status IN ('queued', 'processing', 'done')
        )
      LIMIT 20
    `);
    const stuckRows = stuckResult.rows as Array<{ id: string; title: string | null }>;
    stuckEncoding = stuckRows.length;
    for (const row of stuckRows) {
      issues.push({
        videoId: row.id,
        title: row.title,
        code: "STUCK_ENCODING_NO_JOB",
        severity: "error",
        message:
          `Video '${row.title ?? row.id}' has been stuck at transcodingStatus='encoding' ` +
          `for >2 h with no active / done transcoding job — job was likely lost to a crash`,
      });
    }
  } catch (err) {
    logger.warn(
      { err },
      "[broadcast-v2] remediation-report: stuck-encoding check failed (non-fatal — omitted from report)",
    );
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warn").length;
  // Penalise health score by 5 when the storage check is in an UNKNOWN state:
  // the real hlsStorageMissing count may be higher than what was detected, so
  // the score should not appear falsely healthy during a storage outage.
  const storageUnknownPenalty = storageCheckUnknown ? 5 : 0;
  const healthScore = Math.max(
    0,
    Math.min(100, 100 - errorCount * 10 - warnCount * 3 - storageUnknownPenalty),
  );

  return {
    generatedAtMs: Date.now(),
    healthScore,
    totalQueueItems: queueRows.length,
    issueCount: issues.length,
    issues,
    summary: { hlsStorageMissing, stuckEncoding, failedInQueue, placeholderDuration },
    storageCheckUnknown,
  };
}

/**
 * Called from main.ts ~10 s after the orchestrator starts so broadcast queue
 * health issues appear in the server startup log immediately — without waiting
 * for the first validator cycle (≈2-min cadence). Non-fatal.
 *
 * Exported so main.ts can dynamic-import this module after the orchestrator is
 * confirmed running, minimising startup-time module loading.
 */
export async function runBootRemediationReport(): Promise<void> {
  try {
    const report = await buildRemediationReport();
    if (report.issues.length === 0) {
      logger.info(
        { healthScore: 100, totalQueueItems: report.totalQueueItems },
        "[broadcast-v2] boot remediation report: broadcast queue is healthy — no issues found",
      );
      return;
    }
    logger.warn(
      {
        healthScore: report.healthScore,
        totalQueueItems: report.totalQueueItems,
        issueCount: report.issues.length,
        summary: report.summary,
        topIssues: report.issues
          .slice(0, 10)
          .map((i) => ({ code: i.code, severity: i.severity, videoId: i.videoId })),
      },
      "[broadcast-v2] boot remediation report: broadcast queue health issues detected — " +
      "review GET /api/broadcast-v2/remediation-report for the full list",
    );
  } catch (err) {
    logger.warn({ err }, "[broadcast-v2] boot remediation report failed (non-fatal)");
  }
}
