import type { FastifyInstance } from "fastify";
import { broadcastOrchestrator } from "../engine/broadcast-orchestrator.js";
import { eventLogRepo } from "../repository/event-log.repo.js";
import { getBroadcastV2BootStatus, broadcastFanout } from "../index.js";
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
import { markBadUrl, clearAllBadUrls, getItemsHealth, queueRepo, incrementBadUrlSkipCount, autoSuspendQueueItem, BAD_URL_SKIP_THRESHOLD, getRecentlySuspended, reEnableAllSuspended } from "../repository/queue.repo.js";
import { faststartRecoveryWorker } from "../engine/faststart-recovery.js";
import { db, schema } from "../../../infrastructure/db.js";
import { eq, and, isNull, isNotNull, sql } from "drizzle-orm";
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
import path from "node:path";
import os from "node:os";
import { env } from "../../../config/env.js";

const adminGuard = { preHandler: requireAuth("editor") } as const;
const adminOnlyGuard = { preHandler: requireAuth("admin") } as const;

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
// Scheduled GC: sweep both maps every 10 minutes regardless of traffic
// so stale entries don't accumulate during quiet periods (e.g. overnight).
const _idempotencyGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of seenIdempotencyKeys) {
    if (now - ts > IDEMPOTENCY_TTL_MS) seenIdempotencyKeys.delete(k);
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
async function autoEnqueueMissingHls(): Promise<{ triggered: number }> {
  const q = schema.broadcastQueueTable;
  const v = schema.videosTable;
  const rows = await db
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
    void boostTranscodePriority(row.videoId, 10);
    triggered++;
  }
  if (triggered > 0) {
    void broadcastOrchestrator.reload();
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
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
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
    const allBlocked = broadcastOrchestrator.getAllBlockedInfo();
    return {
      ok: !stuck,
      stuck,
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
        ? Math.max(0, Math.floor((Date.now() - snap.current.startsAtMs) / 1000))
        : null,
      /** Off-air reason when nothing is playing and mode is not override. */
      offAirReason: snap.offAirReason ?? null,
      itemCount,
      uptimeMs,
      serverTimeMs: Date.now(),
      boot,
      reload,
      prodSync: sync,
      drift: broadcastOrchestrator.getDriftInfo(),
      allBlocked,
      /** True when queue has items but nothing is on air and sources are not all blocked. */
      deadAir: !stuck && !allBlocked.allSourcesBlocked && itemCount > 0 && snap.current === null && snap.mode !== "override",
      skipInfo: broadcastOrchestrator.getSkipInfo(),
      redis: {
        connected: broadcastFanout.isConnected(),
        role: broadcastFanout.getRole(),
      },
      airingHistory: broadcastOrchestrator.getAiringHistory(),
      youtubeAutoOverride: getYouTubeAutoOverrideStats(),
      viewerSlope: getViewerSlopeStatus(),
    };
  });

  // ── Public: snapshot + rehydrate ─────────────────────────────────────
  // Snapshot is the cold-start authority for every player surface and the
  // recover-frame refetch target. We must never let an upstream proxy or
  // the browser HTTP cache serve a stale `sequence` — the client uses it
  // to decide whether to replay events. `no-store` is correct here even
  // though the response is small; the cost is one round-trip per cold
  // start and that's already the design.
  app.get("/state", {
    config: {
      // Cold-start authority for every player surface and the recover-frame
      // refetch target. Rate-limited to absorb aggressive polling from
      // reconnecting clients without letting a single bad actor hammer the
      // server. 120 req/min ≈ 1 req/500 ms — well above any legitimate
      // polling cadence (keep-alive is 8 s).
      rateLimit: { max: 120, timeWindow: "1 minute" },
    },
  }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    return { state: broadcastOrchestrator.snapshot() };
  });

  app.get("/rehydrate", {
    config: {
      // Each call triggers a DB query (eventLogRepo.replayFrom). Limit to
      // 10 req/min per IP — replay is only needed on cold start and after
      // reconnect, not on every keep-alive tick.
      rateLimit: { max: 10, timeWindow: "1 minute" },
    },
  }, async (req, reply) => {
    const q = req.query as { fromSequence?: string };
    const fromSeq = Number(q?.fromSequence ?? 0);
    if (!Number.isFinite(fromSeq) || fromSeq < 0) {
      return reply.code(400).send({ error: "invalid fromSequence" });
    }
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
  });

  // ── Admin commands ───────────────────────────────────────────────────
  // Authz piggybacks on the existing /admin RBAC chain — these routes get
  // mounted under both /broadcast-v2 (public read) and /admin/broadcast-v2
  // (full command surface) by the parent plugin.
  app.post("/skip", { ...adminGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = SkipCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) {
      return { ok: true, sequence: broadcastOrchestrator.getSequence(), duplicate: true };
    }
    await broadcastOrchestrator.skip();
    return { ok: true, sequence: broadcastOrchestrator.getSequence() };
  });

  app.post("/override/start", { ...adminOnlyGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = StartOverrideCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) {
      return { ok: true, override: broadcastOrchestrator.snapshot().override, duplicate: true };
    }
    const ov = await broadcastOrchestrator.startOverride({
      kind: parsed.data.kind,
      url: parsed.data.url,
      title: parsed.data.title,
      endsAtMs: parsed.data.endsAtMs ?? null,
      resumeQueueOnEnd: parsed.data.resumeQueueOnEnd,
    });
    return { ok: true, override: ov };
  });

  app.post("/override/stop", { ...adminOnlyGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = StopOverrideCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) return { ok: true, duplicate: true };
    await broadcastOrchestrator.stopOverride();
    return { ok: true };
  });

  // Force-failover switches to the failover source immediately.
  // 5/min — a rapid loop could cycle through sources faster than the
  // orchestrator can establish a stable stream.
  app.post("/force-failover", { ...adminOnlyGuard, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = ForceFailoverCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) return { ok: true, duplicate: true };
    await broadcastOrchestrator.forceFailover(parsed.data.reason);
    return { ok: true };
  });

  // `/clear-failover` and `/reload` are mutating operator commands and
  // must enforce the same body-idempotency contract as every other v2
  // POST. We reuse `StopOverrideCommand` because its shape is exactly
  // `{ idempotencyKey: string }`. Without this, the SSE-driven auto-
  // reload (one POST per queue mutation) and the operator's "Reload"
  // button could race and apply twice — harmless for `reload()` today
  // but a contract violation that future engine refactors could exploit.
  app.post("/clear-failover", { ...adminOnlyGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = StopOverrideCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) return { ok: true, duplicate: true };
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
  app.post("/reload", { ...adminGuard, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = StopOverrideCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) {
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

  app.post("/report-stall", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const parsed = ReportStallCommand.safeParse(req.body);
    if (!parsed.success) return { ok: false, reason: "invalid body" };

    const snap = broadcastOrchestrator.snapshot();
    // Only count votes for the item that is *currently* playing. Stale
    // reports (client reconnected but server already advanced) are no-ops.
    if (!snap.current || snap.current.id !== parsed.data.itemId) {
      return { ok: true, acted: false, reason: "item-not-current" };
    }

    const key = `${broadcastOrchestrator.channelId}:${parsed.data.itemId}`;
    const now = Date.now();
    const prev = stallVotes.get(key);
    const count =
      prev && now - prev.ts < STALL_VOTE_TTL_MS ? prev.count + 1 : 1;
    stallVotes.set(key, { count, ts: now });

    // Record stall in analytics regardless of threshold
    playbackAnalytics.record({
      type: "stall",
      itemId: parsed.data.itemId,
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
      const cooldownKey = `cooldown:${broadcastOrchestrator.channelId}:${parsed.data.itemId}`;
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
      const failCount = incrementBadUrlSkipCount(parsed.data.itemId);
      if (failCount >= BAD_URL_SKIP_THRESHOLD) {
        const itemTitle = snapForBlacklist.current?.title ?? null;
        await autoSuspendQueueItem(parsed.data.itemId, itemTitle, failCount);
        void broadcastOrchestrator.reload();
      }
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
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as Record<string, unknown> | null;
    const itemId = typeof body?.itemId === "string" ? body.itemId.trim() : null;
    const positionSecs = typeof body?.positionSecs === "number" ? body.positionSecs : null;
    if (!itemId || positionSecs === null || !Number.isFinite(positionSecs) || positionSecs < 0) {
      return { ok: false, reason: "missing or invalid fields (itemId, positionSecs)" };
    }

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
  app.post("/play-now", { ...adminGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = PlayNowCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) {
      return { ok: true, sequence: broadcastOrchestrator.getSequence(), duplicate: true };
    }

    // Build new ordered id list from the DB — target item first, rest in
    // their current sort order. Using DB rows instead of orchestrator memory
    // ensures Play Now works regardless of the orchestrator's current mode
    // (failover, offline_hold, or an empty queue where getItems() returns []).
    const targetId = parsed.data.queueItemId;
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

    // 3. Skip so the orchestrator advances to the now-front item.
    await broadcastOrchestrator.skip();

    return { ok: true, sequence: broadcastOrchestrator.getSequence() };
  });

  // ── Admin: source health ──────────────────────────────────────────────
  // Returns per-item URL health status from the in-process bad-URL cache.
  // Powers the "Source blocked" badges on the Master Control page.
  // Admin-protected (editors + admins) — no rate-limit needed since it's
  // authenticated and does only one DB read + in-memory cache lookups.
  app.get("/source-health", adminGuard, async (_req, reply) => {
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
  app.post("/clear-bad-urls", { ...adminGuard, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = StopOverrideCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) return { ok: true, duplicate: true };
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
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, _reply) => {
    const body = req.body as Record<string, unknown> | null;
    const itemId = typeof body?.itemId === "string" ? body.itemId.trim() : null;
    if (!itemId) return { ok: false, reason: "missing itemId" };
    const result = await broadcastOrchestrator.naturalItemEnd(itemId);
    return { ok: true, ...result };
  });

  // ── Admin: trigger HLS transcoding for all queue items missing it ─────
  // Delegates to autoEnqueueMissingHls() — the same function that runs
  // automatically 15 s after boot. Idempotent; rate-limited to 3/min
  // because each call may spawn real FFmpeg processes.
  app.post("/prepare-hls", { ...adminGuard, config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    const parsed = StopOverrideCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!checkIdempotency(parsed.data.idempotencyKey)) return { ok: true, triggered: 0, duplicate: true };

    const { triggered } = await autoEnqueueMissingHls();
    logger.info({ triggered }, "[broadcast-v2] prepare-hls: triggered HLS jobs for queue items");
    return { ok: true as const, triggered };
  });

  // ── Admin: comprehensive diagnostics ─────────────────────────────────
  // Aggregates all subsystem health into a single authenticated JSON
  // response for operators and monitoring tools. Covers boot state,
  // orchestrator runtime, media scanner, queue validation, worker
  // health, orphan cleanup, prod-sync, and analytics summary.
  app.get("/diagnostics", adminGuard, async (_req, reply) => {
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
  app.get("/analytics", adminGuard, async (req, reply) => {
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
    "/broadcast-v2/queue/:id/transcode-remote",
    {
      preHandler: requireAuth("admin"),
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

      req.log.info({ itemId: id, videoId, sourceUrl }, "[broadcast-v2] remote transcode queued");
      return reply.code(202).send({
        ok: true,
        videoId,
        message: "Remote source download and HLS transcoding queued.",
      });
    },
  );

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
  const _bootHlsScanTimer = setTimeout(() => {
    autoEnqueueMissingHls().catch((err: unknown) => {
      logger.warn({ err }, "[broadcast-v2] boot-time auto-enqueue HLS scan failed (non-fatal)");
    });
  }, 15_000);
  _bootHlsScanTimer.unref?.();

}
