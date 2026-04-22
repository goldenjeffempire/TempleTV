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
import { adminAccessControl, rateLimit, requestId, securityHeaders } from "./middlewares/security";
import { requestMetrics } from "./middlewares/observability";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.set("trust proxy", 1);
app.use(compression({ threshold: 1024 }));
app.use(requestId);
app.use(securityHeaders);
app.use(rateLimit);
app.use(requestMetrics);
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
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
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(adminAccessControl);

app.use("/api/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.use("/api/hls", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  if (req.path.endsWith(".m3u8")) {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "public, max-age=30");
  } else if (req.path.endsWith(".ts")) {
    res.setHeader("Content-Type", "video/mp2t");
  }
  next();
}, express.static(path.join(__dirname, "..", "uploads", "hls")));

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
