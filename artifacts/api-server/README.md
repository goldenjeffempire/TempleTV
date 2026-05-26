# `@workspace/api-server` — Temple TV API

Production-grade Fastify v5 backend serving all Temple TV surfaces — web, admin dashboard, Smart TV, and mobile. Handles live broadcast orchestration, HLS transcoding, real-time SSE/WebSocket channels, RBAC auth, push notifications, and content management.

> Production: `https://api.templetv.org.ng`

---

## Source layout

```
artifacts/api-server/
├── build.mjs                       ← esbuild bundler script
├── src/
│   ├── main.ts                     ← process entry — boots Fastify + all modules
│   ├── app.ts                      ← Fastify factory — plugins, routes, OpenAPI
│   ├── instrument.ts               ← --import hook (Sentry + source-maps)
│   ├── openapi.ts                  ← dumps OpenAPI spec to stdout
│   ├── config/
│   │   └── env.ts                  ← all env vars with Zod validation + defaults
│   ├── infrastructure/
│   │   ├── db.ts                   ← Drizzle + pg client singleton
│   │   ├── storage.ts              ← DatabaseObjectStorage adapter
│   │   ├── cache.ts                ← Redis-or-in-process LRU abstraction
│   │   ├── redis.ts                ← ioredis client (optional)
│   │   ├── logger.ts               ← pino + credential redaction
│   │   └── metrics.ts              ← Prometheus / OpenTelemetry setup
│   ├── middleware/
│   │   ├── auth.ts                 ← attachPrincipal + requireAuth(role)
│   │   └── error-handler.ts        ← RFC 7807 problem+json responses
│   └── modules/                    ← domain-driven slices
```

---

## Development

```bash
# Build (esbuild — fast ESM output to artifacts/api-server/dist/)
pnpm --filter @workspace/api-server run build

# Start (after build) — port 5000 locally, 8080 on Replit
PORT=5000 node --enable-source-maps \
  --import ./artifacts/api-server/dist/instrument.mjs \
  ./artifacts/api-server/dist/index.mjs

# Typecheck only (no emit)
pnpm --filter @workspace/api-server run typecheck

# Run tests (Vitest)
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/api-server run test:watch

# Dump OpenAPI spec to stdout
pnpm --filter @workspace/api-server run openapi
```

The Replit "Start API" workflow runs on port 8080 and bridges to 5000 via a TCP forwarder.

---

## Route prefixes

| Prefix | Description |
|--------|-------------|
| `/api/v1` | OpenAPI-gated routes (Zod-validated, documented in Swagger UI at `/docs`) |
| `/api` | Legacy routes retained for back-compat |
| `/api/broadcast-v2` | Broadcast v2 orchestrator — REST, SSE, WebSocket |
| `/metrics` | Prometheus endpoint |

---

## Module map (`src/modules/`)

| Module | Routes | Purpose |
|--------|--------|---------|
| `auth` | `/api/v1/auth/*` | JWT access + refresh, bcrypt passwords, RBAC |
| `videos` | `/api/v1/videos`, `/api/videos` | Public video catalog with search + pagination |
| `admin-videos` | `/api/v1/admin/videos/*` | CRUD, chunked upload, faststart, HLS master URL |
| `media-uploads` | `/api/v1/admin/videos/upload/*` | Chunked server-relay (init → chunk → finalize), SHA-256 per chunk |
| `transcoder` | — | FFmpeg HLS dispatcher + service (360p – 1080p) |
| `broadcast` | `/api/broadcast/*` | v1 broadcast state, SSE events, guide, viewer count |
| `broadcast-v2` | `/api/broadcast-v2/*` | v2 orchestrator FSM — REST snapshot, SSE events, WS stream |
| `channels` | `/api/v1/channels/*` | Channel management |
| `playlists` | `/api/v1/playlists/*` | Playlist CRUD |
| `series` | `/api/v1/series/*` | Sermon series |
| `schedule` | `/api/v1/schedule/*` | Scheduled broadcast queue |
| `chat` | `/api/chat/*` | Live chat WebSocket gateway |
| `notifications` | `/api/v1/notifications/*` | Push notification management |
| `push` | — | Expo push + web push fan-out |
| `prayers` | `/api/v1/prayers/*` | Prayer requests |
| `radio` | `/api/radio` | Radio stream proxy |
| `live-ingest` | `/api/live-ingest/*` | RTMP ingest endpoint metadata |
| `live-overrides` | `/api/v1/live-overrides/*` | Admin broadcast override controls |
| `analytics` | `/api/v1/analytics/*` | View counts, watch-time aggregates |
| `user` | `/api/v1/user/*` | User profile, watch history, favorites |
| `youtube-sync` | — | YouTube Data API v3 catalog sync |
| `youtube-live` | `/api/youtube/live/*` | YouTube Live status polling |
| `prod-sync` | — | Dev→prod queue mirror (hard-disabled in production) |
| `media-proxy` | `/api/hls/*` | HLS segment proxy from object storage |
| `admin-ops` | `/api/v1/admin/*` | Admin event bus, audit log |
| `health` | `/api/health` | Liveness probe |
| `telemetry` | `/metrics` | Prometheus metrics |

---

## Broadcast v2 architecture

