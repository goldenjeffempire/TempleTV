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
  // Injected automatically by Replit in dev environments. Used by sse-cors.ts
  // to allow the Replit preview origin in addition to localhost.
  REPLIT_DEV_DOMAIN: z.string().optional(),
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
  // F10: algorithm agility — HS256 (symmetric, default) or RS256 (asymmetric).
  // RS256 requires JWT_ACCESS_SECRET / JWT_REFRESH_SECRET to be PEM-encoded
  // RSA private keys; HS256 uses them as raw HMAC secrets.
  JWT_ALGORITHM: z.enum(["HS256", "RS256"]).default("HS256"),
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

  BROADCAST_PRELOAD_LEAD_MS: z.coerce.number().int().nonnegative().default(90_000),
  BROADCAST_FAILOVER_HLS_URL: z.string().optional(),

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

  // F17: RSS memory threshold (MB) above which a structured ops-alert SSE
  // event is emitted so the admin console can surface a warning banner.
  // Default 1 500 MB — comfortable headroom on Render's Starter (512 MB RAM)
  // but intentionally high so dev environments don't spam false alerts.
  MEMORY_WARN_RSS_MB: z.coerce.number().int().positive().default(1500),

  // pg connection pool maximum. Each replica holds at most this many live
  // connections to Postgres/Neon. 20 is safe for a 2 GiB / 1-vCPU container.
  // Raise if you move to a larger dyno or see connection-timeout spikes.
  // Tuned down to 10 for Replit's constrained environment.
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Maximum wall-clock time (ms) a single SQL statement may run before
  // PostgreSQL cancels it. Protects the pool from runaway full-table-scans,
  // unindexed joins, and stalled transactions that would otherwise hold a
  // connection indefinitely and exhaust the pool under concurrent load.
  // 0 = disabled (not recommended in production).
  // 30 000 ms (30 s) is well above the 99th-percentile of expected queries
  // (FTS, large metadata joins) while catching genuine runaway cases.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

  SENTRY_DSN: z.string().optional(),

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
  TRANSCODER_POLL_MS: z.coerce.number().int().positive().default(10_000),
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
  // F31: Where ffmpeg writes its HLS segments and thumbnails during
  // transcoding. Each job creates a sub-directory named after the jobId;
  // the directory is deleted when the job finishes (success or failure).
  // Defaults to `<os.tmpdir()>/transcoder`. Override in production when
  // the OS tmp partition is too small (e.g. Render's 512 MB container).
  TRANSCODER_SCRATCH_DIR: z.string().optional(),
  // Maximum wall-clock time (ms) allowed for a single FFmpeg encoding job.
  // If the process is still running after this deadline it receives SIGKILL so
  // the dispatcher can move on to the next queued job. Default 4 hours — long
  // enough for a 2-hour 1080p sermon to encode on modest hardware without
  // ever blocking the queue indefinitely on a corrupt or malformed source file.
  TRANSCODER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(4 * 60 * 60_000),

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
  // Must be set in production (e.g. https://temple.tv).
  APP_BASE_URL: z.string().default("http://localhost:5000"),

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

  // ── A3: Security — HLS streaming token ───────────────────────────────────
  // When REQUIRE_HLS_TOKEN=true, the /api/hls/* proxy validates a short-lived
  // HMAC token (`?t=TOKEN`) before streaming segments. Opt-in so existing
  // deployments are not broken. HLS_TOKEN_SECRET must be set when enabled.
  REQUIRE_HLS_TOKEN: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
  HLS_TOKEN_SECRET: z.string().optional(),
  // Token TTL in seconds. Default 1 hour.
  HLS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // ── A5: Scalability — HLS proxy concurrency ───────────────────────────────
  // Maximum simultaneous in-flight requests to the /api/hls/* proxy.
  // Prevents a single burst of clients from overwhelming the S3 connection
  // pool. Requests beyond this limit receive 503 with Retry-After: 5.
  // Default 200 is generous for a single replica; tune down for free-tier.
  HLS_MAX_CONCURRENT: z.coerce.number().int().positive().default(200),

  // F20: how long (ms) the shutdown handler waits for open SSE connections
  // to drain naturally before forcing app.close(). Gives long-polling clients
  // a chance to receive their in-flight frame and reconnect cleanly.
  // 0 = skip drain and close immediately.
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().default(5_000),

  // ── YouTube channel sync ──────────────────────────────────────────────────
  // YOUTUBE_API_KEY: YouTube Data API v3 key for full channel sync.
  // When absent the sync falls back to RSS (last ~15 videos only, no durations).
  YOUTUBE_API_KEY: z.string().optional(),
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

  // ── Startup admin seed ───────────────────────────────────────────────────
  // When both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are set, the API will
  // automatically create an admin account at startup if one does not already
  // exist. Set SEED_ADMIN_FORCE=true to wipe all existing elevated accounts
  // first — use this when resetting production credentials after deployment.
  // The seed is a no-op when the target account already exists (unless FORCE).
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_ADMIN_FORCE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "1")
    .default(false),
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
