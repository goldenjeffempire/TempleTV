import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { adminAccessControl, rateLimit, requestId, securityHeaders } from "./middlewares/security";
import { requestMetrics } from "./middlewares/observability";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.set("trust proxy", 1);
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
app.use(cors({
  origin(origin, callback) {
    const configured = process.env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    if (!origin || process.env.NODE_ENV !== "production" || configured.length === 0 || configured.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by CORS"));
  },
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

app.use("/api", router);

export default app;
