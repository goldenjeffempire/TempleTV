---
name: CORS preflight DELETE failure — explicit allowedHeaders fix
description: Why mutations show "Could not reach the server" while GETs serve cached data; fix is explicit allowedHeaders on @fastify/cors + admin.→api. inference safety net
---

## The bug

Render free tier returns bare 502 (no CORS headers) during cold-start.
When the browser sends a CORS preflight (OPTIONS) for a DELETE/POST/PATCH:
- Normally @fastify/cors echoes back Access-Control-Request-Headers (including x-admin-csrf)
- During cold-start the 502 has no Access-Control-Allow-Headers at all
- Browser rejects the response → fetch() throws TypeError → "Could not reach the server"

GET requests appear to work because TanStack Query serves stale cached data (staleTime=60s / gcTime=10min).

## Why mutations are affected but GETs "work"

DELETE/POST/PATCH add `X-Admin-CSRF: 1` (custom header) → preflight required.
GET requests sometimes skip preflight (simple request with only Authorization) but more importantly their stale TanStack Query cache renders the page even when API is unreachable.

## Fix 1 — Explicit CORS allowedHeaders in app.ts

```javascript
await app.register(cors, {
  origin: ...,
  credentials: ...,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-CSRF", "Range"],
  exposedHeaders: ["Content-Range", "Content-Disposition", "X-Total-Count"],
  maxAge: 600, // 10 min preflight cache → fewer OPTIONS round-trips on cold start
});
```

**Why:** The preflight response is now deterministic regardless of whether the @fastify/cors reflection logic fires correctly.

**How to apply:** Any new custom request header added to the SPA must be appended to allowedHeaders here or cross-origin preflights will block it.

## Fix 2 — Restore admin.→api. hostname inference in api-base.ts

VITE_API_URL is baked into the Render build. If the build cache serves stale JS (pre-dating the env var), apiBase() falls back to /api on the same-origin static host → HTML returned for all API calls → mutations silently fail.

The `inferProductionApiOrigin()` function now restores the admin.→api. rewrite as a safety net:
- Replit dev domains (.replit.dev, .worf.replit.dev, .replit.app, localhost) → return null (use relative /api path via Vite proxy)
- *.onrender.com admin URLs → canonical admin.templetv.org.ng
- Any hostname starting with "admin." (excl. above) → replace prefix with "api."

**Why:** Defence-in-depth: even if VITE_API_URL is not baked, the SPA still routes correctly.
