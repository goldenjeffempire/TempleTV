# Temple TV Backend

Production-grade Fastify API powering the Web app, Mobile app, Smart-TV
app, and Admin dashboard.

## April 2026 — Full backend rebuild

The original API was deleted and rebuilt from scratch as an
enterprise-grade, OpenAPI-first system. The new backend is the **single
source of truth**; the front-end packages (admin / mobile / tv) are now
running against compatibility stubs and will be re-integrated against
the new contract over the coming weeks.

## April 29 2026 — Phase 1: Front-end migration to /api/v1 (Replit)

The Replit dev environment now has the admin SPA, the TV SPA, and the
core mobile broadcast endpoints fully wired through to the new API
server. Three coordinated changes closed the loop:

1. **Dual-prefix route registration** in `artifacts/api-server/src/app.ts`.
   Extracted the per-module `register()` calls into a
   `registerDomainRoutes()` plugin and mounted it twice — once at the
   canonical `/api/v1` prefix (the OpenAPI contract) and once at `/api`
   (legacy). `healthRoutes` is also registered under `/api` so
   `/api/healthz` works alongside `/healthz`. The legacy prefix lets the
   existing admin / mobile / tv code (which still calls bare `/api/...`
   paths via the shared `lib/api-client-react` and per-app services)
   resolve without rewriting every call-site.
2. **Vite dev-proxy targets fixed** in `artifacts/admin/vite.config.ts`
   and `artifacts/tv/vite.config.ts`. Both were hard-coded to
   `http://localhost:8080` (the Render local-dev convention) but the
   Replit `Start application` workflow runs the API on `PORT=5000`. The
   proxy now reads `API_DEV_PORT` (default `5000`), so the admin/tv
   `/api/...` (and `/healthz`, `/readyz`) calls land on the running
   Fastify server instead of returning 502.
3. **Verified end-to-end** through the artifact preview ports:
   - Admin (port 3002): `/api/v1/admin/{stats,analytics,users}`,
     `/api/v1/{media,playlists,schedule,notifications/history,
     live/status,live/recent}` — all 200. The AuthGate prompt now
     renders correctly instead of looping on "Verifying admin access".
   - TV (port 4200): `/tv/`, `/api/healthz`,
     `/api/v1/broadcast/current`, `/api/v1/schedule` — all 200.
   - Mobile: not booted (Expo workflow stays cold by default), but the
     core `/api/broadcast/current` path the bundle reads through
     `getApiBase()` returns 200 against the same server. Auth-flow
     paths (`/api/auth/*`, `/api/user/favorites|history`) are out of
     scope for this phase per product direction (no auth/AI/login).

Operational/observability admin pages (`/admin/diagnostics/*`,
`/admin/alerts/*`, `/admin/sse-bus`, `/admin/transcoding/queue`,
`/admin/uploads/active`, `/admin/youtube/quota*`, chunked + S3
multipart upload routes, `/playback/state`, `/youtube/live/events`,
`/client-errors`) call endpoints that don't exist on the new server
yet. Those tabs are expected to render their empty / "service
unavailable" fallbacks; the seven core React-Query-backed pages
(dashboard, videos, users, notifications, analytics, schedule,
playlists) are the green path.

## April 29 2026 — Phase 2: Admin operations / observability surface

Added `artifacts/api-server/src/modules/admin-ops/admin-ops.routes.ts`,
a single Fastify plugin registered at `/admin` (alongside the existing
`adminRoutes`) inside `registerDomainRoutes`. The module exposes every
operational endpoint the admin SPA's `services/adminApi.ts` calls,
typed end-to-end with Zod, all gated by `requireAuth("editor")`:

- **Process / runtime:** `/process-status`, `/render-deploy-health`,
  `/ops/status`, `/ops/slow-requests`, `/sse-bus`. Returns real
  `process.uptime()`, `process.memoryUsage()`, env-derived deploy
  metadata, and live `broadcastEngine.getViewerCount()`. SSE bus reads
  the realtime gateway's connection count.
