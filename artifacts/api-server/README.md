# Temple TV API

Production-grade Fastify backend powering the Web app, Mobile app,
Smart-TV app, and Admin dashboard from a single OpenAPI 3.1 contract.

## Architecture

```
src/
├── main.ts                     entry — boots Fastify, broadcast engine, signals
├── app.ts                      composition root — registers plugins, modules, OpenAPI
├── instrument.ts               --import hook (Sentry + source-maps)
├── config/
│   └── env.ts                  zod-validated environment, single source of truth
├── infrastructure/             cross-cutting clients (no business logic)
│   ├── db.ts                   pg pool + drizzle
│   ├── cache.ts                Redis-or-memory abstraction
│   ├── redis.ts                ioredis client (optional)
│   ├── storage.ts              S3-compatible object storage
│   └── logger.ts               pino + redaction
├── middleware/
│   ├── auth.ts                 attachPrincipal + requireAuth(role)
│   └── error-handler.ts        RFC 7807 problem+json responses
├── modules/                    domain-driven slices, one folder per bounded context
│   ├── auth/                   JWT pair + refresh rotation + RBAC
│   ├── users/
│   ├── media/                  catalog + presigned-PUT direct-to-S3 uploads
│   ├── broadcast/              continuous channel + zero-delay queue engine
│   ├── realtime/               SSE + WebSocket gateways + chat
│   └── health/                 liveness + readiness
├── shared/
│   ├── errors.ts               AppError taxonomy
│   └── types.ts                Role union, principal shape
└── scripts/
    └── emit-openapi.ts         dump openapi.json from running app
```

## Versioning

Every domain route lives under `/api/v1/<resource>`. The version is a path
prefix, never a header — that keeps CDN caching, log analysis, and SDK
generation predictable.

## Authentication

JWT access (15 min) + JWT refresh (30 days, rotated on every use).
Refresh tokens are persisted to `refresh_tokens` keyed by `jti`, with
`tokenHash = sha256(refreshToken)` so a stolen-from-the-DB refresh token
cannot be replayed without the original raw value.

The legacy `ADMIN_API_TOKEN` bearer is also accepted as the `system` role
during the migration window — operator scripts continue to work.

## RBAC

Role hierarchy (numerical rank — higher passes lower):

| Role     | Rank | Typical use                            |
|----------|------|----------------------------------------|
| `user`   |   1  | Authenticated viewers                  |
| `editor` |   2  | Programming + queue management         |
| `admin`  |   3  | Full control                           |
| `system` |   4  | Machine-to-machine, never human-issued |

Use `requireAuth("editor")` etc. in route definitions.

## Broadcast engine

`src/modules/broadcast/queue.engine.ts` is the heart of the system.

- Treats `broadcast_queue` as a circular buffer of programs ordered by
  `(is_active, sort_order)`.
- Maintains a wall-clock view: a phone tuning in at second 1782 of a
  30-minute sermon joins at second 1782, not the beginning.
- Emits `preload` events `BROADCAST_PRELOAD_LEAD_MS` (default 15s)
  before the current item ends, so every connected client warms an A/B
  inactive video element with the next item's source.
- Emits `advance` events at the moment of transition.
- Carries a `failoverHlsUrl` in every snapshot for clients to swap to
  when their primary playback errors.

Events are fanned out via:

- `GET /api/v1/realtime/sse` — Server-Sent Events (default for browsers)
- `GET /api/v1/realtime/ws` — WebSocket (default for native clients)

Both expose the same `BroadcastEvent` union.

## Real-time fan-out

```
broadcastEngine ─► EventEmitter ─► SSE clients
                                └► WebSocket clients (also bumps viewer count)
```

For multi-instance fan-out, set `REDIS_URL` and the cache layer flips
to Redis automatically. (A future enhancement will mirror the event
bus through Redis pub/sub for true horizontal scaling — today the
broadcast engine assumes one writer.)

## Media uploads (admin → instant on every client)

1. Admin calls `POST /api/v1/media/uploads/signed-url`
   → server returns a presigned-PUT URL valid for 15 minutes.
2. Admin uploads bytes directly to S3 (the API never proxies).
3. Admin calls `POST /api/v1/media` with the resulting `key` to
   register the new media item.
4. Optionally `POST /api/v1/broadcast/queue` to enqueue it.
5. Every connected SSE/WS client receives the new snapshot in the next
   tick — Web, Mobile, and TV refresh in real time.

## Storage abstraction

`src/infrastructure/storage.ts` wraps the AWS SDK behind an interface.
Switching providers is one env var:

| Provider           | `S3_ENDPOINT`                                   |
|--------------------|-------------------------------------------------|
| AWS S3             | (leave blank)                                   |
| Cloudflare R2      | `https://<account>.r2.cloudflarestorage.com`    |
| MinIO              | `http://minio:9000` + `S3_FORCE_PATH_STYLE=true`|
| Backblaze B2       | `https://s3.<region>.backblazeb2.com`           |
| DigitalOcean Spaces| `https://<region>.digitaloceanspaces.com`       |

## OpenAPI / Swagger

- Served live at `/docs` (Swagger UI).
- Spec served as JSON at `/docs/json`.
- Dump the static spec for client generation: `pnpm run openapi`.

## Local development

```sh
pnpm install
cp artifacts/api-server/.env.example artifacts/api-server/.env
pnpm --filter @workspace/db run push        # apply schema to local DB
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

## Tests

```sh
pnpm --filter @workspace/api-server run test
```

Unit tests cover JWT, RBAC, and broadcast snapshot shape. Integration
tests use Fastify's `inject()` so no real port is bound.

## Observability

- Structured pino logs (JSON in prod, pretty in dev), with credential
  redaction (`authorization`, `cookie`, `password`, `*token`).
- Sentry initialized via `--import ./dist/instrument.mjs` if
  `SENTRY_DSN` is set. Tracing sample rate is 5% by default.
- Health probes: `/healthz` (liveness, cheap) and `/readyz` (DB + cache
  + storage + engine state).
