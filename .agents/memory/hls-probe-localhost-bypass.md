---
name: HLS probe localhost bypass — orchestrator + scanner 401 fix
description: Root cause and fix for 401 errors when orchestrator/scanner probe HLS URLs that use API_ORIGIN as their hostname. Applies to any deployment where API_ORIGIN is the external canonical URL.
---

## REQUIRE_HLS_TOKEN must NOT block viewer routes

REQUIRE_HLS_TOKEN=true was blocking all public viewers (TV, mobile, web) who don't send ?t=TOKEN.
**Fix**: The HEAD and GET /hls/:videoId/* route handlers no longer check REQUIRE_HLS_TOKEN. These routes are intentionally public — the private S3 bucket is already protected by the server acting as a proxy. Token enforcement (if ever needed) must be done at the CDN layer, not the API origin.

The env var REQUIRE_HLS_TOKEN is retained only for the token-signing infrastructure (makeHlsToken/validateHlsToken) used by internal orchestrator probes — it no longer gates any viewer request.

## The Problem

`probeUrlReachability()` in `broadcast-orchestrator.ts` and the `probeHlsManifest()` / `probeUrl()` functions in `media-integrity-scanner.ts` probe HLS URLs using the fully-normalized form (e.g. `https://api.templetv.org.ng/api/hls/VIDEO_ID/master.m3u8?t=TOKEN`).

This exits the Node process, traverses the CDN/reverse proxy, and arrives at the `/api/hls/*` handler with a non-loopback source IP. When `REQUIRE_HLS_TOKEN=true`, the `isLoopbackIp()` bypass never fires, so the probe gets **401 Unauthorized** — even though the token is valid.

**Why REQUIRE_HLS_TOKEN auto-enables:** If `HLS_TOKEN_SECRET` is set in the environment (even without an explicit `REQUIRE_HLS_TOKEN=true`), the server auto-enables it with a startup WARN. This is the common production state.

## The Fix

### 1. `toLocalhostProbeUrl()` in orchestrator + scanner
Detects when a probe URL's hostname matches any of `API_ORIGIN`, `RENDER_EXTERNAL_URL`, `REPLIT_DEV_DOMAIN`, or `REPLIT_DOMAINS` **and** the pathname contains `/api/hls/` or `/api/v1/hls/`. Rewrites to `http://127.0.0.1:PORT/…`. This short-circuits external routing and guarantees the loopback bypass fires.

### 2. `INTERNAL_HLS_BYPASS_SECRET` env var (optional, belt-and-suspenders)
A pre-shared secret. When set:
- Orchestrator and scanner inject `X-Internal-Token: <secret>` on all probe requests (including `fetchProbeStatus` and HLS GET fetches).
- `isInternalRequest(req)` in `video-serve.routes.ts` checks this header in addition to loopback IP.

### 3. `isInternalRequest()` replaces `isLoopbackIp()` in video-serve.routes.ts
Both HEAD and GET HLS route handlers now call `isInternalRequest(req)` which checks loopback IP **or** the X-Internal-Token header. This allows multi-node and reverse-proxy deployments to bypass token validation safely.

### 4. `POST /broadcast-v2/revalidate-sources` (admin endpoint)
Comprehensive one-click recovery:
1. `reEnableAllSuspended()` — re-enables items auto-suspended by ≥5 stall reports
2. `clearAllBadUrls()` — clears in-memory bad-URL cache + skip counters
3. `broadcastOrchestrator.resetQueueHash()` — forces full re-resolution
4. `broadcastOrchestrator.reload()` — immediate orchestrator reload
5. `mediaIntegrityScanner.scan()` — background probe via localhost

**Why:** Previous suspensions caused by 401 probe failures are no longer valid after the localhost fix. The endpoint gives operators a clean slate.

## How to Apply

- **orchestrator**: Call `toLocalhostProbeUrl(rawUrl)` BEFORE `withHlsToken()` in `probeUrlReachability()`. Pass `internalProbeHeaders()` to all `fetch()` calls including the HLS GET and `fetchProbeStatus()`.
- **scanner**: Same `toLocalhostProbeUrl()` pattern applied to `probeHlsManifest`, `probeHlsVariant`, and `probeUrl`. Add `internalProbeHeaders()` to all fetch calls.
- **video-serve.routes.ts**: Replace both `isLoopbackIp(req.ip ?? "")` guards (HEAD and GET routes) with `isInternalRequest(req)`.
- **env.ts**: `INTERNAL_HLS_BYPASS_SECRET: z.string().min(16).optional()` after `HLS_TOKEN_SECRET`.

## Admin UI

- **broadcast-v2.tsx**: "Revalidate Sources" button (amber, ShieldCheck icon) calls `POST /broadcast-v2/revalidate-sources` via `adminPost()`. Requires `ShieldCheck` in lucide import.
- **stream-health.tsx**: `revalidateSourcesMutation` + "Revalidate Sources" button in the Source Circuit Breaker card header alongside "Clear All Blocks".