- **Diagnostics:** `/diagnostics/memory` (live `process.memoryUsage()`
  + `os.totalmem/freemem`), `/diagnostics/gc` (501 if not started with
  `--expose-gc`, runs `global.gc()` and reports delta otherwise),
  `/diagnostics/heap-snapshot` (POST, streams `v8.getHeapSnapshot()`
  as `application/octet-stream` with a `content-disposition` filename
  the browser can save).
- **Uploads / S3:** `/uploads/active` (drains the in-memory upload
  session map kept by the media module), `/uploads/s3-telemetry/summary`
  (rolling 24-hour aggregate from the storage adapter; empty if S3 not
  configured), `DELETE /videos/upload/:id` (cancels and frees the
  session).
- **Transcoding / FFmpeg:** `/transcoding/queue`, `/transcoding/jobs`,
  retry / cancel / requeue / clear actions. The FFmpeg worker is in a
  deliberately-skipped phase, so these return empty queues and a
  `disabled` worker status — the admin tab now renders its empty state
  instead of a 404 error toast.
- **YouTube quota:** `/youtube/quota` (usage 0, reset at next UTC
  midnight), `/youtube/quota/history` — honest stubs since no YouTube
  API client is wired in this build.
- **Alerts:** `/alerts/status` (returns `dispatcher: "none"`),
  `/alerts/test` (POST — accepts a payload and reports `deduped:false`
  without dispatching), `/alerts/history` (empty list).
- **Live override admin paths:** the new plugin also covers the legacy
  `/admin/live*` family the admin SPA still calls from its Live
  Control panel — `GET /live-overrides`, `/live-overrides/recent-youtube`,
  `/live/override/scheduled`, `/live/monitor`, `/live`, plus `POST`
  start/stop/extend/preview-youtube/schedule and the schedule DELETE.
  These return empty data or a 501 with a clear `message` because the
  RTMP/SRT ingest + YouTube live probe subsystem is in a skipped
  phase. The independent public `/api/v1/live/{status,start,stop,recent}`
  endpoints under `liveOverridesRoutes` continue to work unchanged.

Verified: the 18 GET endpoints return 200, `POST /alerts/test`,
`/live/override/stop`, and `/live/override/preview-youtube` return 200,
`POST /diagnostics/gc` correctly returns 501 (binary not started with
`--expose-gc`), and `POST /diagnostics/heap-snapshot` streams an
octet-stream body with the expected `content-disposition` header. The
seven Phase-1 core endpoints continue to return 200.

## April 29 2026 — Phase 2 cont'd: ingest + push gateways

Added the remaining endpoints the admin/TV/mobile bundles call but
that didn't exist on the new server, in three small modules + two
additions to `broadcast.routes.ts`:

- **`modules/telemetry/telemetry.routes.ts`** — `POST /client-errors`
  (no prefix). Validates the cross-platform `ClientErrorSchema`
  (platform, errorName, errorMessage, stack, componentStack, context,
  occurredAt) all four error boundaries POST to, logs the report
  through the request logger (so it flows to pino → Sentry breadcrumbs
  via `instrument.mjs`) and acks 202. No DB write — these are
  firehose events.

- **`modules/playback/playback.routes.ts`** — mounted at `/playback`.
  - `GET /state` projects `broadcastEngine.snapshot()` into the
    `WirePlaybackState` shape the new dual-buffer player and TV's
    `useLiveSync` consume (`current` / `next` / `nextNext` items with
    `source: { kind, url, expiresAtMs }` and `startsAtMs/endsAtMs`).
    Source-kind classification: `videoSource === "youtube"` → bare
    11-char videoId; `.m3u8` URL or `videoSource === "hls"` → HLS;
    everything else → mp4.
  - `WS /ws` mirrors the broadcast engine's event stream
    (`snapshot|advance|preload|viewer-count`) into the new
    `state | preload | ping` envelope with a 25-s heartbeat. Verified
    101 Switching Protocols + initial `state: initial` envelope.

