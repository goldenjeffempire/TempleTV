import express, { type Express } from "express";
import * as Sentry from "@sentry/node";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import legalRouter from "./routes/legal";
import sitemapRouter from "./routes/sitemap";
import { logger } from "./lib/logger";
import { s3FallbackMiddleware } from "./lib/staticWithS3Fallback";
import { s3RedirectFirstForLargeMedia } from "./lib/s3RedirectFirst";
import { uploadRangeGuard } from "./lib/uploadRangeGuard";
import { adminAccessControl, rateLimit, requestId, securityHeaders } from "./middlewares/security";
import { requestMetrics } from "./middlewares/observability";
import { requestTimeout } from "./middlewares/requestTimeout";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.set("trust proxy", 1);
// Skip compression for SSE (text/event-stream) — compressed chunked encoding
// causes the data to be buffered until the compressor's internal buffer fills,
// which prevents event frames from reaching clients in real time.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (res.getHeader("Content-Type") === "text/event-stream") return false;
    return compression.filter(req, res);
  },
}));
app.use(requestId);
app.use(securityHeaders);
app.use(rateLimit);
app.use(requestMetrics);
// Per-request wall-clock timeout safety net. Skips SSE, uploads, HLS and
// anything that legitimately streams long. Default 30s — overridable via
// REQUEST_TIMEOUT_MS for slow batch admin endpoints if needed.
app.use(requestTimeout());
// Path patterns whose responses are long-lived streams (SSE event channels).
// Clients on these endpoints disconnect routinely — every navigation away,
// tab close, mobile backgrounding or transient network blip terminates the
// stream and pino-http surfaces it as `msg: "request aborted"` at INFO. In
// production that single class of log line dominates the access log, drowns
// out real signal during triage, and inflates log-storage cost without any
// operational value. We demote those specific entries to DEBUG (silent at
// the default INFO level) while still keeping every non-streaming request
// fully logged at INFO and every server error at ERROR.
const SSE_PATH_PATTERN = /\/events$/;
function isSseResponse(req: { url?: string }, res: { getHeader: (k: string) => unknown }): boolean {
  const ct = res.getHeader("Content-Type");
  if (typeof ct === "string" && ct.includes("text/event-stream")) return true;
  const path = (req.url ?? "/").split("?")[0];
  return SSE_PATH_PATTERN.test(path);
}

// Lifecycle / readiness probe path — `/healthz` is mounted under the API
// router as `/api/healthz`. The endpoint legitimately returns 503 in three
// distinct cases (`starting` during boot warm-up, `draining` after SIGTERM,
// `db_down` if the DB is unreachable), and the LB depends on those 503s to
// route traffic correctly. The first two are NORMAL, expected, frequent
// (every deploy a new instance returns dozens of 503s before markReady()
// flips the gate; every shutdown returns 503s during the drain window).
// Treating them as ERROR-level pollutes Sentry with one false alert per
// deploy per instance and trains operators to ignore real failures.
//
// We demote ALL /healthz 503s to INFO at the request-log layer; the genuine
// `db_down` case is loudly surfaced by a dedicated `logger.warn` inside
// `routes/health.ts` itself, so the real signal stays loud while the
// lifecycle-routing chatter stays quiet.
const HEALTHZ_PATH_PATTERN = /^(?:\/api)?\/healthz(?:\/|$)/;
function isHealthzRequest(req: { url?: string }): boolean {
  const path = (req.url ?? "/").split("?")[0];
  return HEALTHZ_PATH_PATTERN.test(path);
}

// Large-media S3 redirect path — `/api/uploads/<uuid>.<ext>` returning 302.
// HTML5 <video> elements do not cache 302 redirects, so EVERY HTTP Range
// request a viewer's browser issues during playback round-trips this endpoint
// (observed in production at 2026-04-27T12:08–12:09Z: same .mp4 URL hit ~20
// times in 60s by a single client, all served in 2-5ms from the in-memory
// signedUrlCache in `lib/s3RedirectFirst.ts`, no S3 round-trip, no presign).
// The redirect is doing its job — but logging every Range probe at INFO
// drowns the access log under a single asset and inflates log-storage cost
// with zero operational value. We demote ONLY successful 302/304 redirects
// for media extensions; any 4xx/5xx (auth failure, presign error, missing
// file) still logs at its normal level so real failures stay loud.
const UPLOAD_REDIRECT_PATH_PATTERN =
  /^\/api\/uploads\/[^/]+\.(?:mp4|m4v|mov|webm|mkv|m4a|mp3)$/i;
