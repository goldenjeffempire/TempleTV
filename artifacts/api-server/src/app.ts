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
  await app.register(adminUiRoutes);

  await app.register(
    async (instance) => {
      await instance.register(authRoutes, { prefix: "/auth" });
      await instance.register(mediaRoutes, { prefix: "/media" });
      await instance.register(broadcastRoutes, { prefix: "/broadcast" });
      await instance.register(chatRoutes, { prefix: "/chat" });
      await instance.register(sseRoutes);
      await instance.register(wsRoutes);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