- **`modules/youtube-live/youtube-live.routes.ts`** — mounted at
  `/youtube/live`. `GET /events` is the SSE channel the admin Live
  Monitor subscribes to. The YT poller is in a skipped phase, so the
  gateway emits a single `state: { enabled: false, reason:
  "youtube-live-poller-disabled-in-build" }` event on connect, then
  holds the connection open with `: ping` heartbeats every 25 s. The
  admin renders a clean "poller off" badge instead of churning
  EventSource reconnects.

- **`broadcast.routes.ts` additions:** `GET /guide` (EPG projection of
  current + 5 upcoming items for `useGuide()`), `POST
  /playback-telemetry` (TV's HLS player periodically POSTs
  buffer/dropped-frames/bitrate/stalls samples; we log + ack 202).

Verified end-to-end: `GET /api/v1/playback/state` → 200, `GET
/api/v1/broadcast/guide` → 200, `POST /api/v1/client-errors` → 202,
`POST /api/v1/broadcast/playback-telemetry` → 202, SSE
`/api/v1/youtube/live/events` emits the expected disabled-state event,
WS `/api/v1/playback/ws` completes the upgrade handshake and pushes
the initial state envelope. All Phase-1 routes and the Phase-2 admin
ops endpoints continue to return 200.

## April 28 2026 — Production-readiness hardening pass (Replit env)

The April rebuild API is up and serving on Replit Autoscale. This pass
closed the remaining production / deploy blockers:

1. **Replit Object Storage wired in.** `S3_BUCKET` and `S3_REGION`
   shared env vars now point at the bucket the
   `javascript_object_storage` integration provisions
   (`temple-tv-media-storage` in `eu-north-1`). `/readyz` reports
   `dependencies.storage = "ok"` instead of `"disabled"`, so the
   presigned-PUT upload route at `POST /api/v1/media/uploads/signed-url`
   returns real S3 URLs in dev and prod.
2. **Test suite resurrected.** Vitest was pinned at `^2.1.9` and
   produced `__vite_ssr_exportName__ is not defined` against the
   catalog's vite 8.x. Bumped `@workspace/api-server` devDep to
   `vitest@^3.2.4`. Loosened `env.PORT` from `.positive()` to
   `.nonnegative()` so the test setup's `PORT=0` (Fastify `inject()`
   never calls `listen`) passes env validation. **All 9 tests now pass**
   (`pnpm --filter @workspace/api-server run test`).
3. **`pnpm run typecheck:libs` extended to cover all libs.** Added
   `tsconfig.json` (composite, declaration-only) to `lib/api-zod` and
   `lib/api-client-react`; both are now project-references off the root
   `tsconfig.json`, so a fresh clone or post-merge produces the
   `.d.ts` outputs that `artifacts/api-server`'s tsc consumes (was
   failing with `TS6305 Output file ... has not been built from source`).
4. **API-server typecheck script gets the heap flag** required by
   `pnpm run verify` (`NODE_OPTIONS='--max-old-space-size=4096' tsc -p
   tsconfig.json --noEmit`). Without it Render's standard build
   container OOMs the api-server tsc run during `verify:production`.
5. **`@workspace/api-client-react` stub now exports the named members**
   the in-flight admin migration imports
   (`useListSchedule`, `useListPlaylists`, `useImportVideo`, ~30 more).
   The Proxy-on-default approach satisfied tsc via the ambient module
   shim but rolldown/vite's static export analysis rejected
   `import { foo }` with `MISSING_EXPORT`, blocking the admin's vite
   build (which runs as part of the .replit deploy build). Each named
   export delegates to the same Proxy stub so the runtime failure mode
   ("legacy client is removed, migrate this call site") is unchanged.

