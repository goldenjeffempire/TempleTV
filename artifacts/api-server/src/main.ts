import net from "node:net";
import v8 from "node:v8";
import { sql, ne, inArray, eq as drizzleEq } from "drizzle-orm";
import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./infrastructure/logger.js";
import { broadcastEngine } from "./modules/broadcast/queue.engine.js";
import { channelRegistry } from "./modules/channels/channel-registry.js";
import { overrideBus } from "./modules/live-overrides/override-bus.js";
import { closeDb, db, ensureRuntimeIndexes, ensureBroadcastV2Tables, ensureMidnightPrayersTable, ensureMemoryHourlySnapshotsTable, deactivateUnresolvableQueueRows, resetStuckProcessingVideos, resetStuckEncodingVideos, ensureUserSchemaColumns, scheduleStaleDataCleanup, recoverStaleSyncLogs } from "./infrastructure/db.js";
import { closeRedis } from "./infrastructure/redis.js";
import { sseCounter } from "./infrastructure/sse-counter.js";
import { scheduledNotificationDispatcher } from "./modules/scheduled-notifications/dispatcher.js";
import { transcoderDispatcher } from "./modules/transcoder/transcoder.dispatcher.js";
import { youtubeSyncDispatcher } from "./modules/youtube-sync/youtube-sync.dispatcher.js";
import { cleanupWorker } from "./modules/transcoder/cleanup.service.js";
import { pruneAllExpiredRefreshTokens } from "./modules/auth/auth.service.js";
import { recoverStuckPendingNotifications } from "./modules/notifications/notifications.service.js";
import { workerSupervisor } from "./modules/broadcast-v2/engine/worker-supervisor.js";
import { verifyMailer } from "./infrastructure/mailer.js";
import { broadcastScheduler } from "./modules/broadcast/broadcast-scheduler.js";
import { startKeepAlive, stopKeepAlive } from "./modules/network/keep-alive.js";
import { startMemoryWatchdog, stopMemoryWatchdog } from "./infrastructure/memory-watchdog.js";
import { startEventLoopLagMonitor, stopEventLoopLagMonitor } from "./infrastructure/event-loop-lag.js";
import { installDbPoolHealthMonitor, uninstallDbPoolHealthMonitor } from "./infrastructure/db-pool-health.js";
import { markShuttingDown } from "./infrastructure/shutdown-flag.js";
import { schema } from "./infrastructure/db.js";
import { hashPassword } from "./modules/auth/password.js";
import { nanoid } from "nanoid";


/**
 * Process roles, controlled by RUN_MODE env:
 *   api    → Fastify HTTP listener + broadcast engine (broadcast is
 *            in-process state every API replica needs)
 *   worker → background dispatchers only (no HTTP listener) — used
 *            when scaling workers separately from the API
 *   all    → everything in one process (default; ideal for dev and
 *            single-instance production)
 *
 * Adding a new background loop: implement start()/stop() on it,
 * register it in startWorkers()/stopWorkers().
 */
let workerKeepalive: NodeJS.Timeout | null = null;

/**
 * Auto-seed the admin account on startup.
 *
 * Reads SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD from env. When both are set:
 *  - SEED_ADMIN_FORCE=false (default): creates the account only if no
 *    elevated account (admin/editor/system/moderator) currently exists.
 *  - SEED_ADMIN_FORCE=true: deletes ALL existing elevated accounts and
 *    their refresh tokens, then creates a fresh admin. Use this to reset
 *    production credentials after a deployment.
 *
 * The function is idempotent and non-fatal — any error is logged as a
 * warning so a mis-configured seed never prevents the server from booting.
 */
