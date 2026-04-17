import type { NextFunction, Request, Response } from "express";
import { randomUUID, timingSafeEqual } from "crypto";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function limitForPath(path: string): number {
  if (path.startsWith("/api/auth/signup") || path.startsWith("/api/auth/login")) return 10;
  if (path.startsWith("/api/auth")) return 30;
  if (path.startsWith("/api/admin/videos/upload")) return 90;
  if (path.startsWith("/api/admin/notifications")) return 20;
  if (path.startsWith("/api/admin")) return 240;
  if (path.startsWith("/api/youtube")) return 120;
  return 600;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function getPresentedAdminToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const header = req.headers["x-admin-token"];
  if (typeof header === "string") return header.trim();
  const queryToken = req.query.adminToken;
  if (typeof queryToken === "string") return queryToken.trim();
  return null;
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  const existing = req.headers["x-request-id"];
  const id = typeof existing === "string" && existing.trim() ? existing : randomUUID();
  res.setHeader("X-Request-Id", id);
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = `${getClientIp(req)}:${req.method}:${req.path.split("/").slice(0, 4).join("/")}`;
  const limit = limitForPath(req.path);
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(limit - 1));
    return next();
  }

  bucket.count += 1;
  const remaining = Math.max(0, limit - bucket.count);
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > limit) {
    return res.status(429).json({
      error: "rate_limited",
      message: "Too many requests. Please wait before trying again.",
      retryAfterSecs: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    });
  }

  return next();
}

export function adminAccessControl(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/admin")) return next();

  const configuredToken = process.env.ADMIN_API_TOKEN?.trim();
  const requiresToken = process.env.NODE_ENV === "production" || Boolean(configuredToken);

  if (!requiresToken) return next();

  if (!configuredToken) {
    return res.status(503).json({
      error: "admin_token_not_configured",
      message: "Admin access is disabled until ADMIN_API_TOKEN is configured.",
    });
  }

  const presentedToken = getPresentedAdminToken(req);
  if (!presentedToken || !safeEqual(presentedToken, configuredToken)) {
    return res.status(401).json({
      error: "admin_unauthorized",
      message: "A valid admin access token is required.",
    });
  }

  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, WINDOW_MS).unref();