function isUploadMediaRedirect(
  req: { url?: string },
  res: { statusCode: number },
): boolean {
  if (res.statusCode !== 302 && res.statusCode !== 304) return false;
  const path = (req.url ?? "/").split("?")[0];
  return UPLOAD_REDIRECT_PATH_PATTERN.test(path);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        // Strip the query string entirely from the access log. We rely on
        // structured fields elsewhere for query parameters that matter, and
        // this guarantees no credential ever leaks through `?adminToken=…`,
        // `?token=…`, signed-URL signatures, or future query secrets.
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
    customLogLevel(req, res, err) {
      // /healthz 503s are intentional lifecycle/readiness signaling, not a
      // process error — see the HEALTHZ_PATH_PATTERN comment block above for
      // the full rationale. Demote BEFORE the >=500 check so they never trip
      // the error branch and never fan out to Sentry.
      if (res.statusCode === 503 && isHealthzRequest(req)) return "info";
      // Surface real failures loudly.
      if (err || res.statusCode >= 500) return "error";
      // Silently drop "request aborted" log entries for SSE streams — the
      // abort IS the normal end-of-life for these connections and is not a
      // signal worth carrying at INFO. Non-aborted SSE completions (rare;
      // server-initiated close on shutdown) still log normally.
      const aborted = (req as unknown as { aborted?: boolean }).aborted === true;
      if (aborted && isSseResponse(req, res)) return "debug";
      // Successful LB liveness probe and large-media S3-redirect chatter —
      // see UPLOAD_REDIRECT_PATH_PATTERN comment block above for the upload
      // case rationale, and HEALTHZ_PATH_PATTERN for the /healthz one. Both
      // are pure infrastructure noise at INFO; failures (5xx for healthz,
      // any non-302/304 for uploads) still surface at their normal levels.
      if (res.statusCode === 200 && isHealthzRequest(req)) return "debug";
      if (isUploadMediaRedirect(req, res)) return "debug";
      // Preserve current production behaviour for everything else: 4xx and
      // 2xx/3xx all log at INFO, matching the existing access-log shape that
      // downstream observability pipelines and dashboards already key off.
      return "info";
    },
  }),
);
const PRODUCTION_ALLOWED_ORIGINS = [
  "https://templetv.org.ng",
  "https://www.templetv.org.ng",
  "https://temple-tv-web.onrender.com",
  "https://temple-tv-admin.onrender.com",
  "https://temple-tv-tv.onrender.com",
  "https://admin.templetv.org.ng",
  "https://tv.templetv.org.ng",
  "https://api.templetv.org.ng",
];