async function seedAdminIfConfigured(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL;
  const password = env.SEED_ADMIN_PASSWORD;
  if (!email || !password) return;

  try {
    const usersTable = schema.usersTable;
    const refreshTokensTable = schema.refreshTokensTable;

    const { sql } = await import("drizzle-orm");
    const normalizedEmail = email.toLowerCase();
    const passwordHash = await hashPassword(password);
    const displayName = email.split("@")[0] ?? "Admin";

    // PRODUCTION HARD-BLOCK ─────────────────────────────────────────────────
    // SEED_ADMIN_FORCE is UNCONDITIONALLY treated as false in production,
    // regardless of the secret value. Force-seeding wipes ALL elevated accounts
    // (admin, editor, moderator, system) on every restart — catastrophic if a
    // secret is accidentally left as "true" after a one-time credential reset.
    //
    // In production, only the safe create-if-absent path ever runs.
    // To reset production credentials: use the admin panel → Users → edit the
    // account, or run `pnpm --filter @workspace/db run studio` with direct DB
    // access. Set SEED_ADMIN_FORCE=false to silence this error log.
    const force = env.SEED_ADMIN_FORCE && env.NODE_ENV !== "production";
    if (env.SEED_ADMIN_FORCE && !force) {
      logger.error(
        { email: normalizedEmail },
        "[seed] PRODUCTION GUARD ACTIVE: SEED_ADMIN_FORCE=true is BLOCKED in " +
        "production — force-seeding wipes all elevated accounts on every restart. " +
        "Running safe idempotent seed (create-if-absent) instead. " +
        "Set SEED_ADMIN_FORCE=false in your secrets to silence this error.",
      );
    }

    if (force) {
      // 1. Wipe all elevated accounts and their refresh tokens.
      const elevated = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(ne(usersTable.role, "user"));

      if (elevated.length > 0) {
        const ids = elevated.map((u) => u.id);
        await db.delete(refreshTokensTable).where(inArray(refreshTokensTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
        logger.info({ wiped: elevated.length }, "[seed] wiped existing elevated accounts");
      }

      // 2. Also remove any remaining user (any role) with this email — using a
      //    case-insensitive comparison to catch emails stored with different casing.
      //    This prevents duplicate-key failures on the subsequent INSERT.
      const remaining = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${normalizedEmail}`);
      if (remaining.length > 0) {
        const rids = remaining.map((u) => u.id);
        await db.delete(refreshTokensTable).where(inArray(refreshTokensTable.userId, rids));
        await db.delete(usersTable).where(inArray(usersTable.id, rids));
        logger.info({ wiped: remaining.length }, "[seed] cleared residual accounts with same email");
      }
    } else {
      // No-op if any elevated account exists.
      const existing = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(ne(usersTable.role, "user"))
        .limit(1);
      if (existing.length > 0) {
        logger.info({ email: normalizedEmail }, "[seed] admin already exists — skipping");
        return;
      }
    }

    // Upsert: INSERT or update on email conflict. This is idempotent and safe
    // against any remaining race conditions or case-variant rows.
    await db
      .insert(usersTable)
      .values({
        id: nanoid(),
        email: normalizedEmail,
        passwordHash,
        displayName,
        role: "admin",
      })
      .onConflictDoUpdate({
        target: usersTable.email,
        set: { role: "admin" as const, passwordHash, updatedAt: new Date() },
      });
    logger.info({ email: normalizedEmail }, "[seed] admin account seeded");
  } catch (err) {
    logger.warn({ err }, "[seed] admin seed failed — server continues without seeding");
  }
}

/**
 * Auto-seed the primary "Temple TV Live" channel on startup.
 *
 * The broadcast engine hardcodes channelId = "temple-tv-live" so the primary
 * channel MUST exist in the DB for `GET /api/channels` to return anything and
 * for the multi-channel registry to report the correct viewer counts.
 *
 * Idempotent — no-op when the primary channel already exists. Non-fatal.
 */
async function seedPrimaryChannelIfAbsent(): Promise<void> {
  try {
    const channelsTable = schema.channelsTable;
    const existing = await db
      .select({ id: channelsTable.id })
      .from(channelsTable)
      .where(drizzleEq(channelsTable.isPrimary, true))
      .limit(1);

    if (existing.length > 0) return; // already seeded

    await db.insert(channelsTable).values({
      id: "temple-tv-live",
      name: "Temple TV Live",
      slug: "main",
      description: "Jesus Christ Temple Ministry — 24/7 live worship, teaching, and praise.",
      color: "#DC2626",
      isPrimary: true,
      isActive: true,
      sortOrder: 0,
    }).onConflictDoNothing();

    logger.info("[seed] primary channel 'Temple TV Live' created");
  } catch (err) {
    logger.warn({ err }, "[seed] primary channel seed failed (non-fatal)");
  }
}

async function startWorkers() {
  scheduledNotificationDispatcher.start();
  if (env.TRANSCODER_DISABLE) {
    logger.info(
      "transcoder dispatcher disabled by TRANSCODER_DISABLE — skipping ffmpeg check and job polling",
    );
  } else {
    transcoderDispatcher.start();
  }
  cleanupWorker.start();
  if (!env.YOUTUBE_SYNC_DISABLE) {
    youtubeSyncDispatcher.start();
  } else {
    logger.info("youtube-sync dispatcher disabled by YOUTUBE_SYNC_DISABLE");
  }
  // Refresh-token pruner: sweeps ALL users' expired/revoked tokens from the
  // refresh_tokens table every 5 minutes. Moved from the per-login hot path
  // (where it fired a DB DELETE on every login/refresh call) to a dedicated
  // background worker so the auth endpoints stay lean. The circuit-breaker
  // wrapper means a DB blip won't permanently silence the pruner.
  workerSupervisor.spawn({
    name: "refresh-token-pruner",
    intervalMs: 5 * 60_000,        // every 5 minutes
    initialDelayMs: 2 * 60_000,    // 2-minute startup delay (let pool warm up first)
    maxConsecutiveFailures: 5,
    fn: () => pruneAllExpiredRefreshTokens().then(() => undefined),
  });

  // Periodic notification stuck-row recovery: notifications.routes.ts fires
  // recoverStuckPendingNotifications() once at boot (onReady hook), but a
  // crash window that opens after startup would leave rows stuck until the
  // next restart. This periodic worker closes that gap by re-running the
  // 30-minute stale-threshold sweep every 30 minutes indefinitely.
  // The function already catches its own errors so this fn never throws.
  workerSupervisor.spawn({
    name: "notification-stuck-recovery",
    intervalMs: 30 * 60_000,       // every 30 minutes
    initialDelayMs: 30 * 60_000,   // first run 30 min after boot (boot run already fired)
    maxConsecutiveFailures: 5,
    fn: () => recoverStuckPendingNotifications().then(() => undefined),
  });

  // Storage health monitor: periodically probes object storage (write/head/delete)
  // to detect failures before they silently affect uploads or HLS delivery.
  if (env.STORAGE_HEALTH_INTERVAL_MS > 0) {
    const { storageHealthMonitor } = await import("./infrastructure/storage-health-monitor.js");
    storageHealthMonitor.start(env.STORAGE_HEALTH_INTERVAL_MS);
  } else {
    logger.info("storage health monitor disabled by STORAGE_HEALTH_INTERVAL_MS=0");
  }
}

async function stopWorkers() {
  scheduledNotificationDispatcher.stop();
  transcoderDispatcher.stop();
  cleanupWorker.stop();
  youtubeSyncDispatcher.stop();
  try {
    const { storageHealthMonitor } = await import("./infrastructure/storage-health-monitor.js");
    storageHealthMonitor.stop();
  } catch {
    // non-fatal if module never loaded
  }
}

async function main() {
  const mode = env.RUN_MODE;
  logger.info({ service: "api", env: process.env.NODE_ENV ?? "unknown", runMode: mode }, "process starting");
  // Log the effective V8 heap limit immediately so production operators can
  // confirm --max-old-space-size is active without having to parse Node flags.
  // heap_size_limit == 0 means V8 hasn't committed to a limit yet; any non-zero
  // value confirms the cap is in force. On free-tier Render this should read
  // ~230 MiB (V8 adds a small internal overhead above the 220 MiB flag value).
  const heapStats = v8.getHeapStatistics();
  logger.info(
    {
      heapSizeLimitMb: Math.round(heapStats.heap_size_limit / 1024 / 1024),
      totalHeapSizeMb: Math.round(heapStats.total_heap_size / 1024 / 1024),
      nodeOptions: process.env.NODE_OPTIONS ?? "(not set)",
    },
    "v8 heap limit — confirm --max-old-space-size is active",
  );
  logger.info("Prometheus metrics exporter active — scrape GET /metrics with admin token");

  // ── Production readiness pre-flight ────────────────────────────────────
  // Run before any service starts. Logs a structured summary of every
  // production config gap so operators have a single log line to scan.
  // Does NOT block startup — all items are advisory except the hard guards
  // already enforced by their respective route modules (e.g. video-serve
  // throws if REQUIRE_HLS_TOKEN=true without HLS_TOKEN_SECRET).
  if (env.NODE_ENV === "production") {
    const configErrors: string[] = [];
    const configWarnings: string[] = [];

    if (env.SEED_ADMIN_FORCE) {
      configWarnings.push(
        "SEED_ADMIN_FORCE=true is set — safely BLOCKED by production guard, " +
        "no accounts were affected; set SEED_ADMIN_FORCE=false to silence this warning",
      );
    }
    if (!env.YOUTUBE_WEBHOOK_SECRET) {
      configErrors.push(
        "YOUTUBE_WEBHOOK_SECRET unset — YouTube webhook POST /youtube/webhook " +
        "signature verification is disabled; spoofed syncs possible",
      );
    }
    // CDN_BASE_URL is intentionally optional on free-tier deployments.
    // HLS_MAX_CONCURRENT already caps concurrent streams to protect origin.
    // Log at INFO (not WARN/ERROR) — no CDN is the expected free-tier config.
    if (!env.HLS_TOKEN_SECRET) {
      configErrors.push(
        "HLS_TOKEN_SECRET unset — HLS streams use public fallback signing key; " +
        "enable REQUIRE_HLS_TOKEN=true after setting a real secret",
      );
    }
    if (env.MEMORY_RESTART_RSS_MB < 300) {
      // Genuinely unsafe — less than 300 MB leaves no headroom for V8 heap +
      // pg pool + pino buffers and will cause constant OOM restart loops before
      // serving a single request. Minimum viable value is ~400 MB.
      configErrors.push(
        `MEMORY_RESTART_RSS_MB=${env.MEMORY_RESTART_RSS_MB} is dangerously low — ` +
        "the server will OOM-restart before completing a single request; " +
        "set to at least 400 MB for constrained hosts, 1536 MB for production.",
      );
    } else if (env.MEMORY_RESTART_RSS_MB < 800) {
      // Advisory for constrained hosts: 400–799 MB is functional provided
      // HLS_MAX_CONCURRENT, transcoding, and upload concurrency are tuned to
      // keep estimated peak RSS below MEMORY_RESTART_RSS_MB.
      // Formula: baseline(~350 MB) + 24×HLS_MAX_CONCURRENT + transcode_peak_mb
      // For unconstrained production hosts set MEMORY_RESTART_RSS_MB ≥ 1536.
      configWarnings.push(
        `MEMORY_RESTART_RSS_MB=${env.MEMORY_RESTART_RSS_MB} is below the recommended ` +
        "1536 MB for production hosts with ≥ 2 GiB RAM. This is intentional on " +
        "memory-constrained instances (512 MiB–1 GiB) — verify HLS_MAX_CONCURRENT " +
        "and TRANSCODER_DISABLE are tuned appropriately for your available memory. " +
        "Formula: MEMORY_RESTART_RSS_MB = 350 + 24×HLS_MAX_CONCURRENT + transcode_peak_mb.",
      );
    }
    if (!env.REQUIRE_HLS_TOKEN) {
      configWarnings.push(
        "REQUIRE_HLS_TOKEN=false — HLS video URLs are publicly accessible without auth tokens",
      );
    }
    if (!env.REDIS_URL) {
      configWarnings.push(
        "REDIS_URL unset — running single-instance mode; rate-limit counters and " +
        "pub/sub are in-process only (fine for single-node deploys)",
      );
    }
    if (env.SHUTDOWN_PRECLOSE_DELAY_MS === 0) {
      configWarnings.push(
        "SHUTDOWN_PRECLOSE_DELAY_MS=0 — /healthz returns 503 on SIGTERM immediately " +
        "but there is no pre-drain delay; set to 5000–10000 ms so your load balancer " +
        "has time to observe the 503 and stop routing before connections are closed " +
        "(required for zero-downtime rolling restarts on Render / AWS ALB / k8s)",
      );
    }
    // SMTP outbound email check. Three scenarios:
    //   • All three vars absent  → warning (email silently no-ops; acceptable if intentional)
    //   • Partially configured   → error (mailer always no-ops even though vars are present)
    //   • All three present      → pass (the verifyMailer() call below confirms connectivity)
    {
      const smtpVarsSet = [env.SMTP_HOST, env.SMTP_USER, env.SMTP_PASS].filter(Boolean).length;
      if (smtpVarsSet === 0) {
        configWarnings.push(
          "SMTP not configured — outbound transactional email (welcome, password reset, " +
          "admin alerts) is disabled; set SMTP_HOST / SMTP_USER / SMTP_PASS to enable",
        );
      } else if (smtpVarsSet < 3) {
        const missing = [
          !env.SMTP_HOST  && "SMTP_HOST",
          !env.SMTP_USER  && "SMTP_USER",
          !env.SMTP_PASS  && "SMTP_PASS",
        ].filter(Boolean);
        configErrors.push(
          `SMTP partially configured — missing: ${missing.join(", ")}. ` +
          "The mailer silently no-ops until all three are set. " +
          "All transactional email (welcome, password reset, admin alerts) will be lost.",
        );
      }
    }

    // Dead-air backstop check: warn when BOTH automatic fallbacks are disabled.
    // If the broadcast queue empties (all transcodes fail, no uploads, etc.) and
    // neither backstop is configured, viewers will see a blank screen indefinitely.
    //   • BROADCAST_DEADAIR_FALLBACK_URL — HLS/RTMP stream applied as override
    //   • YouTube catalog shuffle fallback — cycles YouTube catalog videos
    // One or both should be configured on every production deployment.
    if (!env.BROADCAST_DEADAIR_FALLBACK_URL && env.YOUTUBE_SHUFFLE_FALLBACK_DISABLE) {
      configWarnings.push(
        "No dead-air backstop configured: BROADCAST_DEADAIR_FALLBACK_URL is unset AND " +
        "YOUTUBE_SHUFFLE_FALLBACK_DISABLE=true. If the broadcast queue runs empty, " +
        "viewers will see a blank screen until content is manually added. " +
        "Set BROADCAST_DEADAIR_FALLBACK_URL to an HLS stream, or remove " +
        "YOUTUBE_SHUFFLE_FALLBACK_DISABLE to enable the YouTube catalog shuffle fallback.",
      );
    }

    if (configErrors.length > 0) {
      logger.error(
        { configErrors, configWarnings },
        "[pre-flight] PRODUCTION READINESS FAILURES — resolve before going live",
      );
    } else if (configWarnings.length > 0) {
      logger.warn(
        { configWarnings },
        "[pre-flight] production config warnings — review before going live",
      );
    } else {
      logger.info("[pre-flight] production readiness: all checks passed ✓");
    }
  }

  // Validate API_ORIGIN at startup — a mis-pointed value is the most common
  // cause of broadcast failures (media proxy URLs at wrong host → 404 stalls
  // → bad-URL cache → auto-suspension of all queue items → dead air).
  //
  // Important dev/prod distinction: in non-production environments (NODE_ENV ≠
  // "production"), queue.repo.ts ignores API_ORIGIN for own-origin detection
  // and media-proxy URL construction, using RENDER_EXTERNAL_URL instead.
  // This prevents a prod-sync API_ORIGIN (e.g. https://api.templetv.org.ng)
  // from being treated as "same-origin" in dev, which would skip proxying and cause
  // browser CORP errors when loading prod-sync media.
  const isProdNodeEnv = process.env.NODE_ENV === "production";
  if (env.API_ORIGIN) {
    const parsed = (() => { try { return new URL(env.API_ORIGIN); } catch { return null; } })();
    if (!parsed) {
      logger.error({ API_ORIGIN: env.API_ORIGIN }, "MISCONFIGURED: API_ORIGIN is not a valid URL — broadcast media proxy will be broken");
    } else {
      const h = parsed.hostname;
      const looksLikeAdminFrontend = h.startsWith("admin.") || h.includes("-admin.") || h.includes(".admin.");
      if (looksLikeAdminFrontend) {
        logger.error(
          { API_ORIGIN: env.API_ORIGIN },
          "MISCONFIGURED: API_ORIGIN points to what looks like an admin frontend domain — it must be the API server URL " +
          "(e.g. https://api.templetv.org.ng), not the admin dashboard. " +
          "Broadcast media proxy URLs will be built at the wrong host → 404 stall reports → dead air.",
        );
      } else if (!isProdNodeEnv) {
        // In dev, API_ORIGIN is typically set to the production server for prod-sync.
        // queue.repo.ts ignores it for own-origin / proxy decisions in this environment.
        const devFallback = process.env["RENDER_EXTERNAL_URL"];
        logger.info(
          { API_ORIGIN: env.API_ORIGIN, devOwnOrigin: devFallback ?? "http://localhost (fallback)" },
          "API_ORIGIN set but NODE_ENV=development — used only for prod-sync URL absolutizing; " +
          "own-origin/media-proxy URLs will use RENDER_EXTERNAL_URL instead " +
          "(prevents prod-sync items from bypassing the media proxy in dev)",
        );
      } else {
        logger.info({ API_ORIGIN: env.API_ORIGIN }, "API_ORIGIN validated — own-origin and media proxy URLs will use this base");
      }
    }
  } else {
    const fallback = process.env["RENDER_EXTERNAL_URL"];
    if (isProdNodeEnv && !fallback) {
      // Production with no API_ORIGIN and no auto-detected fallback.
      // Relative localVideoUrl paths (/api/v1/uploads/…) stored in the DB will
      // NOT be absolutized by normalizeQueueUrl() → resolveSource() returns
      // null → every locally-uploaded item causes dead air.  This is the #1
      // cause of broadcast outages after a clean deploy.
      logger.error(
        {},
        "MISCONFIGURED: API_ORIGIN is unset in production and no RENDER_EXTERNAL_URL " +
        "auto-detect fallback is available. " +
        "Relative upload paths (localVideoUrl) will not be absolutized — " +
        "all locally-uploaded broadcast items will fail with resolveSource()=null and cause dead air. " +
        "Set API_ORIGIN=https://your-api-domain.com in the environment.",
      );
    } else if (isProdNodeEnv && fallback) {
      // Production with an auto-detected fallback: functional but fragile —
      // if RENDER_EXTERNAL_URL changes on a redeploy, URLs silently break.
      logger.warn(
        { fallbackOrigin: fallback },
        "API_ORIGIN not set in production — falling back to RENDER_EXTERNAL_URL for " +
        "upload URL absolutizing and media proxy. Set API_ORIGIN explicitly for reliability.",
      );
    } else {
      logger.info(
        { fallbackOrigin: fallback ?? "(none — localhost fallback active)" },
        "API_ORIGIN not set — using fallback origin for upload URL normalisation and media proxy",
      );
    }
  }

  // Pre-warm the pg pool so the first inbound request doesn't pay the
  // connection-establish round-trip. Failures are non-fatal — the app
  // can still boot and recover once the DB becomes reachable; the
  // /readyz probe will report `database: down` until then.
  try {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    logger.info({ elapsedMs: Date.now() - t0 }, "db pool warmed");
  } catch (err) {
    logger.warn({ err }, "db pool warmup failed (will retry on first request)");
  }

  // Ensure expression indexes that Drizzle Kit cannot manage in the schema DSL
  // (GIN FTS, functional lower() indexes, partial indexes, check constraints).
  // Each index is attempted independently — one failure never skips the rest.
  // Awaited so we know all indexes are present before the server starts
  // accepting requests (FTS search and broadcast queue queries depend on them).
  await ensureRuntimeIndexes();

  // Idempotent schema-heal: adds any columns that were introduced after the
  // initial production deploy (TOTP/MFA fields on users, ip/user_agent on
  // refresh_tokens, etc.). Must run BEFORE seedAdminIfConfigured() so the
  // INSERT has all required columns available.
  await ensureUserSchemaColumns();

  // Ensure the memory_hourly_snapshots table exists so the memory watchdog
  // can persist hourly RSS/heap snapshots for the admin diagnostics panel.
  // Non-fatal: server continues without memory history if this fails.
  ensureMemoryHourlySnapshotsTable().catch((err) =>
    logger.warn({ err }, "ensureMemoryHourlySnapshotsTable failed (non-fatal)"),
  );

  // Ensure the midnight_prayers_config table and singleton row exist.
  // Must run BEFORE buildApp() because midnightPrayersService.init() fires
  // inside buildApp() and immediately queries this table.  On production
  // databases provisioned before the midnight-prayers feature was merged,
  // the table will be absent if `drizzle-kit push` was not re-run after
  // the feature was deployed — this self-heal closes that gap permanently.
  await ensureMidnightPrayersTable().catch((err) => {
    logger.error(
      { err },
      "[midnight-prayers] ensureMidnightPrayersTable failed at startup — " +
        "midnight-prayers routes will fail until the table is present; " +
        "run `pnpm --filter @workspace/db run push` to create it",
    );
    // Non-fatal: the server can still serve all other routes.
  });

  // Auto-seed the admin account on startup (no-op if already exists and
  // SEED_ADMIN_FORCE=false, which is the default for safety).
  await seedAdminIfConfigured();

  // Ensure the primary "Temple TV Live" channel row exists so that
  // GET /api/channels returns at least one entry and the broadcast
  // engine has a valid channel to attach to.
  await seedPrimaryChannelIfAbsent();

  // One-time repair: some older uploads stored an absolute URL as objectPath
  // (e.g. "https://api.templetv.org.ng/api/v1/uploads/…") instead of the bare
  // storage key ("uploads/…"). faststart.service.ts now normalises on-the-fly,
  // but any row that never goes through faststart again (already has
  // faststart_applied=true or hlsMasterUrl set) would keep the bad value
  // indefinitely. This UPDATE is idempotent and fast (index seek on LIKE 'http%').
  void (async () => {
    try {
      const result = await db.execute(sql`
        UPDATE managed_videos
        SET    object_path = 'uploads/' || SUBSTRING(object_path FROM '/api/v1/uploads/(.+)$')
        WHERE  object_path LIKE 'http%'
          AND  object_path LIKE '%/api/v1/uploads/%'
      `);
      const count = (result as { rowCount?: number }).rowCount ?? 0;
      if (count > 0) {
        logger.warn(
          { repaired: count },
          "[startup] repaired managed_videos rows with absolute-URL objectPath → bare storage key",
        );
      }
    } catch (err) {
      logger.warn({ err }, "[startup] objectPath repair failed (non-fatal)");
    }
  })();

  // Hydrate the live-override in-memory cache from the DB so `buildState()`
  // in the WS gateway returns the correct answer immediately when the first
  // client connects, even if the server restarted mid-stream.
  await overrideBus.init();
  logger.info(
    { isLive: Boolean(overrideBus.active), title: overrideBus.active?.title ?? null },
    "override bus initialised",
  );

  // HLS viewer routes (GET/HEAD /hls/:videoId/*) are intentionally public —
  // no HMAC token is required from viewers. The private object-storage bucket
  // is protected by this server acting as a proxy; all surfaces (TV, mobile,
  // web, Chromecast, VLC) can load manifests and segments without a token.
  //
  // REQUIRE_HLS_TOKEN is retained only for the token-signing infrastructure
  // used by internal orchestrator probes (makeHlsToken / validateHlsToken).
  // The old auto-enable logic (set REQUIRE_HLS_TOKEN=true when HLS_TOKEN_SECRET
  // is present) has been removed because it contradicts the intentionally-public
  // viewer routes and produces a misleading startup log.
  if (env.HLS_TOKEN_SECRET) {
    logger.info(
      "HLS_TOKEN_SECRET is set — HLS token signing available for internal probes. " +
      "HLS viewer routes remain unconditionally public (no ?t=TOKEN required).",
    );
  }

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  if (mode === "api" || mode === "all") {
    app = await buildApp();
    try {
      await broadcastEngine.start();
    } catch (err) {
      logger.error(
        { err },
        "broadcast engine failed to start (server still listening)",
      );
    }
    // Auto-create broadcast v2 DB tables so the orchestrator never crashes
    // on a missing-table error even when drizzle-kit push was not run.
    // Idempotent (CREATE TABLE IF NOT EXISTS). AWAITED — the orchestrator
    // started below (ensureBroadcastV2Started) strictly depends on these tables
    // existing, so this must complete first to avoid a fresh-DB race. The
    // CREATE statements are cheap; under a DB outage the await is bounded by the
    // pool connectionTimeout and the .catch keeps it non-fatal (the
    // orchestrator's own hydrate() 42P01 guards still cover residual issues).
    // app.listen() runs later (below), so this adds only a brief, bounded delay
    // to startup. Matches the established "await the ensureXxxTable() before its
    // dependent service starts" pattern used for the midnight-prayers table.
    await ensureBroadcastV2Tables().catch((err) =>
      logger.error({ err }, "db: ensureBroadcastV2Tables failed (non-fatal)"),
    );
    // Deactivate queue rows whose video has no playable source so the
    // orchestrator's pre-resolution step never rejects them silently.
    // Non-destructive (is_active=false, not DELETE) and non-blocking.
    deactivateUnresolvableQueueRows().catch((err) =>
      logger.warn({ err }, "db: deactivateUnresolvableQueueRows failed (non-fatal)"),
    );
    // Reset videos stuck in transcodingStatus='processing' from a prior
    // mid-faststart server crash. loadActive() blocks 'processing' items, so
    // without this reset those queue slots would be silently held forever.
    resetStuckProcessingVideos().catch((err) =>
      logger.warn({ err }, "db: resetStuckProcessingVideos failed (non-fatal)"),
    );
    // Reset videos stuck in transcodingStatus='encoding' whose transcoding job
    // is no longer active (server crash or lost job row). These videos would
    // stay 'encoding' indefinitely and never advance to 'hls_ready' without
    // this reset. Safe: gated on "no active job" so live encodes are untouched.
    resetStuckEncodingVideos().catch((err) =>
      logger.warn({ err }, "db: resetStuckEncodingVideos failed (non-fatal)"),
    );
    // Mark youtube_sync_log rows stuck at 'running' as 'interrupted'.
    // These accumulate when the process is killed mid-sync; without this
    // cleanup the admin Sync panel shows them as perpetually in-progress.
    recoverStaleSyncLogs().catch((err) =>
      logger.warn({ err }, "db: recoverStaleSyncLogs failed (non-fatal)"),
    );
    // Stale-data GC: expired tokens, stale viewer sessions, old upload sessions,
    // old broadcast event log entries. Runs at 30 s after boot then every 6 h.
    scheduleStaleDataCleanup();

    // Broadcast v2 orchestrator (rebuild — coexists with v1 until cut-over).
    try {
      const { ensureBroadcastV2Started } = await import("./modules/broadcast-v2/index.js");
      await ensureBroadcastV2Started();
    } catch (err) {
      logger.error({ err }, "[broadcast-v2] orchestrator failed to start (non-fatal)");
    }
    // HLS self-heal: on every boot, clear any bad-URL marks and accumulated
    // media-scanner failure counts that were built up during a prior run where
    // REQUIRE_HLS_TOKEN was enabled but internal probes were getting 401 (before
    // the loopback bypass was applied). Re-enable any items auto-suspended by
    // the scanner's circuit breaker. Runs 3 s after boot so the orchestrator's
    // initial reload completes first; fully non-fatal.
    void (async () => {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3_000); t.unref?.(); });
      try {
        const { broadcastOrchestrator, mediaIntegrityScanner } = await import("./modules/broadcast-v2/index.js");
        const { clearAllBadUrls, reEnableAllSuspended } = await import("./modules/broadcast-v2/repository/queue.repo.js");
        broadcastOrchestrator.resetQueueHash();
        clearAllBadUrls();
        mediaIntegrityScanner.clearFailureCounts();
        const reEnabled = await reEnableAllSuspended();
        if (reEnabled > 0) {
          logger.info(
            { reEnabled },
            "[startup] HLS self-heal: re-enabled items previously auto-suspended by the media scanner",
          );
        }
      } catch (err) {
        logger.warn({ err }, "[startup] HLS self-heal failed (non-fatal)");
      }
    })();
    // Startup library scan: immediately pull all hls_ready (and other eligible)
    // library videos into the broadcast queue so 24/7 broadcasting begins with a
    // full queue rather than waiting up to 5 min for the first queue-health-guard
    // tick.  Runs fire-and-forget with a 5 s delay to let the DB pool and
    // orchestrator stabilise before the first batch of INSERT ON CONFLICT writes.
    // Non-fatal; the queue-health-guard will recover on its first cycle if this
    // scan is skipped by the isAutoEnqueueEnabled() guard.
    void (async () => {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 5_000); t.unref?.(); });
      try {
        const { scanLibraryAndEnqueue } = await import("./modules/broadcast/auto-enqueue.service.js");
        const result = await scanLibraryAndEnqueue({ reason: "startup", maxToAdd: 500 });
        if (result.enqueued > 0) {
          logger.info(
            { scanned: result.scanned, enqueued: result.enqueued, skipped: result.skipped },
            "[startup] library scan: queued eligible videos for broadcast",
          );
        } else {
          logger.info(
            { scanned: result.scanned, skipped: result.skipped },
            "[startup] library scan: all eligible videos already in broadcast queue",
          );
        }
      } catch (err) {
        logger.warn({ err }, "[startup] library scan failed (non-fatal)");
      }
    })();
    // Gap 6: Boot remediation report — surface HLS / transcoding issues in the
    // server startup log immediately after the orchestrator starts so operators
    // notice problems without waiting for the first validator cycle (~2 min).
    // Fire-and-forget with a 10 s delay to let the pool warm and the
    // orchestrator complete its first reload. Non-fatal.
    void (async () => {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 10_000); t.unref?.(); });
      try {
        const { runBootRemediationReport } = await import("./modules/broadcast-v2/io/rest.routes.js");
        await runBootRemediationReport();
      } catch (err) {
        logger.warn({ err }, "[broadcast-v2] boot remediation report failed (non-fatal)");
      }
    })();
    // Startup verification: 30 s after boot, log a structured health summary
    // covering all autonomous components so operators can confirm everything
    // initialised correctly without hitting the /health endpoint manually.
    // Non-blocking; never fatal.
    void (async () => {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 30_000); t.unref?.(); });
      try {
        const {
          getBroadcastHealthMonitorStatus,
          getContentRotationStatus,
          getQueueHealthGuardStatus,
          broadcastOrchestrator,
        } = await import("./modules/broadcast-v2/index.js");
        const { getDbPoolHealthStatus } = await import("./infrastructure/db-pool-health.js");
        const { getStorageHealthStatus } = await import("./infrastructure/storage-health-monitor.js");
        const pool = getDbPoolHealthStatus();
        const hm = getBroadcastHealthMonitorStatus();
        const rot = getContentRotationStatus();
        const qhg = getQueueHealthGuardStatus();
        const sth = getStorageHealthStatus();
        logger.info(
          {
            broadcast: {
              started: broadcastOrchestrator.isStarted(),
              sequence: broadcastOrchestrator.getSequence(),
              itemCount: broadcastOrchestrator.getItemCount(),
            },
            healthMonitor: {
              staleThresholdMs: hm.staleThresholdMs,
              recoveryThresholdMs: hm.recoveryThresholdMs,
            },
            contentRotation: {
              strategy: rot.strategy,
              intervalMs: rot.intervalMs,
            },
            dbPool: {
              active: pool.active,
              idle: pool.idle,
              waiting: pool.waiting,
              max: pool.max,
              utilizationPct: pool.utilizationPct,
            },
            storageHealth: {
              healthy: sth.healthy,
              enabled: sth.enabled,
              consecutiveFailures: sth.consecutiveFailures,
            },
            queueHealthGuard: {
              threshold: qhg.threshold,
              lastActiveCount: qhg.lastActiveCount,
              belowThreshold: qhg.belowThreshold,
              totalRebuilds: qhg.totalRebuilds,
            },
          },
          "[startup-verification] 30s post-boot autonomous component check",
        );
      } catch (err) {
        logger.warn({ err }, "[startup-verification] post-boot health check failed (non-fatal)");
      }
    })();
    // Cross-environment broadcast queue mirror — only activates when
    // PROD_SYNC_API_URL is set (typically dev pointing at prod). No-op in
    // production. See modules/prod-sync/prod-queue-sync.ts for design notes.
    try {
      const { prodQueueSync } = await import("./modules/prod-sync/prod-queue-sync.js");
      prodQueueSync.start();
    } catch (err) {
      logger.warn({ err }, "[prod-sync] failed to start (non-fatal)");
    }
    // Boot the multi-channel registry — starts per-channel engines for all
    // non-primary active channels stored in the `channels` table.
    // Runs after the primary engine so the DB pool is already warm.
    channelRegistry.boot().catch((err) =>
      logger.warn({ err }, "channel registry boot error (non-fatal)"),
    );
    // OMEGA Broadcast Automation (V1 scheduler retired — v2 orchestrator handles
    // all scheduling autonomously via the queue-health-guard and content-rotation
    // workers; the v1 scheduler is kept importable for the stop() call on shutdown
    // but no longer started on boot).
    // Non-blocking SMTP health-check — logs warning if misconfigured but
    // never prevents the server from accepting HTTP requests.
    verifyMailer().catch((err) => logger.warn({ err }, "mailer verify error"));
    // Start the unacknowledged-alert email escalation sweeper.  Listens for
    // ops-alert SSE events and escalates to email after 10 min unacknowledged.
    try {
      const { startUnackedAlertSweeper } = await import("./modules/admin-ops/unacked-alerts.js");
      startUnackedAlertSweeper();
    } catch (err) {
      logger.warn({ err }, "[unacked-alerts] sweeper failed to start (non-fatal)");
    }
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    // Explicit keepAlive + headersTimeout tuning for sustained connection reuse
    // under concurrent SSE + HLS load. Node's default keepAliveTimeout=5s
    // causes constant TCP reconnects from CDN edges and HLS segment clients.
    // headersTimeout MUST exceed keepAliveTimeout to prevent a race where the
    // headers deadline fires first on a freshly re-used keep-alive connection.
    app.server.keepAliveTimeout = env.HTTP_KEEPALIVE_MS;
    app.server.headersTimeout = env.HTTP_HEADERS_TIMEOUT_MS;
    // OMEGA Hardening: keep-alive self-ping to prevent free-tier cold starts.
    startKeepAlive();
    // F17: memory pressure watchdog — emits ops-alert SSE when RSS
    // exceeds MEMORY_WARN_RSS_MB so the admin console can warn operators.
    startMemoryWatchdog();
    // Monitor event-loop lag so CPU starvation on constrained hosts (0.1 vCPU
    // Render free tier) is visible before health-check timeouts trigger SIGTERM.
    startEventLoopLagMonitor();
    // Monitor pg connection pool utilization; emits ops-alert SSE on saturation.
    installDbPoolHealthMonitor();
    logger.info({ port: env.PORT }, "API ready — http://0.0.0.0:" + env.PORT);

    // Dev-only: bind a secondary port and forward to the real listener.
    // Replit's edge proxy maps externalPort=80 ambiguously when the
    // .replit file declares both localPort 5000 and 8080 against
    // externalPort 80; whichever local port the proxy picks must have
    // a listener or every public request returns 502. This forwarder
    // makes both ports answer in dev. In production NODE_ENV=production
    // and PORT=8080 already, so this branch is skipped.
    const FORWARD_PORT = 8080;
    if (env.NODE_ENV !== "production" && env.PORT !== FORWARD_PORT) {
      const forwarder = net.createServer((sock) => {
        const upstream = net.connect(env.PORT, "127.0.0.1");
        sock.on("error", () => upstream.destroy());
        upstream.on("error", () => sock.destroy());
        sock.pipe(upstream).pipe(sock);
      });
      forwarder.on("error", (err) => {
        logger.warn({ err, port: FORWARD_PORT }, "dev port forwarder error");
      });
      forwarder.listen(FORWARD_PORT, "0.0.0.0", () => {
        logger.info(
          { from: FORWARD_PORT, to: env.PORT },
          "dev TCP forwarder ready (compensates for duplicate .replit port mapping)",
        );
      });
    }
  }

  if (mode === "worker" || mode === "all") {
    await startWorkers();
  } else if (mode === "api") {
    // RUN_MODE=api skips all background workers (transcoder, YouTube sync,
    // content rotation, queue-health-guard, etc.). This is intentional when
    // running separate worker replicas, but easy to misconfigure in single-
    // instance deploys. Emit a persistent WARN + ops-alert so operators notice.
    logger.warn(
      { runMode: mode },
      "[startup] RUN_MODE=api — background workers are NOT running in this process. " +
        "Transcoding, YouTube sync, broadcast health-monitoring, and queue maintenance " +
        "require a separate worker process (RUN_MODE=worker) or a combined process (RUN_MODE=all).",
    );
    try {
      const { adminEventBus: aeb } = await import("./modules/admin-ops/admin-event-bus.js");
      aeb.push("ops-alert", {
        level: "warn",
        message:
          "RUN_MODE=api — background workers are disabled in this process. " +
          "Start a worker replica (RUN_MODE=worker) or switch to RUN_MODE=all.",
        source: "startup",
      });
    } catch { /* non-fatal */ }
  }

  if (mode === "worker") {
    // Keep the worker process alive even though there's no HTTP
    // listener. The dispatcher uses setTimeout chains, which alone
    // wouldn't keep the event loop pinned forever in some Node
    // configurations — an interval is the cheapest deterministic
    // keep-alive. Cleared on shutdown.
    workerKeepalive = setInterval(() => undefined, 1 << 30);
  }

  // Set to true once all initialisation is complete. Guards unhandledRejection
  // and uncaughtException handlers: before startup is done there is no live
  // broadcast state to checkpoint, so those handlers exit immediately rather
  // than attempting a potentially half-initialised drain sequence.
  let startupComplete = false;
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Safety net: if the drain sequence hangs (DB pool stalls, a worker
    // deadlocks, a spawned child won't die), force-exit before the platform
    // escalates to SIGKILL. SIGKILL skips checkpoint flush and leaves broadcast
    // position unsaved. 25 s budget: PRECLOSE(10 s) + SSE/WS drain(10 s) +
    // storage/DB close(5 s). The memory-watchdog has its own 60 s gate for
    // watchdog-triggered SIGTERMs; this gate covers all other SIGTERM sources.
    const SHUTDOWN_FORCE_EXIT_MS = 25_000;
    const forceExitTimer = setTimeout(() => {
      logger.fatal({ signal, budgetMs: SHUTDOWN_FORCE_EXIT_MS }, "shutdown drain budget exceeded — force-exiting");
      process.exit(exitCode || 1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExitTimer.unref();
    // Signal the health liveness probe to return 503 immediately so upstream
    // load balancers (Render, AWS ALB, k8s ingress, Replit proxy) observe the
    // failure and stop routing new requests before we close any connections.
    // This is the key mechanism for zero-downtime rolling restarts.
    markShuttingDown();
    logger.info({ signal }, "graceful shutdown starting");

    // Give the load balancer time to act on the 503 from /healthz before
    // we start closing services. SHUTDOWN_PRECLOSE_DELAY_MS should be set
    // to ≥ 2× the LB health-check interval in production (recommended: 5000).
    // Defaults to 0 (instant) so dev restarts are unaffected.
    if (env.SHUTDOWN_PRECLOSE_DELAY_MS > 0) {
      logger.info(
        { delayMs: env.SHUTDOWN_PRECLOSE_DELAY_MS },
        "pre-shutdown LB drain delay — /healthz returning 503, waiting for LB to drain traffic",
      );
      await new Promise<void>((r) => setTimeout(r, env.SHUTDOWN_PRECLOSE_DELAY_MS));
    }

    if (mode === "worker" && workerKeepalive) clearInterval(workerKeepalive);
    if (mode === "api" || mode === "all") {
      broadcastEngine.stop();
      // Stop all secondary channel engines. Without this call the timers and
      // DB connections they hold stay alive past process.exit(), preventing
      // the connection pool from draining cleanly.
      channelRegistry.shutdown();
      broadcastScheduler.stop();
      // Stop unacknowledged-alert sweeper (60-second setInterval).
      try {
        const { stopUnackedAlertSweeper } = await import("./modules/admin-ops/unacked-alerts.js");
        stopUnackedAlertSweeper();
      } catch { /* non-fatal */ }
      stopKeepAlive();
      stopMemoryWatchdog();
      stopEventLoopLagMonitor();
      uninstallDbPoolHealthMonitor();
      // Stop the viewer-slope monitor (1-min setInterval) so it does not
      // keep the event loop alive after all other subsystems have shut down.
      try {
        const { stopViewerSlopeMonitor } = await import("./modules/admin-ops/viewer-slope-monitor.js");
        stopViewerSlopeMonitor();
      } catch {
        /* non-fatal — monitor may not have been started */
      }
      try {
        const { stopBroadcastV2 } = await import("./modules/broadcast-v2/index.js");
        await stopBroadcastV2();
      } catch {
        // fanout already closed or never started — non-fatal
      }
      // Force-close all remaining SSE connections from the v1 broadcast,
      // realtime, and admin-ops handlers. Each cleanup is idempotent and
      // self-removes from its registry, so calling them here before the
      // drain loop means the loop completes in O(ms) instead of timing out.
      try {
        const { closeAllBroadcastSseSessions } = await import("./modules/broadcast/broadcast.routes.js");
        closeAllBroadcastSseSessions();
      } catch { /* non-fatal */ }
      try {
        const { closeAllRealtimeSseSessions } = await import("./modules/realtime/sse.gateway.js");
        closeAllRealtimeSseSessions();
      } catch { /* non-fatal */ }
      try {
        const { closeAllAdminSseSessions } = await import("./modules/admin-ops/admin-ops.routes.js");
        closeAllAdminSseSessions();
      } catch { /* non-fatal */ }
      // Force-close all realtime WS connections (v1 playback surface).
      // Without this, the event-listener registrations on broadcastEngine,
      // overrideBus, and signalBus kept zombie sockets alive past app.close(),
      // delaying GC and inflating wsCounter in the diagnostics panel.
      try {
        const { closeAllRealtimeWsSessions } = await import("./modules/realtime/ws.gateway.js");
        closeAllRealtimeWsSessions();
      } catch { /* non-fatal */ }
      // Force-close all broadcast-v2 WS connections (player surface). Without
      // this, established v2 WS sockets keep their orchestrator "frame" listener
      // registrations alive and prevent app.close() from completing, hanging the
      // process until SHUTDOWN_DRAIN_MS elapses and the platform escalates to
      // SIGKILL — the restart-loop signature seen in production. The v1 SSE/WS
      // gateways already drain here; v2 WS was the missing surface.
      try {
        const { closeAllBroadcastV2WsSessions } = await import("./modules/broadcast-v2/io/ws.gateway.js");
        closeAllBroadcastV2WsSessions();
      } catch { /* non-fatal */ }
      // Stop the chat ping/zombie-sweep interval. Without this the setInterval
      // kept the event loop alive after all other subsystems had shut down,
      // delaying process.exit(0) by up to 25 s in low-traffic scenarios.
      try {
        const { stopChatPingInterval } = await import("./modules/realtime/chat.routes.js");
        stopChatPingInterval();
      } catch { /* non-fatal */ }
      // Force-close graphics, midnight-prayers, and youtube-live SSE sessions.
      // These modules don't have the volume of v1/realtime SSE but share the
      // same zombie risk; closing them here ensures app.close() drains quickly.
      try {
        const { closeAllGraphicsSseSessions } = await import("./modules/graphics/graphics.routes.js");
        closeAllGraphicsSseSessions();
      } catch { /* non-fatal */ }
      try {
        const { closeAllMidnightPrayersSseSessions } = await import("./modules/midnight-prayers/midnight-prayers.routes.js");
        closeAllMidnightPrayersSseSessions();
      } catch { /* non-fatal */ }
      try {
        const { closeAllYoutubeLiveSseSessions } = await import("./modules/youtube-live/youtube-live.routes.js");
        closeAllYoutubeLiveSseSessions();
      } catch { /* non-fatal */ }
      // Stop the prod-sync poll timer (setInterval) so it does not keep the
      // event loop alive or spawn ffprobe child processes after shutdown.
      try {
        const { prodQueueSync } = await import("./modules/prod-sync/prod-queue-sync.js");
        prodQueueSync.stop();
      } catch { /* non-fatal — prod-sync may not have been started */ }
    }
    if (mode === "worker" || mode === "all") void stopWorkers();
    if (app) {
      // F20: wait for open SSE connections to drain before closing the server.
      // All SSE handlers have already been force-closed above, so this loop
      // should complete in the first iteration. The timeout is retained as a
      // safety net for any connections that slipped through.
      const drainMs = env.SHUTDOWN_DRAIN_MS;
      if (drainMs > 0) {
        const openSse = sseCounter.get();
        if (openSse > 0) {
          logger.info({ openSse, drainMs }, "waiting for SSE connections to drain");
          const deadline = Date.now() + drainMs;
          while (sseCounter.get() > 0 && Date.now() < deadline) {
            await new Promise<void>((r) => setTimeout(r, 100));
          }
          const remaining = sseCounter.get();
          if (remaining > 0) {
            logger.warn({ remaining }, "SSE drain timeout reached — forcing close");
          } else {
            logger.info("all SSE connections drained");
          }
        }
      }
      try {
        await app.close();
      } catch (err) {
        logger.error({ err }, "error closing fastify");
      }
    }
    // Drain active storage read streams before closing the DB pool.
    // Without this, in-flight streamChunked generators issue SUBSTRING queries
    // against the closing pool and crash with "Cannot use a pool after calling
    // end on the pool".  signalStorageShutdown() tells all generators to stop
    // at their next chunk boundary; we then wait up to streamDrainMs for the
    // counter to reach zero before proceeding to pool.end().
    //
    // Uses SHUTDOWN_DRAIN_MS (same env var as SSE drain) with a 5 s floor so
    // a very low SHUTDOWN_DRAIN_MS doesn't truncate in-flight segment reads.
    // Default: max(5 000, SHUTDOWN_DRAIN_MS) = 5 s dev / 10 s production.
    try {
      const { signalStorageShutdown, getActiveStorageStreamCount } =
        await import("./infrastructure/storage.js");
      signalStorageShutdown();
      const streamDrainMs = Math.max(env.SHUTDOWN_DRAIN_MS, 5_000);
      const streamDrainDeadlineMs = Date.now() + streamDrainMs;
      const activeAtSignal = getActiveStorageStreamCount();
      if (activeAtSignal > 0) {
        logger.info({ active: activeAtSignal, streamDrainMs }, "waiting for storage streams to drain");
      }
      while (getActiveStorageStreamCount() > 0 && Date.now() < streamDrainDeadlineMs) {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      const remaining = getActiveStorageStreamCount();
      if (remaining > 0) {
        logger.warn({ remaining, streamDrainMs }, "storage stream drain timeout — forcing pool close");
      } else if (activeAtSignal > 0) {
        logger.info("all storage streams drained — closing db pool");
      }
    } catch {
      /* storage module not loaded (worker-only mode) — skip */
    }
    await closeDb().catch((err) => logger.warn({ err }, "error closing db pool during shutdown"));
    await closeRedis().catch((err) => logger.warn({ err }, "error closing redis during shutdown"));
    process.exit(exitCode);
  };

  // All initialisation complete — subsystems live, broadcast started,
  // DB pool warm. Mark startup done so the error handlers below can call
  // shutdown() safely.
  startupComplete = true;

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "unhandledRejection — triggering graceful shutdown");
    // Before startup completes there is no live broadcast state to save —
    // exit immediately so pnpm restarts cleanly without a hung drain.
    if (!startupComplete) { process.exit(1); return; }
    // After startup: flush broadcast checkpoint + drain connections before
    // exiting. The shuttingDown guard in shutdown() prevents re-entry if a
    // second rejection fires during the drain (e.g. DB pool error on close).
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException — triggering graceful shutdown");
    if (!startupComplete) { process.exit(1); return; }
    void shutdown("uncaughtException", 1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "API failed to boot");
  process.exit(1);
});
