import type { FastifyRequest } from "fastify";
import { env } from "../config/env.js";

/**
 * SSE handlers call reply.raw.writeHead() directly, which bypasses Fastify's
 * CORS plugin. This helper computes the CORS headers that should be injected
 * into writeHead() so browsers can read the event stream.
 *
 * Mirrors the same origin logic as the CORS plugin in app.ts:
 *  - CORS_ORIGINS="*" (default) → reflect the request Origin header
 *  - Specific list               → only reflect if origin is in the list
 *  - No Origin header            → no CORS headers added
 */
export function sseCorsHeaders(req: FastifyRequest): Record<string, string> {
  const origin = req.headers.origin as string | undefined;
  if (!origin) return {};

  const wildcardOrigin = env.CORS_ORIGINS === "*";

  if (wildcardOrigin) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
  }

  const replitOrigins: string[] = [];
  if (env.NODE_ENV === "development" || env.REPLIT_DEV_DOMAIN) {
    if (env.REPLIT_DEV_DOMAIN) {
      replitOrigins.push(`https://${env.REPLIT_DEV_DOMAIN}`);
    }
    replitOrigins.push(
      "http://localhost:5000",
      "http://localhost:3000",
    );
  }

  const allowed = [
    ...env.CORS_ORIGINS.split(",").map((s: string) => s.trim()).filter(Boolean),
    ...replitOrigins,
  ];

  const isAllowed = allowed.some((allowed) => {
    if (allowed.startsWith("/") && allowed.endsWith("/")) {
      const re = new RegExp(allowed.slice(1, -1));
      return re.test(origin);
    }
    if (allowed.includes("*")) {
      const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(origin);
    }
    return allowed === origin;
  });

  if (!isAllowed) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}