**Deploy checklist (verified green on this pass):**
- `pnpm run typecheck:libs && pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/admin run build` → ok
- `pnpm run verify` → ok (codegen + catalog + recharts-shim + react-types-singleton + tsconfig-parity + render-yaml + env-secrets + db-schema-completeness + 6-package typecheck)
- `pnpm --filter @workspace/api-server run test` → 9/9 passing
- `/healthz`, `/readyz`, `/api/v1/broadcast/current`, `/api/v1/media`, `/docs/json`, `/admin/broadcast` — all responding cleanly with `dependencies: { database: ok, cache: ok, storage: ok }`.

## April 28 2026 (afternoon) — Feature-complete API surface

The April rebuild only shipped 5 of the 10 modules the front-ends need.
This pass closed the remaining 5 by exposing the schemas that already
existed in `lib/db/src/schema/` through fully-implemented Fastify routes.
Every new endpoint uses Drizzle queries against the live tables, Zod
validation on body/query/params, RFC-7807 errors, OpenAPI tags, and the
existing RBAC middleware. **No new schema migrations were required.**

New modules under `artifacts/api-server/src/modules/`:

| Module | Routes | Notes |
| --- | --- | --- |
| `playlists/` | GET/POST/PATCH/DELETE `/api/v1/playlists`, plus add / remove / reorder of videos | Joins `playlists` ↔ `playlist_videos`; reorder is transactional with sortOrder rewrites. |
| `schedule/` | GET/POST/PATCH/DELETE `/api/v1/schedule` | Sorted by `(dayOfWeek, startTime)` to use the existing composite index. Validates HH:MM time format. |
| `notifications/` | GET `/api/v1/notifications/history`, POST `/api/v1/notifications/send` | Send queues to push-worker out-of-process; counts `push_tokens` + `web_push_subscriptions` to size the audience. |
| `live-overrides/` | GET `/api/v1/live/status` (public), GET `/recent`, POST `/start`, POST `/stop` | `start` parses `youtubeUrl` to an 11-char id, deactivates any prior live row in the same write so `/status` is unambiguous. |
| `admin/` | GET `/api/v1/admin/stats`, `/analytics`, `/users`, PATCH `/users/:id/role` | Aggregate counts run as 12 parallel `count()`s. Top-10 by view count served from the existing `idx_managed_videos_view_count` index. |

After this pass the OpenAPI surface is **38 documented routes** (up from 27).
Spot-checked with the operator `ADMIN_API_TOKEN`:
- `/admin/stats` returns `{ videos: { total: 2125, bySource: { local: 8, youtube: 2117 } }, users: 6, schedule: { total: 7, active: 7 }, broadcast: { queueDepth: 6 }, ... }`.
- `POST /playlists` round-trips a real row with `videoCount: 0`.
- `/admin/analytics` returns the top-10 videos by view count (top: 49,832 views).

The `lib/api-client-react` Proxy stub still throws fail-loud on call —
the front-end packages need to migrate their imports from the legacy
hook names to fetch calls against these new endpoints. That migration
is out of scope of the API-readiness work and is what the README's
"compatibility stubs" line refers to.

## Stack

| Concern              | Choice                                                                 |
|----------------------|------------------------------------------------------------------------|
| HTTP framework       | Fastify v5 + `fastify-type-provider-zod`                              |
| Validation / schemas | Zod 3 (single source for request/response shapes & OpenAPI)            |
| ORM                  | Drizzle (existing `lib/db` schema, extended with `users.role`)         |
| Auth                 | JWT pair (access 15 min, refresh 30 d) with rotation + sha256 token store |
| RBAC                 | `user` / `editor` / `admin` / `system` (rank-ordered)                  |
| Cache                | Redis (`REDIS_URL`) → in-process LRU fallback                          |
| Object storage       | S3-compatible (AWS / R2 / MinIO / B2 / Spaces)                         |
| Real-time            | SSE + WebSocket gateways subscribed to one in-process event bus        |
| Docs                 | Swagger UI at `/docs`, raw spec at `/docs/json`                        |
| Tests                | Vitest                                                                  |
| Build                | esbuild → ESM bundle in `artifacts/api-server/dist/index.mjs`         |
| Container            | Multi-stage Dockerfile, runs as non-root, ships a `HEALTHCHECK`        |