app.use(cors({
  origin(origin, callback) {
    const configured = process.env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    const allowList = [...PRODUCTION_ALLOWED_ORIGINS, ...configured];
    const isProd = process.env.NODE_ENV === "production";

    // Always allow same-origin / non-browser callers (no Origin header) and explicitly listed origins
    if (!origin || allowList.includes(origin)) {
      callback(null, true);
      return;
    }

    if (isProd) {
      callback(new Error("Origin is not allowed by CORS"));
      return;
    }

    // In development, allow Replit dev hosts and localhost only — not arbitrary origins
    const replitDevDomain = process.env.REPLIT_DEV_DOMAIN;
    const isReplitOrigin = Boolean(replitDevDomain) && origin.includes(replitDevDomain!);
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(origin);
    const isReplitWorkspace = /\.replit\.dev(:\d+)?$/i.test(origin) || /\.repl\.co(:\d+)?$/i.test(origin);

    if (isReplitOrigin || isLocalhost || isReplitWorkspace) {
      callback(null, true);
      return;
    }

    callback(new Error("Origin is not allowed by CORS"));
  },
  credentials: true,
  // Cache CORS preflights for 24h so the browser stops sending an OPTIONS
  // request before EVERY state-changing /api/admin/* call. Without this,
  // production access logs show one OPTIONS line per real request and the
  // admin dashboard pays a full extra round-trip on every save. 86400s is
  // the highest value Chrome honours; Firefox caps at 24h too.
  maxAge: 86400,
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(adminAccessControl);

// ── Static media serving with S3 fallback ────────────────────────────────────
// Render's filesystem is ephemeral — every deploy/restart wipes the local
// `uploads/` directory.  The transcoder writes HLS variants to local disk and
// also copies them to S3 (see `uploadHlsToS3` in transcoder.ts).  Without a
// fallback, every restart breaks all transcoded broadcasts because the DB
// still points at /api/hls/<id>/master.m3u8 but the local files are gone.
// `s3FallbackMiddleware` checks local disk first (fast path), then transparently
// streams from S3 with full HTTP Range support so video seek bars keep working.
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const HLS_DIR = path.join(UPLOADS_DIR, "hls");

// /api/uploads serves the original full-size source media (typically large
// MP4s, 100s of MB each). On Render's small instances, streaming those bytes
// through the API process under parallel HTTP Range traffic was OOM-killing
// the container — so for anything that has already mirrored to S3 we issue a
// 302 to a short-lived presigned URL and let clients fetch directly from S3.
// The local-disk fast path (express.static) is preserved for the brief window
// after a fresh upload before it mirrors to the bucket. The range guard caps
// per-client concurrency and per-request range size as defence-in-depth for
// the disk fast-path window and the rare presigner-failure fallback.
app.use(
  "/api/uploads",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    // CDN-scale delivery: every video served from /api/uploads has a content-
    // unique UUID filename (videos table mints a fresh uuid per upload), so
    // the bytes behind any given URL never change. That makes them safe to
    // cache `immutable` for the full canonical year a CDN will accept.
    //
    // Without this header the disk fast-path served videos with no
    // Cache-Control at all, forcing every browser and edge cache to
    // revalidate on every load — a measurable TTFF cost on repeat plays
    // and a hard blocker on any CDN edge actually caching the bytes. The
    // 302-redirect path below sets its own (shorter) cache header tied
    // to the signed URL TTL and overrides this one.
    const p = req.path.toLowerCase();
    if (
      p.endsWith(".mp4") || p.endsWith(".m4v") || p.endsWith(".mov") ||
      p.endsWith(".webm") || p.endsWith(".mkv") || p.endsWith(".m4a") ||
      p.endsWith(".mp3")
    ) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    next();
  },
  uploadRangeGuard(),
  // ── S3-redirect-first for large media ────────────────────────────────────
  // Critical: this runs BEFORE express.static, so videos/audio that already
  // exist in the S3 mirror always 302 to a presigned URL — even when the
  // file ALSO exists on Render's ephemeral disk. Without this, the disk
  // fast-path streams hundreds of megabytes through the API process per
  // viewer, hits the per-client concurrency cap, and 429s real users
  // (observed in production logs at 2026-04-26T06:24Z). The disk copy is
  // only useful for the few-seconds window after a fresh upload before the
  // S3 mirror completes — that case still works, because this middleware
  // falls through when S3 has no copy yet, and `express.static` below
  // serves from disk.
  s3RedirectFirstForLargeMedia({
    s3Prefix: "videos/",
    signedUrlTtlSec: 3600,
    extensions: [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".m4a", ".mp3"],
  }),
  express.static(UPLOADS_DIR, { fallthrough: true, acceptRanges: true }),
  s3FallbackMiddleware({
    s3Prefix: "videos/",
    localDir: UPLOADS_DIR,
    redirectFromS3: { signedUrlTtlSec: 3600 },
  }),
);

app.use(
  "/api/hls",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.path.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=30");
    } else if (req.path.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
    next();
  },
  express.static(HLS_DIR, { fallthrough: true, acceptRanges: true }),
  s3FallbackMiddleware({ s3Prefix: "hls/", localDir: HLS_DIR }),
);

app.use(legalRouter);
app.use(sitemapRouter);
app.use("/api", router);

app.get("/", (_req: express.Request, res: express.Response) => {
  res.status(200).json({
    service: "Temple TV API",
    status: "ok",
    documentation: "https://templetv.org.ng",
    endpoints: {
      health: "/api/healthz",
      api: "/api",
      legal: "/legal/privacy, /legal/terms",
    },
    version: process.env.npm_package_version ?? "1.0.0",
  });
});

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: "not_found", message: "The requested endpoint does not exist." });
});

Sentry.setupExpressErrorHandler(app);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "Unhandled request error");
  const isProd = process.env.NODE_ENV === "production";
  const message = isProd
    ? "An internal server error occurred"
    : err instanceof Error ? err.message : "An unexpected error occurred";
  const status = err instanceof Error && "status" in err && typeof (err as any).status === "number"
    ? (err as any).status as number
    : 500;
  res.status(status).json({ error: "internal_error", message });
});

export default app;
