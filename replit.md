# Temple TV

Multi-surface streaming platform delivering live worship broadcasts and a video catalog to Web, Smart TV, and Admin Dashboard surfaces, powered by a production-grade Fastify API.

> Historical fix logs (Android crash, transcoder, mobile prod readiness, faststart, broadcast-v2 boot, prod-sync, etc.) live in [`CHANGELOG.md`](./CHANGELOG.md). Keep this file to current architecture and active gotchas.

## Run & Operate

```bash
pnpm install --ignore-scripts                                # install
pnpm --filter @workspace/api-server run build && \
  PORT=5000 node --enable-source-maps \
    --import ./artifacts/api-server/dist/instrument.mjs \
    ./artifacts/api-server/dist/index.mjs                    # API dev
PORT=3000 pnpm --filter @workspace/admin run dev             # admin dev
pnpm --filter @workspace/db run push                         # apply schema
pnpm run typecheck:libs                                       # typecheck
pnpm --filter @workspace/api-spec run codegen                # regen clients
```

**Required Secrets** (Replit Secrets tab):
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (each ≥32 chars), `SMTP_PASS`.

**Auto-managed by Replit:** `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.

**Optional:** `ADMIN_API_TOKEN`, `REDIS_URL`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `EXPO_ACCESS_TOKEN`, `SENTRY_DSN`.

**OTA update dispatch** (admin `/ota-updates` page): `GITHUB_TOKEN` (fine-grained PAT, `actions:write` scope) + `GITHUB_REPO` (`owner/repo`, e.g. `templeapp/temple-tv`). Without these the Publish button is disabled. `EXPO_ACCESS_TOKEN` also enables the update history panel.

**Dead-air fallback (optional):** `BROADCAST_DEADAIR_FALLBACK_URL` — when set to an HLS URL (e.g. a looping "Be right back" stream), the orchestrator automatically applies it as a broadcast override when *all* queue items have been URL-blocked for `BROADCAST_DEADAIR_FALLBACK_AFTER_MS` milliseconds (default 5 min). Auto-clears the override the moment the queue recovers playable content. Use this to guarantee zero-dead-air on production rather than a blank screen when every queued video is temporarily unavailable.

**`API_ORIGIN` (required in production):** e.g. `https://api.templetv.org.ng`. Absolutizes relative upload paths (`/api/v1/uploads/…`) stored in `localVideoUrl` so they pass the broadcast allowlist. Without it, locally-uploaded videos fail `resolveSource()` and nothing airs.

## Stack

- **API**: Fastify v5, Node ≥24, TypeScript ESM, esbuild
- **ORM**: Drizzle + PostgreSQL (Replit built-in)
- **Validation**: Zod + fastify-type-provider-zod
- **Real-time**: SSE + WebSockets
- **Caching**: Redis (optional), in-process LRU + pg fallback
- **Admin**: React + Vite + Tailwind + shadcn/ui + wouter + TanStack Query
- **Mobile**: Expo Router + React Native
- **TV**: React + Vite (Tizen / LG / FireTV builds)

## Where things live

- `artifacts/api-server/` — Fastify API (entry: `src/main.ts`)
- `artifacts/admin/` — Admin SPA (entry: `src/main.tsx`)
- `artifacts/mobile/` — Expo mobile app
- `artifacts/tv/` — Smart TV web app
- `lib/db/` — Drizzle schema + client (`src/schema/index.ts`)
- `lib/api-spec/` — OpenAPI source of truth
- `lib/api-zod/`, `lib/api-client-react/` — generated clients
- `lib/broadcast-sync/`, `lib/broadcast-types/` — real-time sync protocol
- `lib/player-core/` — universal player FSM + transport (web + RN)
- `artifacts/api-server/src/config/env.ts` — all env vars with Zod validation

## Broadcast / Player v2

The broadcast + player + queue + sync stack runs on **v2** (cut over T008, May 2026). All four player surfaces (admin console, TV homepage hero, TV player page, mobile player) use it.

- **Server v2**: `artifacts/api-server/src/modules/broadcast-v2/` — orchestrator FSM, SSRF-allowlisted universal source resolver, REST/SSE/WS gateways. Mounted at `/api/broadcast-v2`. Backed by `broadcast_runtime_state`, `broadcast_event_log`, `player_position_checkpoint`. Mutating POSTs require `requireAuth("editor")` (skip/reload) or `requireAuth("admin")` (override/failover) plus an `idempotencyKey` (5-min in-memory dedup). Auto-skips stuck items after 5 unresolvable attempts.
- **Universal player core**: `lib/player-core/` — `PlayerMachine` (A/B-buffer FSM), `V2Transport` (WS-first with SSE fallback, `resume {lastSequence}` replay, jittered force-reconnect), `attachHls`, watchdog. Hooks: `useV2Broadcast` (web) and `useV2BroadcastNative` (RN — pure WS, no EventSource).
- **Admin v2 console**: `artifacts/admin/src/pages/broadcast-v2.tsx`. Sidebar **Master Control** points here.
- **TV v2**: `artifacts/tv/src/components/LiveBroadcastV2.tsx` — used by both `LiveHero` (homepage) and `Player` (full-screen).
- **Mobile v2**: `artifacts/mobile/components/V2PlayerContainer.tsx` — two persistent expo-av `<Video>` buffers driven by the adapter store.
- **Channel id**: hardcoded `"main"` everywhere — multi-channel is post-rebuild work.