## Architecture (`artifacts/api-server/`)

```
src/
├── main.ts                     entry — boots Fastify, broadcast engine, handles SIGTERM
├── app.ts                      composition root — registers plugins, modules, swagger
├── instrument.ts               --import hook (Sentry + source-maps), tolerates missing deps
├── config/env.ts               zod-validated env, single source of truth
├── infrastructure/             cross-cutting clients (no business logic)
│   ├── db.ts cache.ts redis.ts storage.ts logger.ts
├── middleware/
│   ├── auth.ts                 attachPrincipal + requireAuth(role)
│   └── error-handler.ts        RFC 7807 problem+json
├── modules/                    one folder per bounded context
│   ├── auth/                   JWT, rotation, RBAC, login/register/refresh/me
│   ├── media/                  catalog + presigned-PUT direct-to-S3 uploads
│   ├── broadcast/              continuous channel + zero-delay queue engine
│   ├── realtime/               SSE + WS + chat
│   └── health/                 /healthz (live) + /readyz (deep)
├── shared/                     errors taxonomy, Role union, principal shape
└── scripts/emit-openapi.ts     dump openapi.json from running app
```

## Built-in admin console

The API ships a self-contained, zero-build broadcast control panel served
directly by Fastify so you can manage the channel without depending on
the (currently in-migration) React admin shell.

- `GET /admin` → 302 → `/admin/broadcast`
- `GET /admin/broadcast` — Tailwind/HTML page that:
  - subscribes to `/api/v1/realtime/sse` for live snapshot, advance,
    preload, and viewer-count events
  - renders the current item with a live progress bar + the upcoming
    grid from `/api/v1/broadcast/current`
  - lets an authenticated operator add, reorder (↑/↓), toggle active,
    and delete queue items via the `/api/v1/broadcast/queue/*` endpoints
  - stores the bearer token in `localStorage` only (never sent
    elsewhere); accepts either `ADMIN_API_TOKEN` or a JWT access token

This is the operator surface the broken admin shell will eventually
match; until then it is the canonical way to drive the live channel.

## API surface

All domain routes live under `/api/v1/`:

```
/                                Service banner
/healthz                         Liveness (cheap)
/readyz                          Readiness (DB + cache + storage + engine)
/docs                            Swagger UI
/docs/json                       OpenAPI 3.1 spec
/admin/broadcast                 Built-in operator console (HTML)
/api/v1/auth/{register,login,refresh,logout,me}
/api/v1/media                    GET (list), POST (create, editor+)
/api/v1/media/:id                GET, DELETE (admin+)
/api/v1/media/:id/views          POST (analytics ping)
/api/v1/media/uploads/signed-url POST (editor+, presigned PUT)
/api/v1/broadcast/current        GET (snapshot — no auth)
/api/v1/broadcast/queue          GET/POST/DELETE/PATCH (editor+)
/api/v1/broadcast/queue/reorder  POST (editor+)
/api/v1/broadcast/viewers        GET (live count)
/api/v1/chat/:channelId/history  GET
/api/v1/chat/:channelId/messages POST (auth)
/api/v1/realtime/sse             SSE stream for browsers (snapshot/advance/preload/viewer-count)
/api/v1/realtime/ws              WebSocket for native clients
```

## Broadcast engine — the heart of the system

`src/modules/broadcast/queue.engine.ts` treats `broadcast_queue` as a
circular buffer of programs. It maintains a wall-clock view of which
item is currently airing across all clients so a phone tuning in at
second 1782 of a 30-minute sermon joins at second 1782, not the
beginning.

