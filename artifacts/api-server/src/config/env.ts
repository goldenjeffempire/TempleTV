import { z } from "zod";

// When Replit's built-in PostgreSQL is provisioned it sets PGHOST, PGPORT,
// PGUSER, PGPASSWORD and PGDATABASE as runtime-managed env vars. Prefer those
// over whatever DATABASE_URL secret the user may have stored (which could be
// a stale external URL from a previous deployment platform).
if (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE) {
  const { PGHOST, PGPORT = "5432", PGUSER, PGPASSWORD = "", PGDATABASE } = process.env;
  process.env.DATABASE_URL = `postgresql://${PGUSER}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
}

/**
 * Strongly-typed, validated environment. All env access in the
 * application MUST flow through `env`. New variables go here.
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().nonnegative().default(8080),
  /** Dev-only: port the TV Vite dev server listens on (proxied at /tv/* in development). */
  TV_DEV_PORT: z.coerce.number().int().nonnegative().default(23876),
  /** Dev-only: port the Expo Metro web server listens on (proxied at /mobile/* in development). */
  MOBILE_DEV_PORT: z.coerce.number().int().nonnegative().default(18115),
  // HTTP server connection tuning. Node's built-in defaults (keepAliveTimeout=5s,
  // headersTimeout=60s) cause frequent TCP teardowns from CDN edge nodes and
  // HLS clients that keep connections alive for segment streaming. Raising
  // keepAliveTimeout to 75 s matches typical CDN idle-connection budgets;
  // headersTimeout must be strictly larger to avoid a race where the headers
  // timeout fires first on a freshly re-used keep-alive connection.
  HTTP_KEEPALIVE_MS: z.coerce.number().int().positive().default(75_000),
  HTTP_HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(80_000),
  // Absolute base URL used for outbound webhook callbacks (e.g. Stripe, Expo).
  WEBHOOK_BASE_URL: z.string().url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be ≥32 chars"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be ≥32 chars"),
  // Access token lifetime.  Default raised from 900 s (15 min) → 3600 s (1 h)
  // so that transient network failures or browser background-tab timer
  // throttling cannot expire an admin session between keep-alive ticks.
  // Refresh tokens are 30 days; keep-alive rotates/extends far more often.
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  // F10: JWT signing algorithm. Only HS256 (symmetric HMAC-SHA-256) is
  // supported. RS256 (asymmetric RSA) requires PEM key-import which is not
  // yet implemented in the jose migration (F28). Accepts only "HS256" so
  // Zod validation fails cleanly at startup rather than crashing inside the
  // jwt module after secrets have already been loaded.
  JWT_ALGORITHM: z.literal("HS256").default("HS256"),
  // F22: when true, a refresh token presented from a different IP than the
  // one it was issued from is hard-rejected instead of soft-warned.
  // Default is environment-aware: explicit "true"/"false" overrides; unset
  // defaults to STRICT in production (admin/system surfaces benefit from
  // strict replay protection) and LENIENT in dev (mobile IP changes during
  // testing are common and legitimate).
  REFRESH_TOKEN_STRICT_IP_CHECK: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === true || v === "true") return true;
      if (v === false || v === "false") return false;
      // Unset: default to strict in production, lenient elsewhere.
      return process.env["NODE_ENV"] === "production";
    }),

  ADMIN_API_TOKEN: z.string().min(16).optional(),
  // F01: Role granted to ADMIN_API_TOKEN bearer requests. Defaults to "editor"
  // so the static long-lived key can no longer elevate to "system" accidentally.
  // Capped at "admin" — "system" is intentionally excluded so a single leaked
  // static token can never grant the unrestricted system-level RBAC tier
  // (used for internal worker-only operations). For genuine machine-to-machine
  // system calls, use a short-lived signed JWT minted by an internal service.
  ADMIN_API_TOKEN_ROLE: z
    .enum(["admin", "editor", "moderator", "user"])
    .default("editor"),
  // F11: Comma-separated list of IPv4/IPv6 addresses allowed to use
  // ADMIN_API_TOKEN. Empty = allow any IP (default; keeps existing behaviour).
  // Example: "203.0.113.10,10.0.0.0/8" — use exact IPs only (no CIDR in this
  // implementation; CIDR blocks require the `ip-range-check` package).
  ADMIN_API_TOKEN_IP_ALLOWLIST: z.string().optional(),

  CORS_ORIGINS: z.string().default("*"),
  // Optional comma-separated list of additional CORS origins merged with
  // CORS_ORIGINS at startup. Intended for hardcoded Render/preview-platform
  // URLs (e.g. https://*.onrender.com) that are known at deploy time but do
  // not need to live in the operator-managed `temple-tv-domains` group.
  // Supports the same three formats as CORS_ORIGINS (exact, wildcard, regex).
  CORS_ORIGINS_EXTRA: z.string().optional(),

  REDIS_URL: z.string().optional(),

  BROADCAST_PRELOAD_LEAD_MS: z.coerce.number().int().nonnegative().default(120_000),

  RATE_LIMIT_DEFAULT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(20),

  // ── Auth brute-force guard ────────────────────────────────────────────────
  // Maximum failed login attempts from a single IP or against a single account
  // within AUTH_BF_WINDOW_MS before that key is locked for the same window.
  AUTH_BF_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  // Sliding-window duration in ms. Attempts older than this are forgotten, and
  // the lockout (once triggered) lasts for this duration.
  // Default: 15 minutes (900 000 ms).
  AUTH_BF_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  // Optional secret token accepted in the X-Bypass-Rate-Limit request header
  // to skip the brute-force check entirely. Intended for server-to-server
  // admin tooling and integration tests. Keep out of client-side code.
  AUTH_BF_BYPASS_TOKEN: z.string().optional(),

  // Maximum concurrent SSE connections allowed per source IP.
  // Generous default covers one TV + mobile + web + admin tab per household.
  // Tune down on memory-constrained containers (free-tier).
  MAX_SSE_PER_IP: z.coerce.number().int().positive().default(8),

  // Maximum concurrent WebSocket connections allowed per source IP.
  // Mirrors MAX_SSE_PER_IP — excess connections are closed with code 1008.
  // Set to 0 to disable the limit.
  MAX_WS_PER_IP: z.coerce.number().int().nonnegative().default(8),

  // F35: bcrypt work factor — raise to 13-14 on dedicated hardware;
  // lower to 10 in CI/test environments to keep hash tests fast.
  // NIST SP 800-132 recommends ≥ 10; default 12 is a conservative middle ground.
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(20).default(12),

  // F17: Two-tier RSS memory threshold.
  //
  // MEMORY_WARN_RSS_MB  — ops-alert SSE is emitted after SUSTAIN_SAMPLES (3)
  //   consecutive samples above this value so the admin console can surface a
  //   warning banner. Set low enough to get early notice without triggering
  //   restarts. Default 1024 MB suits a 2–4 GiB production host with headroom
  //   for concurrent HLS streams, upload assembly, FFmpeg transcoding, and the
  //   V8 heap. Override lower on memory-constrained hosts (see below).
  //
  // MEMORY_RESTART_RSS_MB — SIGTERM is sent after CRITICAL_SAMPLES_FOR_EXIT
  //   (10) consecutive samples above THIS value so the supervisor can restart
  //   cleanly. Must be ≥ MEMORY_WARN_RSS_MB. Default 1536 MB provides ample
  //   headroom for large uploads, concurrent HLS (8 MiB Buffer × concurrent
  //   streams), FFmpeg transcoding (up to 1 GiB per job), broadcast queue
  //   processing, and the V8 heap — without triggering unnecessary restarts
  //   under normal workloads. The warn/restart gap (512 MB) gives operators
  //   clear notice well before a restart is triggered.
  //
  // Production config reference (override via env vars):
  //   2 GiB host:  MEMORY_WARN_RSS_MB=1024  MEMORY_RESTART_RSS_MB=1536
  //   4 GiB host:  MEMORY_WARN_RSS_MB=2048  MEMORY_RESTART_RSS_MB=3072
  //   8 GiB host:  MEMORY_WARN_RSS_MB=4096  MEMORY_RESTART_RSS_MB=6144
  //
  // Constrained host overrides (free tier / shared instances):
  //   512 MiB:     MEMORY_WARN_RSS_MB=380   MEMORY_RESTART_RSS_MB=430
  //                MEMORY_ABSOLUTE_MAX_RSS_MB=460
  //                (assumes DB_POOL_MAX=5, HLS_SEGMENT_CACHE_MB=8,
  //                 HLS_MAX_CONCURRENT=3, MALLOC_ARENA_MAX=2
  //                 — baseline ~373 MiB, peak ~352 MiB on 3 HLS streams)
  //   1 GiB:       MEMORY_WARN_RSS_MB=700   MEMORY_RESTART_RSS_MB=900
  //
  // RSS formula for sizing: baseline_mb + (24 × HLS_MAX_CONCURRENT) + transcode_peak_mb
  //   baseline ≈ 310–390 MB (V8 heap + pg pool @DB_POOL_MAX + HLS segment cache
  //                          + glibc arenas + pino + shared libs)
  //   HLS      ≈ 24 MB per concurrent stream (16 MiB pg BYTEA hex + 8 MiB Buffer)
  //   transcode ≈ 200–800 MB per active FFmpeg job (depends on resolution/codec)
  MEMORY_WARN_RSS_MB: z.coerce.number().int().positive().default(1024),
  MEMORY_RESTART_RSS_MB: z.coerce.number().int().positive().default(1536),
  // Hard RSS ceiling — SIGTERM fires immediately (no consecutive-count wait)
  // when RSS reaches this value. 0 = disabled (default). On the 512 MiB Render
  // free tier set to 460 so the process exits before the OOM killer fires.
  MEMORY_ABSOLUTE_MAX_RSS_MB: z.coerce.number().int().nonnegative().default(0),

  // pg connection pool maximum. Each replica holds at most this many live
  // connections to Postgres/Neon. Raised from 25 → 40 after pool saturation
  // alerts (25/25 active + 11 waiting) revealed the fleet has grown past the
  // original sizing.
  //
  // Theoretical peak concurrent demand:
  //   HLS streaming       up to 10  (1 connection per active 8-MiB chunk query)
  //   Transcoder          up to 3   (2 concurrent jobs + 1 dispatcher poll)
  //   Background workers  up to 16  (14 supervised + YouTube sync + scheduled-
  //                                   notifications dispatcher; each holds 1
  //                                   connection during its brief DB sweep)
  //   HTTP / SSE / WS     up to 5   (admin API calls, SSE reconnect replays)
  //   Orchestrator checkpoint  1    (5 s interval, pinned connect → release)
  //   Total worst-case    ≈ 35–40
  //
  // Each connection costs ~5–10 MB RSS on pg side; 40 ≈ 200–400 MB.
  // Replit's managed PostgreSQL default max_connections is 100, so 40 is safe.
  // On memory-constrained hosts lower DB_POOL_MAX proportionally.
  DB_POOL_MAX: z.coerce.number().int().positive().default(40),

  // How long (ms) a pool connection may sit idle before it is evicted.
  // Default 30 s keeps Replit's managed PostgreSQL happy — connections that
  // have been idle longer are closed cleanly rather than being hard-killed by
  // the server's own idle-connection reaper (which would produce ECONNRESET).
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // How long (ms) the pool waits when trying to acquire a new connection from
  // the PostgreSQL server before giving up with a connection-timeout error.
  // 10 s is generous for a co-located Replit DB; lower to 5 s on low-latency
  // links, raise to 15–20 s if the DB host lives in a remote region.
  DB_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // Maximum wall-clock time (ms) a single SQL statement may run before
  // PostgreSQL cancels it. Protects the pool from runaway full-table-scans,
  // unindexed joins, and stalled transactions that would otherwise hold a
  // connection indefinitely and exhaust the pool under concurrent load.
  // 0 = disabled (not recommended in production).
  // Tightened from 30 s → 20 s: reduces the maximum time a stuck query
  // blocks a pool slot, helping the pool recover faster under saturation.
  // 20 s is still well above the 99th-percentile of expected queries
  // (FTS, large metadata joins, BYTEA streaming) while catching genuine
  // runaway cases faster.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(20_000),

  SENTRY_DSN: z.string().optional(),

  // ── Viewer Tracking ──────────────────────────────────────────────────────
  // TTL (seconds) for a viewer session heartbeat key in Redis.
  // Must be > heartbeat interval (default 10 s) with a safety buffer.
  // 25 s = 2 missed heartbeats before a session is considered gone.
  VIEWER_TRACKING_SESSION_TTL_S: z.coerce.number().int().positive().default(25),

  // Process role selector. Lets the same image boot as either the API
  // server, a background worker, or both in a single process.
  //   api    → Fastify HTTP server only (no in-process dispatchers)
  //   worker → background dispatchers only (no HTTP listener)
  //   all    → both, useful in dev and small single-instance deploys
  RUN_MODE: z.enum(["api", "worker", "all"]).default("all"),

  // Scheduled-notification dispatcher cadence. Only consulted when
  // RUN_MODE is `worker` or `all`. The dispatcher polls
  // scheduled_notifications for `status='pending' AND scheduled_at<=now()`
  // rows and marks them sent. Default 30s gives sub-minute trigger
  // accuracy without thrashing the DB.
  SCHEDULED_NOTIF_POLL_MS: z.coerce.number().int().positive().default(30_000),
  SCHEDULED_NOTIF_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Transcoder dispatcher cadence. Polls `transcoding_jobs` for
  // status='queued' rows and runs ffmpeg one job at a time per replica.
  // Default 10s keeps newly-uploaded videos moving through the pipeline
  // without thrashing the DB. Set TRANSCODER_DISABLE=1 to suppress the
  // worker entirely (e.g. on read-only replicas).
  TRANSCODER_POLL_MS: z.coerce.number().int().positive().default(5_000),
  // Max FFmpeg thread count per encode job. Keeping this below the total
  // vCPU count leaves headroom for the Fastify event loop and DB pool during
  // active transcoding. Default 4 is a good balance on 2–8 core Replit/Render
  // instances. Set to 0 for unlimited (claims all cores — not recommended on
  // shared hosting). Override per-deployment: TRANSCODER_THREADS=8.
  TRANSCODER_THREADS: z.coerce.number().int().min(0).max(64).default(4),
  // Max number of simultaneous faststart (moov-atom relocation) FFmpeg jobs.
  // Each job downloads the source file to disk and spawns an ffmpeg process,
  // consuming 80–150 MiB of additional RSS.  Default 2 caps the spike at
  // ~300 MiB; excess jobs wait in a queue instead of being dropped.
  // Raise cautiously: 4 concurrent jobs ≈ 600 MiB additional RSS.
  FASTSTART_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(2),
  TRANSCODER_DISABLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  // Kill-switch for the Library → Broadcast Queue auto-enqueue pipeline.
  // When unset (default), every newly-uploaded / faststart-completed / YT-
  // synced video is automatically reflected in `broadcast_queue` so the
  // broadcast stays 24/7 with zero operator action. Set to 1 to disable the
  // entire pipeline (e.g. during a content audit window) without removing
  // the call sites. The orchestrator's empty-queue self-heal also respects
  // this flag — when disabled, an empty queue stays Off Air until an
  // operator adds content manually.
  BROADCAST_AUTO_ENQUEUE_DISABLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  // Hard cap on the number of active queue items loaded into the orchestrator's
  // in-memory cycle on each reload (every 30 s).  `loadActive()` applies this
  // as a SQL LIMIT so the heap never grows with an unusually large queue.
  // Items beyond the limit retain their sort order priority — they will air
  // once earlier items are removed or the cap is raised.
  // Default 2 000 items × ~1 800 s average ≈ 41 days of unique content —
  // sufficient for any foreseeable 24/7 broadcast schedule.
  BROADCAST_QUEUE_MAX_ITEMS: z.coerce.number().int().min(10).max(50_000).default(2000),

  // Broadcast Health Monitor — external orchestrator watchdog.
  //
  // An independent supervised worker that observes the orchestrator from outside
  // its own self-heal loop. If the broadcast sequence has not advanced while
  // items are queued and the orchestrator is started, it intervenes:
  //
  //   Tier 1 (STALE_MS): call orchestrator.reload() to nudge it.
  //   Tier 2 (RECOVERY_MS): if still stuck, call initiateFullRecovery()
  //     (stop → clear bad-URL cache → re-enable suspended items → restart)
  //     and emit an ops-alert SSE event + fire the broadcast webhook.
  //
  // Tighten for a stricter SLA (e.g. STALE_MS=120000 / RECOVERY_MS=300000 for 2/5-min).
  // How long without a sequence advance (outside the normal playback window)
  // before Tier-1 stale-reload fires.  Default 3 min (was 5 min) tightens the
  // SLA: a naturalItemEnd miss or a stuck tick loop is now recovered in ≤3 min
  // instead of ≤5 min.  Increase only if long-running content with very tight
  // loop windows produces false-positive reloads.
  BROADCAST_HEALTH_MONITOR_STALE_MS: z.coerce.number().int().positive().default(180_000),
  // How long stuck without recovery before escalating to Tier-2 full-recovery +
  // ops-alert SSE + admin email.  Default 7 min (was 10 min).
  BROADCAST_HEALTH_MONITOR_RECOVERY_MS: z.coerce.number().int().positive().default(420_000),

  // Media integrity scanner — periodic URL reachability probe.
  // Initial delay before the first scan. Default 90 s to allow for slow
  // production restarts and prod-sync mirror lag so transient 502/503 responses
  // during the restart window don't generate false-positive "unreachable (first
  // detection)" warnings. The broadcast-health-monitor also uses 90 s so both
  // monitors reach steady-state at the same time.
  MEDIA_SCANNER_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(90_000),

  // Content Rotation Worker — automatic broadcast queue shuffle.
  //
  // Periodically shuffles the sort_order of all active broadcast queue items
  // so 24/7 broadcasts present content in a fresh order rather than cycling
  // the same sequence forever. After each shuffle the orchestrator reloads and
  // applies the new order starting at the next item boundary (the currently-
  // airing item is never interrupted).
  //
  // BROADCAST_ROTATION_STRATEGY:
  //   shuffle (default) — Fisher-Yates shuffle of all active item sort_orders
  //   fifo              — no-op; preserves existing operator-set order
  //
  // Set BROADCAST_ROTATION_STRATEGY=fifo when a strict broadcast schedule is
  // required (e.g. a pre-planned programme grid), or set a longer interval
  // (e.g. 86400000 = 24 h) for daily variety instead of 30-minute cycles.
  BROADCAST_ROTATION_STRATEGY: z.enum(["shuffle", "fifo"]).default("shuffle"),
  BROADCAST_ROTATION_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000),
  // Initial delay before the FIRST content rotation after server startup.
  // Defaults to 3 minutes so the queue gets shuffled quickly after a restart
  // without waiting the full 30-minute rotation interval.  Set to 0 to rotate
  // immediately at boot, or equal to BROADCAST_ROTATION_INTERVAL_MS to
  // preserve the original behaviour (first rotation after one full interval).
  BROADCAST_ROTATION_INITIAL_DELAY_MS: z.coerce.number().int().nonnegative().default(3 * 60_000),

  // DB Pool Health Monitor — pg connection pool utilization alerting.
  //
  // Fraction (0–1) of DB_POOL_MAX active connections that triggers a
  // sustained "ops-alert" warning SSE event. At 0.8 the alert fires when
  // 16+ of the 20 default pool slots are occupied.
  // A second "critical" alert fires immediately (no sustain buffer) when
  // the pool has waiting connections — callers are already stalling.
  DB_POOL_WARN_UTILIZATION: z.coerce.number().min(0.1).max(1.0).default(0.8),

  // Dead-air external stream fallback.
  //
  // When the broadcast has been continuously off-air (empty queue OR all queue
  // sources blocked) for BROADCAST_DEADAIR_FALLBACK_AFTER_MS milliseconds the
  // orchestrator automatically applies this HLS URL as an emergency override so
  // viewers see content rather than a blank screen.
  //
  // The override is cleared automatically when local queue items recover.
  // Set to a reliable CDN-hosted HLS stream (e.g. a recorded service loop).
  // Leave unset (default) to keep the existing off-air behaviour unchanged.
  BROADCAST_DEADAIR_FALLBACK_URL: z.string().url().optional(),
  // How long (ms) to wait in dead-air before applying the fallback override.
  // Default 5 minutes. Set lower for tighter SLA; set higher to give the
  // self-heal mechanisms more time to recover without triggering the fallback.
  BROADCAST_DEADAIR_FALLBACK_AFTER_MS: z.coerce.number().int().positive().default(300_000),

  // Broadcast health webhook.
  //
  // When BROADCAST_WEBHOOK_URL is set, the broadcast engine POSTs a signed JSON
  // payload to that URL on key health events:
  //
  //   dead_air        — dead-air escalation fired (engine sees 0 items airing)
  //   item_deactivated — queue-integrity-validator auto-deactivated one or more items
  //   recovery        — dead-air escalation dispatched a successful recovery reload
  //   test            — operator-triggered test from POST /api/broadcast-v2/webhook/test
  //
  // Useful for Slack/PagerDuty integrations, external monitoring, or any webhook
  // receiver the operator controls. Leave unset to disable entirely.
  BROADCAST_WEBHOOK_URL: z.string().url().optional(),
  // HMAC-SHA256 secret for signing webhook payloads.  When set, each request
  // includes an `X-Temple-TV-Signature: sha256=<hex>` header computed from the
  // raw JSON body.  Verify on your receiver:
  //   expectedSig = "sha256=" + HMAC_SHA256(secret, rawBody)
  //   timingSafeEqual(expectedSig, request.headers["x-temple-tv-signature"])
  BROADCAST_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Per-attempt timeout for webhook delivery (ms).  Default 5 000.
  BROADCAST_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // Maximum delivery attempts per event with exponential backoff (1 s / 2 s / 4 s…).
  // Default 3.  Set to 1 to disable retries.
  BROADCAST_WEBHOOK_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // Auto-retry for recoverable failed transcoding jobs.
  //
  // When enabled (default true), the dispatcher periodically re-arms failed
  // transcoding jobs whose errorCode is NOT CORRUPT_SOURCE or SOURCE_MISSING
  // (i.e. transient failures such as DISK_FULL or job timeout). This ensures
  // temporary infrastructure issues do not leave content permanently failed
  // without operator action.
  //
  // Set TRANSCODER_AUTO_RETRY_FAILED=0 to disable (full manual control).
  TRANSCODER_AUTO_RETRY_FAILED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(true),
  // Interval between auto-retry sweeps in ms. Default 30 min (1 800 000).
  // Each sweep re-arms at most one wave of failed-but-recoverable jobs and
  // nudges the dispatcher to pick them up within the next poll tick.
  TRANSCODER_AUTO_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000),


  // F31: Where ffmpeg writes its HLS segments and thumbnails during
  // transcoding. Each job creates a sub-directory named after the jobId;
  // the directory is deleted when the job finishes (success or failure).
  // Defaults to `<os.tmpdir()>/transcoder`. Override in production when
  // the OS tmp partition is too small (e.g. Render's 512 MB container).
  TRANSCODER_SCRATCH_DIR: z.string().optional(),
  // ffmpeg encoding preset (speed vs compression trade-off). Default "fast"
  // balances quality and CPU time; use "medium" for best quality or "veryfast"
  // to minimise encode time on constrained machines.
  TRANSCODER_PRESET: z.string().default("fast"),
  // ffmpeg Constant Rate Factor. Lower = higher quality / larger file.
  // CRF 21 produces visibly sharper output vs. the old default of 23
  // at the cost of ~15-20% larger files — worthwhile for broadcast-quality
  // sermon content where face/text sharpness is critical.
  TRANSCODER_CRF: z.coerce.number().int().min(0).max(51).default(21),
  // When set to "1" the transcoder scratch dir is kept after job completion
  // for post-mortem inspection.  Defaults to false (scratch dir deleted).
  TRANSCODER_KEEP_SCRATCH: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  // Maximum wall-clock time (ms) allowed for a single FFmpeg encoding job.
  // If the process is still running after this deadline it receives SIGKILL so
  // the dispatcher can move on to the next queued job. Default 2 hours — long
  // enough for a 2-hour 1080p sermon to encode on modest hardware without
  // ever blocking the queue indefinitely on a corrupt or malformed source file.
  TRANSCODER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(2 * 60 * 60_000),
  // Enterprise distributed-lease settings.
  //
  // TRANSCODER_MAX_CONCURRENT_JOBS — how many jobs run concurrently per process.
  // Default 2: doubles throughput on multi-core hosts without exceeding the
  // HLS_MAX_CONCURRENT memory budget (each additional job adds ~24 MiB RSS).
  // Hard cap 4 enforced in code; set 1 to restore the old single-job behaviour.
  TRANSCODER_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(4).default(2),
  // How long (ms) a job's lease is valid before another worker may reclaim it.
  // Default 90 s: comfortably longer than the 30-s renewal interval so a
  // healthy worker never loses its lease between heartbeats.
  TRANSCODER_LEASE_TTL_MS: z.coerce.number().int().positive().default(90_000),
  // How often (ms) an active worker renews its lease. Must be << LEASE_TTL_MS.
  // Default 30 s: gives 3× margin before the TTL expires.
  TRANSCODER_LEASE_RENEW_MS: z.coerce.number().int().positive().default(30_000),
  // How often (ms) the lease-reclaim sweep runs to reset expired leases from
  // dead workers. Default 60 s: a dead worker's job is reclaimed in ≤ 90+60 s.
  TRANSCODER_LEASE_RECLAIM_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // Number of dead-letter queue entries above which an ops-alert SSE event fires.
  // Default 5: alert on 5+ permanently-failed jobs awaiting operator review.
  TRANSCODER_DLQ_ALERT_THRESHOLD: z.coerce.number().int().min(1).default(5),
  // Age threshold (ms) after which a job still in "queued" status triggers an
  // ops-alert. Long-waiting queued jobs indicate a systemic issue: circuit open,
  // TRANSCODER_DISABLE=1 accidentally set, or all workers dead. Default 2 h.
  TRANSCODER_QUEUE_STALE_ALERT_MS: z.coerce.number().int().positive().default(2 * 60 * 60_000),
  // ── DLQ autonomous auto-recovery ─────────────────────────────────────────
  // When true (default), the DLQ recovery worker automatically requeues
  // dead-lettered jobs on a 3-tier schedule (4h → 12h → 24h after failure).
  // Jobs with terminal error codes (CORRUPT_SOURCE, SOURCE_MISSING) are never
  // auto-requeued regardless of this setting.
  // Set to false to require manual operator intervention for all DLQ entries.
  DLQ_RECOVERY_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(true),
  // How often (ms) the DLQ recovery worker sweeps for eligible entries.
  // Default: 30 min. Recovery is opportunistic — actual requeue times depend on
  // when the sweep runs relative to the tier deadline, not this interval alone.
  DLQ_RECOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 60_000),
  // How often (ms) to run the periodic FFmpeg zombie scan after startup.
  // At startup the scan always runs once; this controls the recurring cadence.
  // Default 30 min. Set to 0 to disable the recurring scan (startup-only).
  TRANSCODER_ZOMBIE_SCAN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30 * 60_000),
  // Maximum wall-clock time (ms) for the background blob-assembly task that
  // runs after a chunked video upload is finalized. The iterative bytea-concat
  // loop is O(n²) in PostgreSQL I/O — a 2 GB file (250 chunks) can legitimately
  // take 40+ minutes on Replit's shared Neon DB, and large 4K/long-form files
  // (4 GB+, 500+ chunks) can legitimately take 90+ minutes on slow storage.
  // Default 4 hours (240 min) provides ample headroom for the largest expected
  // files without falsely marking them ASSEMBLY_FAILED. Operators who need a
  // shorter timeout can set ASSEMBLY_WATCHDOG_MS explicitly.
  // When the watchdog fires the video is marked transcodingStatus='failed' /
  // transcodingErrorCode='ASSEMBLY_FAILED' and the session resets to 'uploading'
  // so the operator can retry finalization from the upload queue panel.
  ASSEMBLY_WATCHDOG_MS: z.coerce.number().int().positive().default(240 * 60_000),
  // ── SMTP / email ────────────────────────────────────────────────────────
  // Non-sensitive connection params (set as plain env vars).
  // SMTP_PASS must be provided as a secret — it is never logged.
  // When SMTP_HOST is absent the mailer silently no-ops (dev convenience).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_NAME: z.string().default("Temple TV | JCTM"),
  // false = use STARTTLS (port 587); true = implicit TLS (port 465).
  SMTP_SECURE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .default(false),

  // Base URL used to build clickable links in outbound emails.
  // Must be set in production (e.g. https://templetv.org.ng).
  // Default is empty so the CORS fallback in app.ts does not accidentally
  // permit http://localhost:5000 when running in production without this set.
  APP_BASE_URL: z.string().default(""),

  // ── Web Push / VAPID ─────────────────────────────────────────────────────
  // Required for browser (service worker) push notification delivery.
  // Generate a keypair with: npx web-push generate-vapid-keys
  // Set both as Replit secrets. VAPID_MAILTO should be a mailto: URI
  // or an https: URL that browsers can contact for abuse reports.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_MAILTO: z.string().default("mailto:admin@templetv.org.ng"),

  // ── Expo Push Notifications ───────────────────────────────────────────────
  // Optional Expo access token for push delivery via FCM v1 / APNs.
  // When absent the open Expo Push API is used (rate-limited to ~1000/s).
  EXPO_ACCESS_TOKEN: z.string().optional(),

  // ── A2: CDN & Delivery Optimization ─────────────────────────────────────
  // Optional base URL for a CDN edge layer in front of the S3 bucket.
  // When set, HLS manifest responses rewrite segment URLs to point at the CDN
  // instead of the API proxy path, reducing origin load and improving latency.
  // Example: https://cdn.templetv.org.ng
  CDN_BASE_URL: z.string().optional(),

  // ── PostgreSQL BYTEA Object Storage ──────────────────────────────────────
  // All video assets (source uploads, HLS segments, playlists, thumbnails) are
  // stored directly in PostgreSQL as BYTEA blobs (storage_blobs table).
  // No S3/MinIO dependency. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are
  // retained here for optional CDN or external integrations only.

  // ── A3: Security — HLS streaming token ───────────────────────────────────
  // When REQUIRE_HLS_TOKEN=true, the /api/hls/* proxy validates a short-lived
  // HMAC token (`?t=TOKEN`) before streaming segments. Opt-in so existing
  // deployments are not broken. HLS_TOKEN_SECRET must be set when enabled.
  REQUIRE_HLS_TOKEN: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  HLS_TOKEN_SECRET: z.string().optional(),
  // Pre-shared secret for internal server-to-server HLS requests.
  // When set, any HTTP request carrying `X-Internal-Token: <secret>` bypasses
  // REQUIRE_HLS_TOKEN validation in the /api/hls/* proxy — identical in effect
  // to coming from 127.0.0.1, but works across multi-node deployments and
  // reverse-proxy topologies where the source IP is not loopback.
  // Generate a strong random value: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Leave unset to rely solely on loopback-IP detection (single-node setups).
  INTERNAL_HLS_BYPASS_SECRET: z.string().min(16).optional(),
  // ── YouTube PubSubHubbub webhook security ─────────────────────────────────
  // Optional shared secret for YouTube WebSub. When set, the hub will sign
  // each POST with X-Hub-Signature: sha1=<hmac> and the server will verify
  // it before triggering a sync. Generate a strong random value:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  YOUTUBE_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Token TTL in seconds. Default 1 hour.
  HLS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // ── A5: Scalability — HLS proxy concurrency ───────────────────────────────
  // Maximum simultaneous in-flight requests to the /api/hls/* proxy.
  // Requests beyond this limit receive 503 with Retry-After: 5.
  //
  // Memory budget (S3 backend — recommended):
  //   Per concurrent request (segment Buffer, ~4–8 MiB, released after send)
  //   Node.js + API baseline RSS: ~300 MiB
  //   At HLS_MAX_CONCURRENT=10: ~300 + 80 = ~380 MiB peak RSS ✓
  //   At HLS_MAX_CONCURRENT=20: ~300 + 160 = ~460 MiB peak RSS ✓
  //
  // Memory budget (PostgreSQL BYTEA backend — legacy fallback):
  //   The pg driver decodes BYTEA via hex encoding: 8 MiB segment → 16 MiB
  //   V8 string (transient) + 8 MiB external Buffer (held until client ACKs).
  //   At HLS_MAX_CONCURRENT=10: ~300 + 160 + 80 = ~540 MiB peak RSS ✓
  //
  // video-serve.routes.ts emits a startup info/warn log with the budget.
  HLS_MAX_CONCURRENT: z.coerce.number().int().positive().default(10),

  // In-process LRU cache for immutable HLS .ts segments (integer megabytes).
  // Segments are content-addressed (never mutated after write) so caching them
  // is always safe. A cache HIT bypasses both DB queries + a pool connection,
  // cutting per-segment latency from ~30–60 ms (DB BYTEA fetch) to <1 ms.
  // Each 2-second segment is ~250 KB–2 MB; 32 MB holds 16–128 warm segments
  // which covers a typical broadcast window while halving the permanent
  // Buffer allocation vs the previous 64 MB default. Set to 0 to disable.
  // Max 512 MB (capped for OOM safety on constrained hosts).
  HLS_SEGMENT_CACHE_MB: z.coerce.number().int().min(0).max(512).default(32),

  // How long (ms) to wait after SIGTERM before starting to close services.
  // During this window /healthz returns HTTP 503 so the upstream load balancer
  // observes the failure and stops routing new requests — the core mechanism
  // for zero-downtime rolling restarts. Set to ≥ 2× the LB health-check
  // interval. 0 = begin closing immediately (original behaviour; fine for dev).
  // Recommended production value: 5000–10000 ms.
  SHUTDOWN_PRECLOSE_DELAY_MS: z.coerce.number().int().nonnegative().default(0),

  // F20: how long (ms) the shutdown handler waits for open SSE connections
  // to drain naturally before forcing app.close(). Gives long-polling clients
  // a chance to receive their in-flight frame and reconnect cleanly.
  // 0 = skip drain and close immediately.
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().default(5_000),

  // Absolute wall-clock budget (ms) from the moment SIGTERM is received until
  // the process force-exits if the graceful drain has not completed. Must be
  // set BELOW the platform's SIGKILL grace period so the server exits cleanly
  // rather than being hard-killed.
  //
  // Timeline: SIGTERM → SHUTDOWN_PRECLOSE_DELAY_MS → app.close() → drain →
  //           process.exit(0). Force-exit fires if this whole sequence exceeds
  //           SHUTDOWN_FORCE_EXIT_BUDGET_MS.
  //
  //   Render free tier (30 s SIGKILL window)  → set to 28 000 (2 s headroom)
  //   Render paid / k8s (60 s SIGKILL window) → set to 55 000
  //   Replit dev (no SIGKILL)                 → 28 000 default is fine
  //
  // Effective drain window = SHUTDOWN_FORCE_EXIT_BUDGET_MS − SHUTDOWN_PRECLOSE_DELAY_MS.
  // Example: 28 000 − 10 000 preclose = 18 s to drain active SSE/WS/uploads.
  //
  // Default raised from 25 000 → 28 000: production restarts on Render free-tier
  // (30 s SIGKILL window) were force-exiting at exactly 25 s and aborting in-flight
  // chunk uploads. 28 000 gives 2 s headroom under Render's SIGKILL, extending the
  // effective drain window from 15 s → 18 s.
  SHUTDOWN_FORCE_EXIT_BUDGET_MS: z.coerce.number().int().positive().default(28_000),

  // ── Application version ───────────────────────────────────────────────────
  // Injected at build time (e.g. CI sets APP_VERSION=<git tag>).
  // Falls back to npm_package_version (set by `node` when run via npm/pnpm).
  APP_VERSION: z.string().optional(),

  // ── YouTube channel sync ──────────────────────────────────────────────────
  // YOUTUBE_API_KEY: YouTube Data API v3 key for full channel sync.
  // When absent the sync falls back to RSS (last ~15 videos only, no durations).
  YOUTUBE_API_KEY: z.string().optional(),
  // YouTube channel ID to monitor for live streams and sync videos.
  // Defaults to the JCTM temple channel if not set.
  YOUTUBE_CHANNEL_ID: z.string().optional(),
  // Daily YouTube Data API v3 quota cap. Default matches Google's free tier.
  YOUTUBE_QUOTA_DAILY_LIMIT: z.coerce.number().int().positive().default(10_000),
  // How many days back to include videos when syncing the channel. Default
  // 1825 days (5 years) — covers the full broadcast library.
  YOUTUBE_CONTENT_WINDOW_DAYS: z.coerce.number().int().positive().default(1825),
  // How often (in minutes) the background YouTube sync dispatcher polls the
  // @TEMPLETVJCTM channel for new/updated videos. Default 15 minutes.
  YOUTUBE_SYNC_INTERVAL_MINS: z.coerce.number().int().positive().default(15),
  // Set to "1" or "true" to disable the YouTube sync dispatcher entirely
  // (useful on read-only replicas or when the API key is not provisioned).
  YOUTUBE_SYNC_DISABLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  // Set to "1" or "true" to disable the YouTube live auto-override bridge.
  // When disabled, the ytPoller still runs (for /api/youtube/live SSE/REST
  // and client-side soft switching), but the server-side broadcast-v2
  // orchestrator will not be driven into `override` mode automatically.
  // Manual Emergency Override from the admin panel continues to work.
  YOUTUBE_AUTO_OVERRIDE_DISABLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),

  // Set to "1" or "true" to disable the YouTube catalog shuffle fallback.
  //
  // The shuffle fallback activates when the broadcast queue has no locally
  // playable content for >60 s (after scanLibraryAndEnqueue returns 0) and
  // cycles through YouTube catalog videos (managed_videos with
  // videoSource='youtube') using a broadcast YouTube override so viewers always
  // see content. It auto-deactivates the moment a local queue item becomes
  // available.
  //
  // Disable when:
  //   • No YouTube catalog exists (YOUTUBE_SYNC_DISABLE=true + no manual imports)
  //   • The operator prefers dead air over showing uncontrolled catalog content
  //   • BROADCAST_DEADAIR_FALLBACK_URL is configured as the preferred backstop
  //
  // Default: enabled (false). A startup warning fires in production when this
  // AND BROADCAST_DEADAIR_FALLBACK_URL are both unset/disabled.
  YOUTUBE_SHUFFLE_FALLBACK_DISABLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),

  // ── Cross-environment broadcast queue sync ───────────────────────────────
  // When set, this server periodically pulls the broadcast queue from an
  // upstream environment (typically production) and upserts the items into
  // its own `broadcast_queue` table. Used in development so engineers can
  // see exactly what's airing in production without ever touching the prod
  // DB. Disabled by default — only the dev environment should set this.
  //
  // PROD_SYNC_API_URL: base URL of the upstream API (e.g.
  //   `https://api.templetv.org.ng`). The sync poller hits
  //   `${PROD_SYNC_API_URL}/api/broadcast/guide` (no auth required — the
  //   guide endpoint is public). Leave unset to disable sync.
  PROD_SYNC_API_URL: z.string().url().optional(),
  // The public base URL of THIS API server (e.g. https://api.templetv.org.ng).
  // Used to absolutize relative upload paths stored in `localVideoUrl`
  // (e.g. `/api/v1/uploads/…`) so they pass the broadcast allowlist and are
  // streamable by player clients. Must be an https:// URL in production.
  // Leave unset in dev — PROD_SYNC_API_URL already covers the dev→prod case.
  API_ORIGIN: z.string().url().optional(),
  // How often (ms) to poll the upstream guide. Default 30 s — fast enough
  // that a queue change in production appears in dev within ~30 s, slow
  // enough to be invisible to upstream rate limits.
  PROD_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  // Force-disable the sync even if PROD_SYNC_API_URL is set (escape hatch
  // for incidents — prevents dev from clobbering its own queue).
  PROD_SYNC_DISABLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),

  // ── Post-transcode source-blob cleanup ────────────────────────────────────
  // After successful HLS transcoding the original raw source blob is eligible
  // for deletion. A retention window prevents premature deletion in case the
  // HLS output needs to be validated before the source is gone.
  //
  // CLEANUP_RETENTION_HOURS: how many hours to wait after HLS completion
  //   before deleting the source. Default 1 h in dev, 24 h in prod.
  //   Set to 0 to delete immediately after validation passes (not recommended
  //   in production — always keep at least a short window).
  CLEANUP_RETENTION_HOURS: z.coerce.number().nonnegative().default(1),
  // CLEANUP_SWEEP_MS: how often (ms) the sweep worker polls for eligible
  //   source blobs to delete. Default 5 minutes.
  CLEANUP_SWEEP_MS: z.coerce.number().int().positive().default(5 * 60_000),
  // CLEANUP_DISABLE: set to "1" or "true" to disable the cleanup worker
  //   entirely (useful on read-only replicas or during incident investigations).
  CLEANUP_DISABLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  // CLEANUP_MAX_PER_SWEEP: maximum number of source blobs to delete in a
  //   single sweep run. Limits the DB/IO impact of a large backlog catch-up.
  CLEANUP_MAX_PER_SWEEP: z.coerce.number().int().positive().default(20),

  // ── Deployment platform metadata (read-only, injected by Render / Replit) ─
  // These are optional informational env vars set by hosting platforms.
  // They are never required — absence is silently tolerated.
  RENDER_GIT_COMMIT: z.string().optional(),
  RENDER_GIT_BRANCH: z.string().optional(),
  RENDER_SERVICE_NAME: z.string().optional(),
  RENDER_SERVICE_ID: z.string().optional(),
  RENDER_INSTANCE_ID: z.string().optional(),
  REPL_DEPLOYMENT: z.string().optional(),

  // ── Startup admin seed ───────────────────────────────────────────────────
  // When both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are set, the API will
  // automatically create an admin account at startup if one does not already
  // exist.
  //
  // SEED_ADMIN_FORCE=true — wipes all existing elevated accounts before
  // inserting the seed account. BLOCKED IN PRODUCTION: the main() startup
  // guard unconditionally ignores this flag when NODE_ENV=production, falling
  // back to the safe create-if-absent path instead. This prevents a mis-set
  // secret from wiping all admin accounts on every production restart.
  // Use the admin panel's account management page to reset production creds.
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_ADMIN_FORCE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),

  // ── Queue health guard ────────────────────────────────────────────────────
  // Minimum number of active broadcast queue items before the guard worker
  // auto-rebuilds from the library. Set to 0 to disable proactive rebuilding
  // (the orchestrator's own empty-queue self-heal still runs independently).
  QUEUE_MIN_ITEMS: z.coerce.number().int().nonnegative().default(5),

  // ── Storage health monitor ────────────────────────────────────────────────
  // Interval (ms) between object-storage write/head/delete probe cycles.
  // Default 60 s. Set to 0 to disable the monitor.
  STORAGE_HEALTH_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60_000),

  // ── Storage reconciliation worker ─────────────────────────────────────────
  // Interval (ms) between full storage→DB reconciliation passes.
  // Each pass checks every active broadcast queue item's referenced blobs
  // (HLS master.m3u8 + MP4 objectPath) against storage_blobs and runs a
  // 6-stage recovery waterfall for any missing or degraded blobs.
  // Default 600 000 ms (10 min). Set to 0 to disable.
  STORAGE_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().nonnegative().default(600_000),

  // ── Orphaned blob auto-remediation ────────────────────────────────────────
  // When true (default), orphaned storage_blobs rows (transcoded HLS + upload
  // blobs with no managed_videos reference) older than ORPHAN_BLOB_MIN_AGE_HOURS
  // are automatically deleted each reconciliation pass.
  // Set false to revert to detect-and-alert-only behaviour.
  ORPHAN_BLOB_AUTO_DELETE: z.coerce.boolean().default(true),

  // Minimum age in hours before an orphaned blob is eligible for auto-deletion.
  // Default 168 h (7 days) provides a safety buffer so blobs from recently-
  // deleted videos or in-progress uploads are never prematurely removed.
  // Must be a positive integer.
  ORPHAN_BLOB_MIN_AGE_HOURS: z.coerce.number().int().positive().default(168),

  // Maximum number of managed_videos rows checked per storage-reconciliation
  // library-wide pass (Phase 2 — non-queued items).  Keeps individual pass
  // duration bounded on large libraries.  Default 200.
  STORAGE_RECON_LIBRARY_BATCH: z.coerce.number().int().positive().default(200),

  // ── Storage reconciliation recovery policy ────────────────────────────────
  // Minimum number of consecutive reconciliation passes where a video's blobs
  // are confirmed missing before the video is permanently quarantined.
  // This prevents a single transient DB/storage inconsistency from causing a
  // false-positive SOURCE_MISSING quarantine.  Between passes the reconciliation
  // worker emits a warn-level ops-alert and records the gap without deactivating
  // the queue item.  The orchestrator's own bad-URL tracking handles temporary
  // playback failures during this window.
  // Set to 1 to quarantine immediately on first confirmed gap (legacy behaviour).
  // Default 3 (30 min with the default 10-min reconciliation interval).
  STORAGE_RECON_QUARANTINE_MIN_FAILURES: z.coerce.number().int().positive().default(3),

  // When true (default), never permanently quarantine a video whose queue item
  // is currently designated as the ON_AIR item in broadcast_runtime_state.
  // Instead the quarantine is deferred and an ops-alert is emitted so operators
  // can investigate without interrupting the live broadcast.
  // Set to false to disable this guard (not recommended in production).
  STORAGE_RECON_BROADCAST_SAFE: z.coerce.boolean().default(true),

  // When true (default), the blob presence check requires size_bytes > 0 in
  // addition to key existence.  This catches zero-byte blobs written by
  // interrupted putObject calls — rows that appear present in storage_blobs but
  // contain no actual data and will cause 404/empty responses on playback.
  // Set to false only for debugging (disables the size integrity gate).
  STORAGE_RECON_SIZE_CHECK: z.coerce.boolean().default(true),

  // When true (default), the reconciliation worker attempts to recover missing
  // blobs from surviving upload_sessions + upload_chunks rows before quarantining.
  // Set to false to disable this recovery path.
  STORAGE_RECON_SESSION_REPAIR: z.coerce.boolean().default(true),

  // ── Queue exhaustion monitor thresholds ───────────────────────────────────
  // Milliseconds of remaining queue content below which a WARN ops-alert fires.
  // Default: 2 hours.
  QUEUE_WARN_MS: z.coerce.number().int().positive().default(2 * 60 * 60 * 1000),
  // Milliseconds of remaining queue content below which a CRITICAL ops-alert fires.
  // Default: 15 minutes.
  QUEUE_CRIT_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),

  // ── Auto queue-refill ─────────────────────────────────────────────────────
  // Milliseconds of remaining queue content below which the auto-refill worker
  // activates inactive library videos. Default: 30 minutes.
  QUEUE_REFILL_TRIGGER_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  // Maximum number of videos added per auto-refill cycle. Default: 5.
  QUEUE_REFILL_BATCH: z.coerce.number().int().positive().default(5),
  // Set to any truthy string to disable auto-refill entirely.
  QUEUE_REFILL_DISABLE: z.string().optional(),

  // ── Disk-level broadcast state backup ────────────────────────────────────
  // Directory to write the tertiary disk-state backup JSON file.
  // Default: /tmp (always writable in Node.js containers).
  // The file is named broadcast-state-<channelId>.json.
  // When STORAGE_PATH is set, storage-paths.ts overrides this at runtime.
  BROADCAST_STATE_BACKUP_PATH: z.string().default("/tmp"),

  // ── Persistent storage root (Render Disk / any mounted volume) ────────────
  //
  // All media content (uploads, HLS segments, thumbnails) is stored in
  // PostgreSQL BYTEA blobs — it survives container restarts automatically.
  // This path is used for filesystem-resident data that BENEFITS from a
  // persistent mount:
  //
  //   $STORAGE_PATH/scratch      — FFmpeg transcoder workspace per job
  //                                (Render /tmp is often only 500 MB; large
  //                                 1080p encodes need up to 4× source size)
  //   $STORAGE_PATH/             — broadcast state + queue backup JSON files
  //   $STORAGE_PATH/uploads      — informational; created for future local use
  //   $STORAGE_PATH/hls          — informational; created for future local use
  //   $STORAGE_PATH/thumbnails   — informational; created for future local use
  //
  // Render Disk quick-start:
  //   1. Create a Render Disk mounted at /var/data (Dashboard → Disks).
  //   2. Set STORAGE_PATH=/var/data in your Render service Environment.
  //   3. All sub-paths derive automatically; no other changes needed.
  //
  // Individual overrides (highest priority):
  //   TRANSCODER_SCRATCH_DIR  — override only the FFmpeg workspace
  //   UPLOAD_DIR              — informational uploads path
  //   HLS_DIR                 — informational HLS path
  //   THUMBNAIL_DIR           — informational thumbnails path
  //   BROADCAST_STATE_BACKUP_PATH  — override only the state backup dir
  //   BROADCAST_QUEUE_BACKUP_DIR   — override only the queue backup dir
  STORAGE_PATH: z.string().optional(),

  // Informational paths — actual media is in PostgreSQL; these are created
  // on startup when STORAGE_PATH is set and available for future use.
  UPLOAD_DIR: z.string().optional(),
  HLS_DIR: z.string().optional(),
  THUMBNAIL_DIR: z.string().optional(),

  // ── Disk watchdog ──────────────────────────────────────────────────────────
  // Periodic disk-usage monitor for the scratch partition (storagePaths.scratch).
  //
  //   DISK_WATCHDOG_INTERVAL_MS — how often to sample statfs (default 60 s).
  //   SCRATCH_WARN_PERCENT      — log warn when scratch usage ≥ this % (default 70).
  //   SCRATCH_ALERT_PERCENT     — log error + fire ops-alert + emergency stale-dir
  //                               sweep when ≥ this % (default 85).
  //                               Also marks isDiskConstrained()=true so
  //                               transcoder/faststart pre-flight can abort.
  DISK_WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SCRATCH_WARN_PERCENT:  z.coerce.number().int().min(1).max(99).default(70),
  SCRATCH_ALERT_PERCENT: z.coerce.number().int().min(1).max(99).default(85),
});

export type AppEnv = z.infer<typeof Env>;

function loadEnv(): AppEnv {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    console.error(`[config] Environment validation failed:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: AppEnv = loadEnv();

export function isProd(): boolean {
  return env.NODE_ENV === "production";
}