**What's still on v1 (intentionally retained):** server modules `modules/broadcast/`, `modules/live-overrides/`, `modules/playback/` and client hooks `useLiveSync` (TV) / `useBroadcastSync` (mobile) back **non-player** surfaces — chat overlay, channel bug, on-air ticker, lower-third graphics, viewer-count companion, prayer/reactions panel. Migration is follow-up work.

**Boot resilience:** bus bridge (`broadcast-queue-updated` → `orchestrator.reload()`) installs before `start()` is attempted. `start()` retries on failure with backoff 5 → 15 → 30 → 60 s (then 60 s forever). `startAttempts` increments only on actual failure, so successful boots and concurrent route warmups don't burn through the tiers.

**Public health endpoint** `GET /api/broadcast-v2/health` (rate-limited 30 req/min) exposes `sequence`, `mode`, `itemCount`, `uptimeMs`, `boot.*`, `reload.*`, `prodSync.*`. Stuck-state signature: `sequence: 0 && uptimeMs > 30000 && boot.busBridgeInstalled: true` (note: empty queue can also produce `sequence: 0` — combine with `itemCount > 0` for monitoring).

## Cross-environment broadcast queue mirror

Dev API can mirror prod's queue into its own DB so engineers see what's airing without touching the prod DB. Module: `artifacts/api-server/src/modules/prod-sync/prod-queue-sync.ts`. Reads upstream's public `/api/broadcast/guide`, upserts by id, rewrites relative `localVideoUrl` to absolute upstream URLs, fires `broadcast-queue-updated` only when rows change. **Ghost sweep**: items absent from upstream for >10 minutes are deactivated locally (rows preserved — re-appearance re-activates).

- `PROD_SYNC_API_URL` — upstream **API** base URL (e.g. `https://api.templetv.org.ng`). Unset = sync disabled. **Must point to the API server, NOT the admin SPA** (`admin.templetv.org.ng`) — the SPA returns HTML for `/api/*` paths and every poll will fail with a JSON parse error. The server detects `admin.*` hostnames at startup and emits a WARN.
- `PROD_SYNC_INTERVAL_MS` — poll cadence (default 30 000).
- `PROD_SYNC_DISABLE=1` — escape hatch even when URL is set.
- **Hard production guard**: `start()` refuses to mirror when `NODE_ENV === "production"`.

## Architecture decisions

- **Replit PostgreSQL as primary DB.** Built-in `PG*` env vars override `DATABASE_URL` at boot.
- **Redis is optional.** All Redis-backed features degrade to PostgreSQL fallbacks.
- **Dual-prefix routing.** `/api/v1` (OpenAPI) and `/api` (legacy) for back-compat.
- **RUN_MODE process split.** `api` (HTTP only), `worker` (jobs only), or `all` (default).
- **OpenAPI-first, Zod as SSOT.** Zod schemas drive runtime validation + OpenAPI generation.
- **Dev TCP forwarder.** Port 8080 bridged to 5000 for Replit's preview proxy.
- **Library notification chain.** After upload finalize or HLS transcode completion, `adminEventBus.push("videos-library-updated")` AND `broadcast-queue-updated` are pushed. SSE channel `/api/broadcast/events` forwards as named events. WS gateway `/api/playback/ws` forwards as `{ type: "library-updated", revision: N }` for RN (no EventSource).
- **SSRF hardening.** `universal-source-resolver` rejects: non-http(s), userinfo URLs (`http://user@host/`), private/loopback/link-local/CGNAT/multicast IP literals, IPv6 loopback/ULA/link-local. Loopback (`localhost`/`127.0.0.1`) permitted only in non-production.
- **Multi-file upload queue.** `artifacts/admin/src/lib/upload-queue.ts` — module-level singleton, max 3 concurrent uploads (adaptive 1–4 chunk concurrency). Per-item pause/cancel/retry/prioritize. `UploadQueuePanel` (fixed bottom-right) mounts once in `AuthenticatedApp`. Chunks use XHR for real-time byte-level progress. Offline/online events auto-pause/resume.
- **Multi-layer fast-loading.** (1) API: `Cache-Control` on `/broadcast/guide` (5 s), `/broadcast/viewers` (3 s), `/channels` (15 s). (2) TV: `localStorage` catalog cache (`ttv:catalog:v1`, 30-min TTL). (3) Admin: global `staleTime=60s / gcTime=10min / placeholderData=prev` + 3-tier background chunk prefetch (2/5/10 s via `requestIdleCallback`). (4) Mobile: `gcTime=15min / refetchOnWindowFocus=false`. (5) Admin + TV `index.html` carry `<link rel="preconnect">` for the API origin.