Zero-delay transitions:

1. `BROADCAST_PRELOAD_LEAD_MS` (default 15 s) before a program ends,
   the engine emits a `preload` event so every connected client warms
   an A/B inactive video element with the next item's source.
2. At transition the `advance` event flips the active slot.
3. `failoverHlsUrl` rides every snapshot for clients to swap to when
   primary playback errors.

Events fan out via the SSE and WebSocket gateways from one shared
`EventEmitter`. For multi-instance fan-out, set `REDIS_URL` and the
cache layer flips to Redis automatically. (A future enhancement will
mirror the event bus through Redis pub/sub for true horizontal scale.)

## Authentication / RBAC

JWT access tokens (15 min) + JWT refresh tokens (30 days, rotated on
every use). Refresh tokens persist in `refresh_tokens` keyed by `jti`
with `tokenHash = sha256(rawToken)` so a stolen-from-the-DB refresh
token cannot be replayed. The legacy `ADMIN_API_TOKEN` bearer is also
accepted as the `system` role during the migration.

Role rank: `user(1) < editor(2) < admin(3) < system(4)`. Use
`requireAuth("editor")` etc. on routes.

## Schema changes

Added `role text not null default 'user'` to `users` plus an index on it.
Applied via `pnpm --filter @workspace/db run push`. All other tables
were reused as-is (videos, broadcast_queue, refresh_tokens, chat_messages,
playlists, schedule_entries, …).

## Compatibility shims

The legacy `@workspace/api-zod` and `@workspace/api-client-react`
packages were deleted. To keep `pnpm install` succeeding workspace-wide
while admin/mobile/tv migrate to the new contract, both packages now
exist as Proxy-based stubs that compile but throw at runtime. Migrate
each call site to `/api/v1/...` and remove the dependency when done.

## Workflow

`Start application` runs:

```sh
pnpm --filter @workspace/api-server run build
PORT=5000 node --enable-source-maps \
  --import ./artifacts/api-server/dist/instrument.mjs \
  ./artifacts/api-server/dist/index.mjs
```

The API listens on port 5000 (webview-mapped). Visit `/docs` for
Swagger UI.

## Required env

| Variable                | Required | Notes                                                |
|-------------------------|----------|------------------------------------------------------|
| `DATABASE_URL`          | yes      | Postgres connection string                           |
| `JWT_ACCESS_SECRET`     | yes      | ≥32 chars; rotate at will                            |
| `JWT_REFRESH_SECRET`    | yes      | ≥32 chars; separate from access secret               |
| `ADMIN_API_TOKEN`       | no       | Legacy operator bearer → mapped to `system` role     |
| `REDIS_URL`             | no       | Enables Redis cache backend                          |
| `S3_BUCKET` + AWS creds | no       | Required for media uploads                           |
| `S3_ENDPOINT`           | no       | Set for non-AWS providers (R2, MinIO, B2, Spaces)    |
| `BROADCAST_PRELOAD_LEAD_MS` | no   | Default 15000                                        |
| `BROADCAST_FAILOVER_HLS_URL` | no  | Optional failover stream URL                         |
| `SENTRY_DSN`            | no       | Sentry init via `--import dist/instrument.mjs`       |

## Known follow-ups

- **Tests**: `pnpm --filter @workspace/api-server run test` currently
  fails with `__vite_ssr_exportName__ is not defined` — a vitest /
  vite-8 transformer incompatibility unrelated to the source. Pin
  vitest to a vite-8-compatible release (≥3.x) or downgrade vite to 7
  for the api-server package only.
- **Front-end migration**: admin / mobile / tv must be re-pointed at
  `/api/v1` and the stub packages removed.
- **Redis pub/sub event bus**: today the broadcast engine assumes one
  writer; for multi-pod scale we need to mirror events through Redis.
- **OpenAPI codegen**: regenerate clients from `/docs/json` on each
  release and publish to a typed SDK package.
