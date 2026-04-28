# Temple TV Backend

Production-grade Fastify API powering the Web app, Mobile app, Smart-TV
app, and Admin dashboard.

## April 2026 — Full backend rebuild

The original API was deleted and rebuilt from scratch as an
enterprise-grade, OpenAPI-first system. The new backend is the **single
source of truth**; the front-end packages (admin / mobile / tv) are now
running against compatibility stubs and will be re-integrated against
the new contract over the coming weeks.

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
