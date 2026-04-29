import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
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
import { youtubeLiveRoutes } from "./modules/youtube-live/youtube-live.routes.js";

const API_PREFIX = "/api/v1";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    bodyLimit: 50 * 1024 * 1024,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS === "*" ? true : env.CORS_ORIGINS.split(",").map((s) => s.trim()),
    credentials: true,
  });
  await app.register(rateLimit, {
    global: false,
    max: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
    timeWindow: "1 minute",
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

  app.addHook("preHandler", attachPrincipal());
  registerErrorHandler(app);

  app.get("/", async () => ({
    service: "temple-tv-api",
    version: "1.0.0",
    docs: "/docs",
    openapi: "/docs/json",
    api: API_PREFIX,
    admin: "/admin/broadcast",
  }));

  await app.register(healthRoutes);
  // Health probe alias under /api so the admin SPA's `apiUrl("/healthz")`
  // — which prefixes /api in dev — resolves correctly without the SPA
  // having to special-case the unversioned root path.
  await app.register(healthRoutes, { prefix: "/api" });
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
    await instance.register(chatRoutes, { prefix: "/chat" });
    // Phase-2 ingest + push gateways for the new dual-buffer player and
    // crash-report firehose. `playbackRoutes` registers HTTP `/state` and
    // WebSocket `/ws`; `youtubeLiveRoutes` provides the SSE channel the
    // admin Live Monitor subscribes to (poller currently disabled, so the
    // gateway emits a single `state: disabled` event and keeps alive);
    // `telemetryRoutes` ingests `/client-errors` from every surface.
    await instance.register(playbackRoutes, { prefix: "/playback" });
    await instance.register(youtubeLiveRoutes, { prefix: "/youtube/live" });
    await instance.register(telemetryRoutes);
    await instance.register(sseRoutes);
    await instance.register(wsRoutes);
  };

  await app.register(registerDomainRoutes, { prefix: API_PREFIX });
  await app.register(registerDomainRoutes, { prefix: "/api" });

  return app;
}
