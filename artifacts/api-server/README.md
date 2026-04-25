# `@workspace/api-server` — Temple TV API

Express 5 API server that powers all Temple TV clients (mobile, web, Smart TV,
admin). Owns the broadcast state machine, video transcoding pipeline, push
fan-out, authentication, and YouTube channel pagination.

> Production: `https://api.templetv.org.ng`
> Dev: `http://localhost:$PORT` (port assigned by Replit per artifact)

---

## 1. Architecture

```
       ┌─────────────────────────── Express 5 ───────────────────────────┐
       │                                                                 │
HTTPS──┤  requestId → securityHeaders → rateLimit → CORS → adminAccess  ├──▶ routes/
       │                                                                 │
       │  ▲                                                              │
       │  │ /api/broadcast/events (SSE)                                  │
       │  │ /api/live/events       (SSE)                                 │
       │  └── pino structured logs                                       │
       └─────────────────────────────────────────────────────────────────┘
                  │                  │                       │
                  ▼                  ▼                       ▼
         ┌────────────────┐  ┌──────────────┐      ┌──────────────────┐
         │ Drizzle / Neon │  │ FFmpeg HLS   │      │ Expo Push API    │
         │ (Postgres)     │  │ transcoder   │      │ (APNs + FCM)     │
         └────────────────┘  └──────────────┘      └──────────────────┘
```

---