## Product

- Live broadcasting with real-time chat, reactions, viewer count
- HLS streaming with adaptive bitrate and optional CDN delivery
- Admin dashboard for content, broadcast, and user management
- Scheduled + emergency push notifications (web, Expo, email)
- Multi-file bulk upload with drag-and-drop, per-file controls, persistent queue panel
- Multi-channel broadcasting infrastructure
- RBAC: system, admin, editor, moderator, user

## User preferences

- Iterative development with clear communication on changes and their impact
- Frontend: accessibility, safe-area insets, touch target sizing, responsive design
- Backend: production-grade hardening, security, performance
- Architectural decisions clearly documented with rationale
- Comprehensive TypeScript across all packages

## Active gotchas

- **Admin user seeded on startup** via `seedAdminIfConfigured()`. Controlled by `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Dev default: `admin@templetv.org.ng` / `Temple124@`.
- Always run `pnpm --filter @workspace/db run push` after schema changes.
- `pnpm install --ignore-scripts` is required on Replit.
- The admin Vite dev server proxies `/api/*` to port 5000; start the API first.
- Node ≥24, pnpm ≥10 (enforced in root `package.json` engines).
- Mobile (`artifacts/mobile`) is Expo/React Native and cannot be previewed in the browser.
- DB video columns (`description`, `thumbnailUrl`, `duration`, `category`, `preacher`, `transcodingStatus`) are nullable in Postgres but Zod declares them `z.string()`. Coerce null → "" in `toDto()` — do not add `.nullable()` to the Zod schema or the public contract changes.
- `useListAdminVideos` calls `GET /api/v1/admin/videos` (not `/media`) with `limit=20` (not `pageSize`).
- `managed_videos.metadata_locked` (default false) — when true, YouTube sync preserves existing `category` and `preacher`. Toggle via `PATCH /api/v1/admin/videos/:id` with `{ metadataLocked: true }`.
- **Vite proxy order matters**: `/api/v1/admin/videos/upload` (600 s timeout) MUST appear before the generic `/api` rule.
- **Upload engine**: `MAX_CONCURRENT_FILES=3`, chunk sizes slow=1 MB/1, moderate=4 MB/2, fast=8 MB/3 (cap 8 MiB). `MAX_CHUNK_RETRIES=6`.
- **Upload security**: chunk route validates `chunkIndex < session.totalChunks`. `InitBodySchema` validates `totalBytes` (1 B – 100 GiB), `totalChunks` (1–50 000). `safeExt` detects from filename first, then MIME (handles mp4/mov/mkv/avi/webm/m4v/flv/wmv/ts/mts/m2ts).
- Chunked server-relay only (`/admin/videos/upload/init` → `/chunk` → `/finalize`). All uploads broken into 8 MiB chunks with SHA-256.
- `completeMultipartUpload` assembles parts via iterative PostgreSQL `UPDATE`. Peak Node memory is O(1) regardless of file size.
- **Faststart safe re-upload**: `faststart.service.ts` uses `createMultipartUpload → uploadPart → completeMultipartUpload` instead of `delete + readFile + put`. On failure, `transcodingStatus` is restored to its pre-faststart value.

## Release Pipeline

See [`RELEASE_PIPELINE.md`](./RELEASE_PIPELINE.md). Quick refs:

```bash
bash scripts/release-all.sh          # standard patch release (all platforms)
bash scripts/version-bump.sh patch   # version bump only
bash scripts/deploy-tv-cdn.sh        # TV web assets to S3 + CloudFront
bash scripts/sentry-release.sh       # Sentry source maps upload
```

GitHub Actions: `ci.yml` (PR), `release.yml` (manual API+Admin), `mobile-release.yml` (`v*.*.*` tag EAS), `tv-release.yml` (Samsung/LG packaging), `ota-update.yml` (`main` push JS-only OTA), `store-deploy.yml` (manual store submit), `docker-publish.yml` (GHCR).

EAS profiles (`artifacts/mobile/eas.json`): `development`, `preview`, `staging`, `production`, `androidtv`, `appletv`, `firetv`.

TurboRepo: `turbo.json` configures parallel builds + caching (`npx turbo link` for remote cache). Fastlane: `fastlane/Fastfile` (iOS + Android lanes).

## Pointers

- [Fastify](https://www.fastify.io/docs/latest/) · [Drizzle](https://orm.drizzle.team/docs/overview) · [Zod](https://zod.dev/) · [TanStack Query](https://tanstack.com/query/latest) · [EAS Build](https://docs.expo.dev/build/introduction/) · [Fastlane](https://docs.fastlane.tools/) · [TurboRepo](https://turbo.build/repo/docs)
- [Release Pipeline](./RELEASE_PIPELINE.md) · [Changelog](./CHANGELOG.md)
