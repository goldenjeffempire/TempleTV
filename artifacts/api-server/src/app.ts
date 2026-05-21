import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { logger } from "./infrastructure/logger.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { attachPrincipal } from "./middleware/auth.js";
import { adminCsrfHook } from "./middleware/csrf.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { mediaRoutes } from "./modules/media/media.routes.js";
import { broadcastRoutes } from "./modules/broadcast/broadcast.routes.js";
import { sseRoutes } from "./modules/realtime/sse.gateway.js";
import { wsRoutes } from "./modules/realtime/ws.gateway.js";
import { chatRoutes } from "./modules/realtime/chat.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { adminUiRoutes } from "./modules/admin-ui/admin-ui.routes.js";
import { playlistsRoutes } from "./modules/playlists/playlists.routes.js";
import { scheduleRoutes } from "./modules/schedule/schedule.routes.js";
import { notificationsRoutes } from "./modules/notifications/notifications.routes.js";
import { liveOverridesRoutes } from "./modules/live-overrides/live-overrides.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { adminOpsRoutes } from "./modules/admin-ops/admin-ops.routes.js";
import { telemetryRoutes } from "./modules/telemetry/telemetry.routes.js";
import { playbackRoutes } from "./modules/playback/playback.routes.js";
import { broadcastV2Routes } from "./modules/broadcast-v2/index.js";
import { youtubeLiveRoutes } from "./modules/youtube-live/youtube-live.routes.js";
import { youtubeChannelRoutes } from "./modules/youtube-channel/youtube-channel.routes.js";
import { mediaUploadsRoutes } from "./modules/media-uploads/media-uploads.routes.js";
import { adminBroadcastRoutes } from "./modules/admin-broadcast/admin-broadcast.routes.js";
import { adminVideosRoutes } from "./modules/admin-videos/admin-videos.routes.js";
import { liveIngestRoutes } from "./modules/live-ingest/live-ingest.routes.js";
import { prayersAdminRoutes } from "./modules/prayers/prayers.routes.js";
import { scheduledNotificationsRoutes } from "./modules/scheduled-notifications/scheduled-notifications.routes.js";
import { launchReadinessRoutes } from "./modules/launch-readiness/launch-readiness.routes.js";
import { adminChatRoutes } from "./modules/admin-chat/admin-chat.routes.js";
import { videosRoutes } from "./modules/videos/videos.routes.js";
import { videoServeRoutes } from "./modules/video-serve/video-serve.routes.js";
import { mediaProxyRoutes } from "./modules/media-proxy/media-proxy.routes.js";
import { pushRoutes } from "./modules/push/push.routes.js";
import { networkRoutes } from "./modules/network/network.routes.js";
import { analyticsRoutes } from "./modules/analytics/analytics.routes.js";
import { channelsRoutes } from "./modules/channels/channels.routes.js";
import { graphicsRoutes } from "./modules/graphics/graphics.routes.js";
import { emergencyRoutes } from "./modules/emergency/emergency.routes.js";
import { seriesRoutes } from "./modules/series/series.routes.js";
import { userRoutes } from "./modules/user/user.routes.js";
import { youtubeSyncRoutes } from "./modules/youtube-sync/youtube-sync.routes.js";
import { youtubeWebhookRoutes, subscribeToYouTubePubSubHubbub, startWebhookAutoRenewal } from "./modules/youtube-webhook/youtube-webhook.routes.js";
import { auditLogRoutes } from "./modules/admin/audit-log.routes.js";
import { settingsRoutes } from "./modules/admin/settings.routes.js";
import { tvHistoryRoutes } from "./modules/tv-history/tv-history.routes.js";
import { radioRoutes } from "./modules/radio/radio.routes.js";
import { seoRoutes } from "./modules/seo/seo.routes.js";
import { metricsRoutes } from "./modules/metrics/metrics.routes.js";
import { httpRequestDuration, httpRequestTotal, SERVICE_LABELS } from "./infrastructure/metrics.js";
const API_PREFIX = "/api/v1";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    // 110 MiB global limit — covers the 64 MiB maximum adaptive chunk size
    // (chunked relay path) plus HTTP framing headroom. The chunk-upload route
    // further overrides this with its own per-route bodyLimit so other routes
    // stay protected at this global ceiling.
    bodyLimit: 110 * 1024 * 1024,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
    // Fastify v5 moved router options under a dedicated sub-key.
    // Treat /foo and /foo/ as the same route so the admin SPA's calls to
    // GET /api/notifications (root alias registered as "/") and
    // GET /api/admin/notifications resolve without a trailing-slash 404.
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(cookie);
  // Enable Helmet security headers with a CSP that covers the only HTML
  // surface this server owns: the Swagger UI at /docs. All other routes
  // return JSON — the CSP headers are ignored by browsers for those.
  //
  // Swagger UI bundles its own assets (no external CDN) but injects
  // inline <script> and <style> tags, so we must allow 'unsafe-inline'.
  // Despite that, the policy is still meaningful because:
  //   • frameAncestors 'none' prevents clickjacking of /docs
  //   • objectSrc 'none' blocks Flash/plugin-based XSS vectors
  //   • upgradeInsecureRequests rewrites any http:// sub-resource loads
  //
  // If Swagger UI adds a nonce-based approach in a future version,
  // drop 'unsafe-inline' and pass a nonce generator instead.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
        // Media (video/audio) must load from: same-origin uploads, any HTTPS
        // CDN/API origin (covers api.templetv.org.ng, CloudFront, etc.),
        // and blob: for hls.js internally-generated object URLs.
        mediaSrc: ["'self'", "https:", "blob:"],
        // hls.js creates a web worker from a blob: URL — without this the
        // player silently falls back to main-thread parsing and lags badly
        // on Smart TV CPUs.
        workerSrc: ["'self'", "blob:"],
        imgSrc: ["'self'", "data:", "https:"],
        // WebSocket connections (wss:) for the broadcast v2 transport and
        // the admin live preview; https: covers REST + HLS segment fetches.
        connectSrc: ["'self'", "https:", "wss:", "ws:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'", "https://*.replit.dev", "https://*.repl.co", "https://*.replit.app"],
        upgradeInsecureRequests: [],
      },
    },
    frameguard: false,
    hsts: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
  });

  // CORS hardening: a wildcard origin combined with `credentials: true` is
  // an exploitable misconfiguration — every site on the public internet
  // could make credentialed (cookie/Authorization-bearing) requests on a
  // user's behalf. Browsers refuse the literal `*` + credentials combo,
  // but `@fastify/cors` with `origin: true` reflects the *request* origin,
  // which silently sidesteps that browser guard. Refuse to start in
  // production with that combination so the misconfiguration is loud.
  const wildcardOrigin = env.CORS_ORIGINS === "*";
  if (wildcardOrigin && env.NODE_ENV !== "development") {
    throw new Error(
      "CORS_ORIGINS='*' is only permitted in development — set an explicit comma-separated allowlist of origins for staging/production.",
    );
  }
  // F05: also warn loudly in development so the open wildcard is never silent.
  if (wildcardOrigin) {
    logger.warn(
      "CORS_ORIGINS='*' — all origins accepted. Set an explicit allowlist before deploying to staging/production.",
    );
  }

  /**
   * Parse a single CORS_ORIGINS entry into a string (exact match) or
   * RegExp (wildcard/pattern match).
   *
   * Supported formats:
   *   1. Exact origin  → "https://templetv.org.ng"
   *   2. Wildcard host → "https://*.templetv.org.ng"
   *      Converted to /^https:\/\/[^.]+\.templetv\.org\.ng$/ so that
   *      every subdomain (admin, tv, api, …) is accepted without listing
   *      each one individually. Only one level of subdomain is matched —
   *      "foo.bar.templetv.org.ng" is NOT matched, preventing over-broad
   *      acceptance.
   *   3. Regex literal → "/^https:\\/\\/templetv\\./" — any entry whose
   *      first and last non-whitespace chars are "/" is treated as a raw
   *      regex. Used for advanced cases (multiple TLDs, port variants, etc.)
   *
   * Multi-domain operator guide:
   *   Set CORS_ORIGINS in the Render dashboard (temple-tv-domains group).
   *   Example covering 4+ custom domains with no code change:
   *     https://templetv.org.ng,https://www.templetv.org.ng,
   *     https://*.templetv.org.ng,https://jctm.church,https://*.jctm.church
   *   Adding a 5th domain: append it to the dashboard value and restart.
   */
  function parseCorsOrigin(raw: string): string | RegExp {
    const s = raw.trim();
    // Regex literal: /pattern/
    if (s.startsWith("/") && s.endsWith("/") && s.length > 2) {
      return new RegExp(s.slice(1, -1));
    }
    // Wildcard host: scheme://*.hostname
    // e.g. https://*.templetv.org.ng
    const wildcardMatch = s.match(/^(https?:\/\/)\*\.(.+)$/);
    if (wildcardMatch) {
      const [, scheme, host] = wildcardMatch;
      // Escape the host for use in a regex, then anchor it.
      const escapedHost = host.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const escapedScheme = scheme.replace(/\//g, "\\/");
      // [^.]+ matches exactly one subdomain segment (no dots), keeping the
      // match tight and preventing inadvertent cross-subdomain acceptance.
      return new RegExp(`^${escapedScheme}[^.]+\\.${escapedHost}$`);
    }
    // Default: exact string match.
    return s;
  }

  const parsedOrigins: Array<string | RegExp> = wildcardOrigin
    ? []
    : env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean).map(parseCorsOrigin);

  // Merge CORS_ORIGINS_EXTRA (if set) into the allowed-origin list.
  // This is the hook for Render auto-generated URLs (https://*.onrender.com)
  // and other preview-platform domains that are known at deploy time but
  // do not belong in the operator-managed `temple-tv-domains` env group.
  if (!wildcardOrigin && env.CORS_ORIGINS_EXTRA) {
    const extra = env.CORS_ORIGINS_EXTRA
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseCorsOrigin);
    parsedOrigins.push(...extra);
    app.log.info(
      { extraOrigins: extra.map((e) => (e instanceof RegExp ? e.source : e)) },
      "cors: merged CORS_ORIGINS_EXTRA into allowlist",
    );
  }

  if (!wildcardOrigin && parsedOrigins.length === 0 && env.NODE_ENV !== "development") {
    throw new Error(
      "CORS_ORIGINS='' is not permitted in production — set an explicit comma-separated allowlist of origins.",
    );
  }

  // Auto-allow Replit-managed dev/preview domains so the in-workspace iframes
  // (admin, TV, and especially the Expo mobile *web* preview which runs on a
  // different `*.expo.spock.replit.dev` origin and therefore can't piggy-back
  // on a same-origin Vite proxy) can reach the API in development without the
  // operator having to maintain a separate CORS_ORIGINS_EXTRA entry per Repl.
  // Also allow localhost:5000 and localhost:3000 — when the mobile web preview
  // is loaded through the /mobile/* dev proxy (served on port 5000), the
  // browser origin is http://localhost:5000, which must be permitted so the
  // Expo web bundle can make API calls back to the same API server.
  // Production deployments never hit this branch — REPLIT_DEV_DOMAIN /
  // REPLIT_EXPO_DEV_DOMAIN are only set inside the Replit dev container.
  if (!wildcardOrigin) {
    const replitDevHosts = [
      process.env.REPLIT_DEV_DOMAIN,
      process.env.REPLIT_EXPO_DEV_DOMAIN,
    ].filter((h): h is string => Boolean(h));
    if (replitDevHosts.length > 0) {
      const replitOrigins = replitDevHosts.map((h) => `https://${h}`);
      parsedOrigins.push(...replitOrigins);
      app.log.info(
        { replitOrigins },
        "cors: auto-allowed Replit dev/preview domains",
      );
    }
    if (env.NODE_ENV !== "production") {
      parsedOrigins.push("http://localhost:5000", "http://localhost:3000");
      app.log.info("cors: auto-allowed localhost origins for dev proxy (mobile/admin web previews)");
    }
  }
  await app.register(cors, {
    origin: wildcardOrigin ? true : parsedOrigins,
    credentials: !wildcardOrigin,
  });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
    timeWindow: "1 minute",
    // Skip rate limiting for paths that are inherently high-frequency or
    // long-lived so they can never exhaust the per-IP bucket:
    //
    //  /tv/*        — Vite HMR dev proxy: the API server forwards these to
    //                 the TV Vite dev server. In development this path carries
    //                 dozens of module-graph requests on every HMR cycle; they
    //                 are not API calls and must never count against the limit.
    //
    //  broadcast-v2 state / health / health-check
    //               — Polled at 1–5 s intervals by TV, mobile, and admin
    //                 clients. A 120 req/min global limit would be exhausted
    //                 in seconds by a single open browser tab.
    //
    //  /hls/* and /media-proxy
    //               — HLS segment fetch bursts (tens of requests/s when a
    //                 player cold-starts) and proxied MP4 byte streams.
    //                 These are already protected by the storage layer and
    //                 the HMAC-signed proxy URL; a hard req/min cap would
    //                 cause playback stalls for all concurrent viewers.
    //
    //  SSE and WebSocket upgrade requests are long-lived connections that
    //  only open once; they should never trigger the counter.
    allowList: (req: import("fastify").FastifyRequest) => {
      const url = req.url ?? "";
      // Dev TV proxy
      if (url.startsWith("/tv/")) return true;
      // Dev Mobile (Expo web) proxy + Expo HMR WebSocket paths
      if (url.startsWith("/mobile/") || url.startsWith("/mobile?")) return true;
      if (url.startsWith("/artifacts/mobile/")) return true;
      if (url === "/hot" || url.startsWith("/hot?")) return true;
      if (url === "/message" || url.startsWith("/message?")) return true;
      if (url.startsWith("/assets/") || url.startsWith("/assets?")) return true;
      // Broadcast v2 real-time paths
      if (url.includes("/broadcast-v2/state")) return true;
      if (url.includes("/broadcast-v2/health")) return true;
      if (url.includes("/broadcast-v2/events")) return true;
      if (url.includes("/broadcast-v2/ws")) return true;
      if (url.includes("/broadcast-v2/rehydrate")) return true;
      // HLS segments + media proxy (high-volume streaming)
      if (url.includes("/hls/")) return true;
      if (url.includes("/media-proxy")) return true;
      // SSE and WebSocket upgrade connections
      const upgrade = req.headers["upgrade"];
      if (typeof upgrade === "string" && upgrade.toLowerCase() === "websocket") return true;
      const accept = req.headers["accept"];
      if (typeof accept === "string" && accept.includes("text/event-stream")) return true;
      return false;
    },
  });

  // Negotiated response compression (brotli > gzip > deflate). Cuts JSON
  // payloads ~70-80%, which is the dominant cost for the admin dashboard
  // and the /schedule endpoints. `threshold: 1024` skips tiny responses
  // where the framing overhead would dominate. SSE/WebSocket frames are
  // never compressed (the plugin recognises `text/event-stream`); HEAD
  // requests are also bypassed.
  // NOTE: text/html is excluded because the Replit dev proxy can drop gzip-
  // encoded HTML body bytes, resulting in empty responses in the preview pane.
  //
  // HLS segments (video/mp2t) and manifests (application/vnd.apple.mpegurl)
  // are NOT compressed — the plugin's default content-type regex only matches
  // text/*, *json, *xml, and octet-stream, so MPEG-TS/M3U8 are already
  // excluded. No extra configuration needed. (F40)
  await app.register(compress, {
    global: true,
    encodings: ["br", "gzip", "deflate"],
    threshold: 1024,
  });

  await app.register(websocket);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Temple TV API",
        description:
          "Production-grade backend powering Web, Mobile, Smart TV, and Admin Dashboard.",
        version: "1.0.0",
      },
      servers: [
        { url: "/", description: "Current host" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      tags: [
        { name: "auth", description: "Sign-in, sign-up, refresh, profile" },
        { name: "broadcast", description: "Live channel + queue management" },
        { name: "media", description: "On-demand catalog + uploads" },
        { name: "playlists", description: "Curated video playlists" },
        { name: "schedule", description: "Weekly broadcast programming schedule" },
        { name: "live", description: "Live overrides (HLS / YouTube / RTMP)" },
        { name: "notifications", description: "Push notifications + history" },
        { name: "admin", description: "Admin dashboard: stats, users, analytics" },
        { name: "chat", description: "Live broadcast chat" },
        { name: "health", description: "Liveness + readiness" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUI, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });

  // ── Content-type parsers for the chunked upload relay path ───────────────
  // Fastify only parses application/json and text/plain by default. The
  // chunk endpoint receives raw binary (application/octet-stream) and the
  // thumbnail endpoint receives multipart/form-data; both are stored as
  // Buffers and handled by the route handlers directly.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // Extend the underlying HTTP server's request timeout for long-running
  // uploads. Node.js 18+ defaults to 300_000 ms (5 minutes) which is too
  // short for a 64 MiB chunk on a slow link (~250 KB/s ≈ 4.4 min). The
  // client stall watchdog already kills truly dead connections; this only
  // guards against the server-side ejection of legitimately slow transfers.
  app.server.requestTimeout = 20 * 60 * 1000; // 20 minutes

  // CSRF protection (SEC-05): reject cookie-authenticated state-mutating
  // requests to /admin/* that lack the X-Admin-CSRF: 1 custom header.
  // See middleware/csrf.ts for the full rationale and exemption rules.
  // F16: strip Content-Security-Policy from non-HTML responses.
  // Helmet registers CSP globally, but CSP is only enforced by browsers on
  // HTML documents. JSON API responses don't need it, and sending it on every
  // response adds unnecessary bytes and can confuse some intermediaries.
  // The /docs Swagger UI (text/html) keeps the full policy.
  app.addHook("onSend", async (req, reply, payload) => {
    // Use the raw Node.js response to remove headers because @fastify/helmet
    // sets them via res.setHeader() (Express/Connect middleware path), which
    // Fastify's reply.removeHeader() does not affect.
    const ct = (reply.raw.getHeader("content-type") as string | undefined) ?? "";
    if (!ct.includes("text/html")) {
      reply.raw.removeHeader("content-security-policy");
    }

    // Override CORP for media delivery routes. @fastify/helmet sets
    // `Cross-Origin-Resource-Policy: same-origin` globally, which prevents
    // browsers from loading video/audio bytes when the player page and the
    // API server are on different origins (e.g. admin on :3000, TV on :23876,
    // or a different subdomain like admin.templetv.org.ng fetching from
    // api.templetv.org.ng). Media routes must be cross-origin so every
    // surface — admin preview, TV player, mobile — can stream assets.
    //
    // This hook runs AFTER helmet's onSend hook (hooks fire in registration
    // order; we registered this after helmet above) so our value overwrites
    // helmet's. Route handlers also set the header directly as belt-and-
    // suspenders, but this global hook catches any path we may have missed.
    const url = req.url ?? "";
    const isMediaPath =
      url.includes("/uploads/") ||
      url.includes("/hls/") ||
      url.includes("/hls-token/") ||
      url.includes("/media-proxy") ||
      (url.includes("/videos/") && url.endsWith("/source"));
    if (isMediaPath) {
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Timing-Allow-Origin", "*");
    }

    return payload;
  });

  // ── HTTP request duration histogram ──────────────────────────────────────
  // Instruments every Fastify route with a Prometheus histogram. Uses
  // `req.routeOptions.url` (the parameterised route pattern, e.g.
  // `/api/v1/admin/videos/:id`) instead of the raw URL so high-cardinality
  // dynamic segments do not create unbounded label sets.
  app.addHook("onResponse", (req, reply, done) => {
    const route = (req.routeOptions as { url?: string } | undefined)?.url ?? req.url ?? "unknown";
    const method = req.method ?? "UNKNOWN";
    const statusCode = String(reply.statusCode);
    const durationSec = reply.elapsedTime / 1000;
    httpRequestDuration.observe(
      { method, route, status_code: statusCode, ...SERVICE_LABELS },
      durationSec,
    );
    httpRequestTotal.inc({ method, route, status_code: statusCode, ...SERVICE_LABELS });
    done();
  });

  app.addHook("onRequest", adminCsrfHook);
  app.addHook("preHandler", attachPrincipal());
  registerErrorHandler(app);

  // Root route: redirect browsers to the mobile web app; return JSON for API clients.
  //
  // Browser requests (Accept: text/html) are redirected to /mobile/ so that:
  //   • Replit's "Simulate on Web" preview lands on the mobile app, not the API.
  //   • The Replit published deployment's root URL shows the app, not a 404.
  //   • Users who bookmark or share the root domain see the app immediately.
  //
  // Admins reach the dashboard at /dashboard/broadcast directly or via the
  // sidebar link — they are not impacted by this redirect.
  //
  // API clients (curl, OpenAPI, health probes) receive JSON as before.
  app.get("/", async (req, reply) => {
    const accept = req.headers["accept"] ?? "";
    if (accept.includes("text/html")) {
      return reply.redirect("/mobile/", 302);
    }
    return {
      service: "temple-tv-api",
      version: "1.0.0",
      docs: "/docs",
      openapi: "/docs/json",
      api: API_PREFIX,
      admin: "/dashboard/broadcast",
      app: "/mobile/",
    };
  });

  await app.register(healthRoutes);
  // Health probe alias under /api so the admin SPA's `apiUrl("/healthz")`
  // — which prefixes /api in dev — resolves correctly without the SPA
  // having to special-case the unversioned root path.
  await app.register(healthRoutes, { prefix: "/api" });

  // Prometheus scrape endpoint — registered at root so Prometheus can reach it
  // without traversing the /api/v1 prefix. Returns 401 for unauthenticated
  // requests; scrapers pass ADMIN_API_TOKEN as `Authorization: Bearer <token>`.
  await app.register(metricsRoutes);

  await app.register(adminUiRoutes);

  // Domain modules. Registered under both `/api/v1` (the canonical, versioned
  // path used by typed clients and OpenAPI) and `/api` (versionless legacy
  // path that the in-tree admin SPA was originally written against). Routing
  // both prefixes to the same handlers lets the SPA migration land
  // incrementally without breaking existing call sites or duplicating route
  // logic. New external consumers should use /api/v1 only.
  const registerDomainRoutes = async (instance: FastifyInstance) => {
    await instance.register(authRoutes, { prefix: "/auth" });
    await instance.register(mediaRoutes, { prefix: "/media" });
    await instance.register(broadcastRoutes, { prefix: "/broadcast" });
    await instance.register(playlistsRoutes, { prefix: "/playlists" });
    await instance.register(scheduleRoutes, { prefix: "/schedule" });
    await instance.register(notificationsRoutes, { prefix: "/notifications" });
    await instance.register(liveOverridesRoutes, { prefix: "/live" });
    await instance.register(adminRoutes, { prefix: "/admin" });
    // Operations / observability endpoints the admin SPA depends on.
    // Sharing the `/admin` prefix with adminRoutes is fine — Fastify only
    // collides on identical method+path tuples and the route sets are
    // disjoint by design (see admin-ops.routes.ts header).
    await instance.register(adminOpsRoutes, { prefix: "/admin" });
    // S3 multipart upload gateway (init/sign/complete/abort + CORS probe).
    // Same `/admin` prefix as adminRoutes / adminOpsRoutes — route paths
    // are disjoint (`/videos/upload/s3-multipart-*`).
    await instance.register(mediaUploadsRoutes, { prefix: "/admin" });
    // Admin SPA legacy aliases + new specialised admin surfaces. Each of
    // these mounts under `/admin` and their route paths are mutually
    // disjoint (broadcast/, videos, prayers/, notifications/{scheduled,
    // schedule}, launch/readiness, live-ingest/, chat/{messages,moderate}).
    // Keeping them as separate plugins (rather than appending to
    // adminRoutes / adminOpsRoutes) makes ownership obvious and lets each
    // feature be deleted in one `git rm` if/when the SPA migrates off it.
    await instance.register(adminBroadcastRoutes, { prefix: "/admin" });
    await instance.register(adminVideosRoutes, { prefix: "/admin" });
    await instance.register(liveIngestRoutes, { prefix: "/admin" });
    await instance.register(prayersAdminRoutes, { prefix: "/admin" });
    await instance.register(scheduledNotificationsRoutes, { prefix: "/admin" });
    // Mirror the public /notifications routes under the /admin prefix so the
    // admin SPA can call GET /admin/notifications (history) and
    // POST /admin/notifications/send without a path change. Route paths within
    // notificationsRoutes (/history, /, /send) are disjoint from the paths
    // registered by scheduledNotificationsRoutes (/notifications/scheduled,
    // /notifications/schedule, /notifications/failed, /notifications/scheduled/:id).
    await instance.register(notificationsRoutes, { prefix: "/admin/notifications" });
    await instance.register(launchReadinessRoutes, { prefix: "/admin" });
    await instance.register(adminChatRoutes, { prefix: "/admin" });
    await instance.register(auditLogRoutes, { prefix: "/admin" });
    await instance.register(settingsRoutes, { prefix: "/admin" });
    await instance.register(chatRoutes, { prefix: "/chat" });
    // Phase-2 ingest + push gateways for the new dual-buffer player and
    // crash-report firehose. `playbackRoutes` registers HTTP `/state` and
    // WebSocket `/ws`; `youtubeLiveRoutes` provides the SSE channel the
    // admin Live Monitor subscribes to (poller currently disabled, so the
    // gateway emits a single `state: disabled` event and keeps alive);
    // `telemetryRoutes` ingests `/client-errors` from every surface.
    await instance.register(playbackRoutes, { prefix: "/playback" });
    // ── Broadcast v2 (rebuild) ───────────────────────────────────────
    // Server-authoritative streaming control plane. Coexists with the v1
    // broadcast/playback modules until the cut-over (see .local/rebuild/02-architecture.md).
    // Endpoints:
    //   GET  /broadcast-v2/state            — snapshot
    //   GET  /broadcast-v2/rehydrate        — replay events from sequence
    //   GET  /broadcast-v2/events           — SSE stream
    //   GET  /broadcast-v2/ws               — WebSocket
    //   POST /broadcast-v2/skip
    //   POST /broadcast-v2/override/start|stop
    //   POST /broadcast-v2/force-failover|clear-failover|reload
    await instance.register(broadcastV2Routes, { prefix: "/broadcast-v2" });
    await instance.register(youtubeLiveRoutes, { prefix: "/youtube/live" });
    // YouTube channel content proxy — serves /api/youtube/rss and
    // /api/youtube/videos so web clients avoid CORS and all platforms
    // share a single 10-minute cached fetch of the @TEMPLETVJCTM feed.
    await instance.register(youtubeChannelRoutes, { prefix: "/youtube" });
    // YouTube PubSubHubbub webhook — near-real-time new-upload notification.
    // Hub sends GET /api/youtube/webhook (verification) then POST with Atom XML.
    // Registered under /youtube so it lands at /api/youtube/webhook and
    // /api/v1/youtube/webhook (dual-prefix routing). Subscription is initiated
    // in the onReady hook below after the server can accept the hub's challenge.
    await instance.register(youtubeWebhookRoutes, { prefix: "/youtube" });
    // YouTube channel auto-sync: manual-trigger, status, quota, and history
    // endpoints. Mounted under /admin so they are auth-gated. Route paths:
    //   POST  /admin/youtube/sync
    //   GET   /admin/youtube/sync/status
    //   GET   /admin/youtube/sync/history
    //   GET   /admin/youtube/quota
    await instance.register(youtubeSyncRoutes, { prefix: "/admin" });
    // Public read-only video catalogue. The TV / mobile / web library
    // pages all hit `GET /api/videos?limit=…` for the full library.
    await instance.register(videosRoutes, { prefix: "/videos" });
    // Video-serve gateway: restores /uploads/:filename, /videos/:id/source,
    // and /hls/:videoId/* routes that the old production server provided.
    // These endpoints redirect (302) to the actual S3 storage location so
    // legacy `localVideoUrl` values in the DB resolve correctly on every
    // surface (TV, mobile, admin) without any DB migration.
    await instance.register(videoServeRoutes);
    // Server-side media proxy: streams external MP4/HLS assets through this
    // server so player clients receive same-origin responses without CORS/CORP
    // restrictions. Used for prod-synced items whose source URL is on a
    // different origin (e.g. api.templetv.org.ng sets CORP same-origin, which
    // blocks admin/TV/mobile from loading the file cross-origin). URLs are
    // HMAC-signed at generation time in queue.repo.ts and validated here.
    await instance.register(mediaProxyRoutes);
    await instance.register(telemetryRoutes);
    await instance.register(sseRoutes);
    await instance.register(wsRoutes);
    // Push notification registration: Expo tokens + Web Push subscriptions
    // + VAPID public key endpoint. No sub-prefix so paths land at:
    //   POST /api/push-tokens           (mobile native)
    //   POST /api/push/web-subscriptions (browser)
    //   GET  /api/push/web-vapid-public-key
    await instance.register(pushRoutes);
    // OMEGA Control Plane: Network Operations Center.
    // Registers:
    //   GET  /api/network/status              — NOC dashboard state
    //   GET  /api/network/heartbeat           — encoder/stream/CDN/player health
    //   POST /api/network/broadcast/command   — GO_LIVE / SWITCH / SYNC / EMERGENCY / FAILOVER / LOCK / UNLOCK / STOP
    await instance.register(networkRoutes, { prefix: "/network" });
    await instance.register(analyticsRoutes, { prefix: "/analytics" });
    await instance.register(channelsRoutes);
    await instance.register(graphicsRoutes);
    await instance.register(emergencyRoutes);
    await instance.register(seriesRoutes);
    await instance.register(userRoutes, { prefix: "/user" });
    // TV watch-history: fire-and-forget upsert every ~5 s during playback.
    // Routes: POST /tv/history, GET /tv/history/:deviceId, DELETE /tv/history/:deviceId
    // Backing table: device_watch_history (device_id + video_id unique index).
    await instance.register(tvHistoryRoutes);
    // Radio station: live stream config (public) + admin CRUD.
    // Routes inside radioRoutes: GET /radio, GET /admin/radio, PATCH /admin/radio.
    // Registered with no sub-prefix so paths are relative to the parent
    // prefix (/api or /api/v1) — yields /api/radio, /api/v1/radio, etc.
    await instance.register(radioRoutes);
  };

  await app.register(registerDomainRoutes, { prefix: API_PREFIX });
  await app.register(registerDomainRoutes, { prefix: "/api" });

  // SEO surfaces — registered at the root (no /api prefix) so they are
  // available directly at https://api.templetv.org.ng/sitemap-sermons.xml
  // and https://api.templetv.org.ng/podcast.xml as referenced in sitemap.xml.
  await app.register(seoRoutes);

  // ── Dev-only TV app proxy ─────────────────────────────────────────────────
  // In development the TV Vite dev server runs on port 23876 (mapped from the
  // Replit workflow system).  This proxy forwards /tv/* requests from the main
  // API port (5000 / 80) to the Vite dev server so the TV player is reachable
  // through the primary Replit preview without switching ports.  Never active
  // in production — the TV app ships as static files served by a CDN.
  if (env.NODE_ENV !== "production") {
    const TV_DEV_PORT = Number(process.env.TV_DEV_PORT ?? "23876");
    const http = await import("node:http");

    function makeDevProxy(port: number, label: string, stripPrefix?: string) {
      return async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
        // Hijack the reply so Fastify's onSend hooks (helmet CSP, etc.) do not
        // touch the headers — the dev server provides its own headers.
        reply.hijack();
        // Optionally strip a path prefix before forwarding (e.g. /mobile → /)
        // so the downstream dev server sees root-relative paths it expects.
        let forwardPath = req.url;
        if (stripPrefix && forwardPath.startsWith(stripPrefix)) {
          forwardPath = forwardPath.slice(stripPrefix.length) || "/";
        }
        await new Promise<void>((resolve) => {
          const proxyReq = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: forwardPath,
              method: req.method,
              headers: { ...req.headers, host: `localhost:${port}` },
            },
            (proxyRes) => {
              reply.raw.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
              proxyRes.pipe(reply.raw, { end: true });
              proxyRes.on("end", resolve);
              proxyRes.on("error", () => resolve());
            },
          );
          proxyReq.on("error", (err) => {
            if (!reply.raw.headersSent) {
              reply.raw.writeHead(502);
              reply.raw.end(`${label} dev server unavailable on port ${port}: ${err.message}`);
            }
            resolve();
          });
          proxyReq.end();
        });
      };
    }

    const tvProxy = makeDevProxy(TV_DEV_PORT, "TV");
    app.get("/tv", tvProxy as unknown as Parameters<typeof app.get>[1]);
    app.get("/tv/*", tvProxy as unknown as Parameters<typeof app.get>[1]);
    logger.info({ port: TV_DEV_PORT }, "dev TV proxy registered at /tv/*");

    // ── Dev-only Mobile (Expo web) proxy ─────────────────────────────────────
    // The Expo Metro dev server runs its web target on port 18115 and always
    // expects root-relative paths (e.g. /). The Replit mobile artifact preview
    // hits the API at /mobile/, so we strip the /mobile prefix before forwarding
    // so Expo Router sees "/" and renders the index route correctly.
    // /artifacts/mobile/* are the Metro bundle/asset paths (NOT stripped — Metro
    // serves them at that same absolute path). /hot and /message are Expo HMR
    // WebSocket upgrade paths that originate from the loaded Expo web page.
    const MOBILE_DEV_PORT = Number(process.env.MOBILE_DEV_PORT ?? "18115");
    const mobileProxy = makeDevProxy(MOBILE_DEV_PORT, "Mobile", "/mobile");
    const mobileAssetProxy = makeDevProxy(MOBILE_DEV_PORT, "Mobile");
    app.get("/mobile", mobileProxy as unknown as Parameters<typeof app.get>[1]);
    app.get("/mobile/*", mobileProxy as unknown as Parameters<typeof app.get>[1]);
    // Metro bundle + asset paths — no prefix stripping needed.
    app.get("/artifacts/mobile/*", mobileAssetProxy as unknown as Parameters<typeof app.get>[1]);
    // Expo Metro also serves font/image assets at /assets/* (unstable_path query).
    app.get("/assets", mobileAssetProxy as unknown as Parameters<typeof app.get>[1]);
    app.get("/assets/*", mobileAssetProxy as unknown as Parameters<typeof app.get>[1]);
    // Expo HMR WebSocket upgrade paths. Fastify handles GET for the initial
    // HTTP-to-WS upgrade handshake; we hijack and pipe the raw socket.
    const wsProxy = (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      const net = require("node:net") as typeof import("node:net");
      reply.hijack();
      const socket = req.raw.socket;
      const upstream = net.connect(MOBILE_DEV_PORT, "127.0.0.1", () => {
        // Re-send the original HTTP upgrade request to the upstream server.
        const reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
        const headers = Object.entries({ ...req.headers, host: `localhost:${MOBILE_DEV_PORT}` })
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v ?? ""}`)
          .join("\r\n");
        upstream.write(`${reqLine}${headers}\r\n\r\n`);
        upstream.pipe(socket, { end: true });
        socket.pipe(upstream, { end: true });
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    };
    app.get("/hot", wsProxy as unknown as Parameters<typeof app.get>[1]);
    app.get("/message", wsProxy as unknown as Parameters<typeof app.get>[1]);
    logger.info({ port: MOBILE_DEV_PORT }, "dev Mobile proxy registered at /mobile/*, /artifacts/mobile/*, /hot, /message");
  }

  // Subscribe to YouTube's PubSubHubbub hub once the server is fully ready
  // (so it can receive and respond to the hub's verification GET challenge).
  // Fires after listen() completes. Non-fatal on failure — the 5-min poller
  // continues providing library updates.
  app.addHook("onReady", async () => {
    const baseUrl =
      process.env.WEBHOOK_BASE_URL ??
      (process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : null);
    if (baseUrl) {
      void subscribeToYouTubePubSubHubbub(baseUrl);
      // Kick off the 5.5-day auto-renewal timer so the webhook lease never
      // lapses on long-running deployments (lease expires after 7 days).
      startWebhookAutoRenewal(baseUrl);
    }
  });

  return app;
}