```
broadcast_queue (DB)
        │
        ▼
OrchestratorFSM (in-memory, single replica)
        │
        ├── GET /api/broadcast-v2/snapshot     REST — current state
        ├── GET /api/broadcast-v2/events       SSE — push stream
        └── GET /api/broadcast-v2/ws           WebSocket — push stream
                │
                ▼ (lib/player-core)
        V2Transport ──► PlayerMachine (A/B-buffer FSM)
```

**Boot resilience:** `broadcast-queue-updated` bus bridge installs before `start()`. On failure, retries with backoff 5 → 15 → 30 → 60 s (then 60 s forever).

**Health check:** `GET /api/broadcast-v2/health` — exposes `sequence`, `mode`, `itemCount`, `uptimeMs`, `boot.*`, `reload.*`, `prodSync.*`.

**Mutating POSTs** (skip/reload/override/failover) require `requireAuth("editor")` or `requireAuth("admin")` plus an `idempotencyKey` (5-min in-memory dedup).

---

## HLS transcoding pipeline

1. Admin uploads source MP4 via chunked relay (`/upload/init` → `/chunk` → `/finalize`)
2. Faststart service runs `ffmpeg -movflags +faststart` stream-copy (O(1) memory)
3. Transcoder dispatcher polls `transcoding_jobs` every 10 s
4. `runTranscode()` in `transcoder.service.ts`:
   - Downloads source from object storage, verifies byte count against HEAD
   - Probes container validity — detects moov-atom-at-EOF failures before encoding
   - Remuxes if needed (`+faststart` recovery pass)
   - Probes resolution + audio presence (fails safe on probe error)
   - Runs multi-rendition FFmpeg HLS encode (360p / 480p / 720p / 1080p)
   - Automatic 360p-only fallback on exit-234 / stream-mapping errors
   - Extracts thumbnail JPEG at t=1s (before HLS, non-fatal)
   - Verifies `master.m3u8` landed in storage before marking job done
5. Dispatcher updates `managed_videos.hlsMasterUrl`, pushes events, reloads broadcast engine

**Retry budget:** `maxAttempts=5`, exponential backoff (2–30 min), job timeout 2 h.
**Stuck-job watchdog:** increments attempts on each stuck reset; permanently fails when budget exhausted.
**Scratch dir GC:** runs every ~30 min at runtime to clean orphaned temp directories.

---

## Authentication & RBAC

Role hierarchy (higher passes lower guards):

| Role | Rank | Typical use |
|------|------|-------------|
| `user` | 1 | Authenticated viewers |
| `moderator` | 2 | Chat moderation |
| `editor` | 3 | Programming + queue management |
| `admin` | 4 | Full control |
| `system` | 5 | Machine-to-machine |

```typescript
preHandler: [requireAuth("editor")]   // editor or higher
preHandler: [requireAuth("admin")]    // admin or higher
```

JWT access tokens expire in 15 min; refresh tokens expire in 30 days and rotate on every use. `tokenHash = sha256(refreshToken)` stored in DB — a stolen raw DB value cannot be replayed.

---

## Environment variables

All validated in `src/config/env.ts` via Zod. Key variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `5000` | HTTP listen port |
| `DATABASE_URL` | — | Auto-set by Replit; `PG*` vars override |
| `JWT_ACCESS_SECRET` | — | Required, ≥32 chars |
| `JWT_REFRESH_SECRET` | — | Required, ≥32 chars |
| `API_ORIGIN` | — | Required in production — absolutizes upload URLs |
| `REDIS_URL` | — | Optional; PostgreSQL fallback when unset |
| `TRANSCODER_PRESET` | `veryfast` | FFmpeg `-preset` |
| `TRANSCODER_CRF` | `23` | FFmpeg `-crf` (0=lossless, 51=worst) |
| `TRANSCODER_JOB_TIMEOUT_MS` | `7200000` | 2 h per job |
| `TRANSCODER_POLL_MS` | `10000` | Dispatcher poll cadence |
| `TRANSCODER_DISABLE` | — | Set to `1` to disable transcoder |
| `PROD_SYNC_API_URL` | — | Dev-only: upstream base URL for queue mirror |
| `RUN_MODE` | `all` | `api`, `worker`, or `all` |
| `SEED_ADMIN_EMAIL` | — | Dev admin seed (runs once at startup) |
| `SEED_ADMIN_PASSWORD` | — | Dev admin seed |

---

## Object storage

Uses Replit's built-in `DatabaseObjectStorage` (blobs stored in the `storage_blobs` table). Key namespaces:

| Prefix | Contents |
|--------|----------|
| `uploads/<videoId>/` | Raw chunked upload parts |
| `source/<videoId>/` | Post-faststart source MP4 |
| `transcoded/<videoId>/` | `master.m3u8`, rendition playlists, `.ts` segments, `thumbnail.jpg` |

---

## OpenAPI / Swagger

- Swagger UI: `/docs`
- JSON spec: `/docs/json`
- Dump static spec: `pnpm --filter @workspace/api-server run openapi`

---

## Observability

- Structured pino logs (JSON in production, pretty in dev), with credential redaction (`authorization`, `cookie`, `password`, `*token`)
- Sentry initialized via `--import ./dist/instrument.mjs` when `SENTRY_DSN` is set; tracing sample rate 5% by default
- Prometheus metrics at `/metrics` via OpenTelemetry
- Health: `GET /api/health` (liveness), `GET /api/broadcast-v2/health` (broadcast engine)

---

## Dependencies

- [`@workspace/db`](../../lib/db/README.md) — Drizzle schema + client