## 2. Routes

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/healthz` | public | Liveness probe |
| `GET /api/youtube/videos` | public | Full uploads playlist (paginated, all 2,114 videos) |
| `GET /api/youtube/rss` | public | RSS fallback (~15 most recent) |
| `GET /api/youtube/live/status` | public | Current YouTube live state |
| `GET /api/broadcast/current` | public | Unified broadcast snapshot — includes sync fields `serverTimeMs`, `positionSecs`, `currentItemEndsAtMs`, `itemStartEpochSecs` so every client can join the live timeline at the exact same second |
| `GET /api/broadcast/events` | public | SSE stream of broadcast state changes |
| `GET /api/live/events` | public | SSE stream of live override events |
| `POST /api/auth/signup` | public | Create account → access + refresh JWT |
| `POST /api/auth/login` | public | Sign in → access + refresh JWT |
| `POST /api/auth/refresh` | public | Exchange refresh token for new access token |
| `POST /api/auth/logout` | bearer | Revoke (single device or `everywhere`) |
| `GET /api/auth/me` | bearer | Current user |
| `PATCH /api/auth/profile` | bearer | Update display name |
| `PATCH /api/auth/password` | bearer | Change password |
| `GET /api/user/favorites` `POST` `DELETE :id` | bearer | Cloud-synced favorites |
| `GET /api/user/history` `POST` `DELETE` | bearer | Cloud-synced watch history |
| `POST /api/push-tokens` | public | Register a device push token |
| `POST /api/videos/:youtubeId/view` | public | Increment view count |
| `POST /api/client-errors` | public | First-party crash / error sink |
| `GET /api/subscriptions/tiers` | public | Public tier list |
| `GET /api/me/subscription` | bearer | Active subscription for current user |
| `GET /api/admin/stats` | admin | Dashboard summary |
| `GET /api/admin/users` | admin | Paginated user list |
| `GET/POST /api/admin/videos` ... | admin | Video library CRUD + import + upload |
| `POST /api/admin/videos/upload` | admin | Single-shot upload (≤ 5 GB, magic-byte verified) |
| `POST /api/admin/videos/upload/start \| chunk \| complete` | admin | Chunked upload (8 MB chunks, SHA-256 verified) |
| `GET/POST/PATCH/DELETE /api/admin/playlists` ... | admin | Playlist CRUD + reorder |
| `GET/POST/PATCH/DELETE /api/admin/schedule` ... | admin | Schedule entries |
| `POST /api/admin/notifications/send` | admin | Push to all registered devices |
| `GET/POST/PATCH /api/admin/live-overrides` ... | admin | Manual “Go Live” control |
| `GET /api/admin/transcoding/jobs` | admin | HLS pipeline status |
| `GET /api/admin/ops/status` | admin | Health + metrics for Operations page |
| `GET /api/admin/launch/readiness` | admin | Pre-launch self-check |
| `/api/hls/:videoId/master.m3u8` `:variant.m3u8` `:segment.ts` | public | HLS streaming |

The full Zod request/response schemas live in
[`@workspace/api-zod`](../../lib/api-zod/README.md), and matching React Query
hooks in [`@workspace/api-client-react`](../../lib/api-client-react/README.md).

---

## 3. Source layout

```
artifacts/api-server/src/
├── app.ts                  ← Express factory (CORS, security, routes wiring)
├── index.ts                ← server entry (HTTP listener)
├── instrument.ts           ← Sentry + pino bootstrap (loaded with --import)
│
├── routes/
│   ├── index.ts            ← mounts every router
│   ├── health.ts           ← /api/healthz
│   ├── auth.ts             ← signup, login, refresh, logout, me, password
│   ├── user.ts             ← favorites + history
│   ├── youtube.ts          ← videos, rss, live status
│   ├── broadcast.ts        ← unified broadcast state + SSE
│   ├── admin.ts            ← all /api/admin/* (large — videos, uploads, ops)
│   ├── subscriptions.ts    ← public + admin subscription tiers
│   ├── client-errors.ts    ← /api/client-errors (Zod-validated, optional sink)
│   └── legal.ts            ← /legal/privacy, /legal/terms
│
├── middlewares/
│   ├── security.ts         ← requestId, securityHeaders, rateLimit, adminAccess
│   └── observability.ts    ← request metrics for /admin/ops/status
│
└── lib/
    ├── logger.ts           ← pino instance (used everywhere)
    ├── cache.ts            ← in-memory + optional Redis cache
    ├── rateStore.ts        ← rate-limit token bucket
    ├── transcoder.ts       ← FFmpeg HLS pipeline (5 ladders)
    ├── liveEvents.ts       ← SSE client registry
    ├── fileValidation.ts   ← magic-byte (content sniff) check on uploads
    ├── objectStorage.ts    ← Replit Object Storage (GCS) client
    └── objectAcl.ts        ← signed-URL helpers for private objects
```

---

## 4. Security

| Header / control | Detail |
|---|---|
| HSTS | `max-age=63072000; includeSubDomains; preload` (prod only) |
| CSP | `default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| CORS | Strict allowlist; production rejects unknown origins; dev allows only localhost / Replit dev hosts |
| Rate limits | Per-IP, per-route bucket: signup/login = 10 / min, auth = 30 / min, admin = 240 / min, youtube = 120 / min, default = 600 / min |
| Admin gate | `ADMIN_API_TOKEN` constant-time check on every `/api/admin/*` |
| Upload validation | Magic-byte sniff (MIME-spoof safe) for video & image uploads |
| Auth | bcrypt-hashed passwords, JWT access (short TTL) + refresh (long TTL) |
| Errors | Sanitised in production (`internal_error`); full message in dev |

---

## 5. Local development

```bash
pnpm --filter @workspace/api-server run dev    # build + start
pnpm --filter @workspace/api-server run typecheck
```

The dev script does `esbuild` → `node`, so reloads require a workflow restart.
For pure type-checking during refactors, use `typecheck`.

### Required env

```env
PORT=8080
DATABASE_URL=postgres://...
JWT_SECRET=$(openssl rand -hex 64)
ADMIN_API_TOKEN=$(openssl rand -hex 32)
YOUTUBE_API_KEY=...                # google cloud → APIs & Services
NODE_ENV=development               # production turns on HSTS + strict CORS
```

### Optional env

```env
SENTRY_DSN=...                     # server error reporting
CLIENT_ERROR_SINK_URL=...          # forward /api/client-errors elsewhere
CLIENT_ERROR_SINK_TOKEN=...        # bearer for the sink
ALLOWED_ORIGINS=https://foo.com,https://bar.com  # extra CORS origins
REDIS_URL=redis://...              # promotes the in-memory cache to Redis
```

---

## 6. Deployment

Defined in `render.yaml` at the project root. Render runs:

```
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push     # only on schema change
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

Health-check path: `/api/healthz`. Trust proxy is on (`app.set('trust proxy', 1)`).

---

## 7. Operations

Visit `/api/admin/ops/status` (admin token required) for a JSON snapshot:

- DB / cache / transcoder health
- Counts of videos, playlists, schedule entries, registered devices
- Broadcast queue status & connected admin SSE clients
- Transcoding pipeline (queued / processing / done / failed / cancelled)
- Upload session status

The admin app surfaces this on the **Operations** page.

---

## 8. Related

- [`@workspace/api-spec`](../../lib/api-spec/README.md) — OpenAPI source-of-truth
- [`@workspace/api-zod`](../../lib/api-zod/README.md) — request/response Zod schemas
- [`@workspace/db`](../../lib/db/README.md) — Drizzle schema
- Project root [README](../../README.md), audit report [`RELEASE_AUDIT.md`](../../RELEASE_AUDIT.md)
