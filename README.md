# Temple TV — JCTM Broadcasting Platform

End-to-end media platform for Jesus Christ Temple Ministry — live worship, sermon-on-demand, 24/7 broadcast continuity, push notifications, and subscription management — delivered to **mobile, web, Smart TV, and admin** clients from a single codebase.

> **Live URLs (production)**
> Web · `https://templetv.org.ng` &nbsp;·&nbsp;
> Admin · `https://admin.templetv.org.ng` &nbsp;·&nbsp;
> Smart TV · `https://tv.templetv.org.ng` &nbsp;·&nbsp;
> API · `https://api.templetv.org.ng`

---

## Repository layout

```
.
├── artifacts/                  ← deployable applications
│   ├── api-server/             ← Fastify v5 API + transcoder + broadcast orchestrator
│   ├── admin/                  ← React + Vite operator dashboard
│   ├── mobile/                 ← Expo (iOS, Android, Android TV, Apple TV, Fire TV)
│   ├── tv/                     ← React + Vite Smart TV app (Tizen, webOS)
│   └── mockup-sandbox/         ← isolated Vite design-preview server
│
├── lib/                        ← shared workspace libraries
│   ├── api-spec/               ← OpenAPI source-of-truth + codegen orchestrator
│   ├── api-zod/                ← Zod request/response schemas
│   ├── api-client-react/       ← TanStack Query hooks
│   ├── db/                     ← Drizzle ORM schema + PostgreSQL client
│   ├── broadcast-types/        ← shared TypeScript interfaces for the broadcast protocol
│   ├── broadcast-sync/         ← v1 real-time broadcast sync engine (chat, graphics, viewer count)
│   └── player-core/            ← universal A/B-buffer player FSM + WS/SSE transport
│
├── scripts/                    ← release, smoke-test, env-validate helpers
├── render.yaml                 ← Render Blueprint (production deploy)
├── turbo.json                  ← TurboRepo build graph
├── replit.md                   ← deep architecture notes + active gotchas
├── CHANGELOG.md                ← historical fix logs
├── RELEASE_PIPELINE.md         ← CI/CD, EAS, Tizen/webOS packaging guide
└── README.md                   ← this file
```

Each artifact and library has its own `README.md` with package-specific detail.

---

## Quick start

```bash
# Install (always --ignore-scripts on Replit)
pnpm install --ignore-scripts

# Apply schema to the database
pnpm --filter @workspace/db run push

# Build and start the API (port 5000 / 8080 on Replit)
pnpm --filter @workspace/api-server run build
PORT=5000 node --enable-source-maps \
  --import ./artifacts/api-server/dist/instrument.mjs \
  ./artifacts/api-server/dist/index.mjs

# In separate terminals:
PORT=3000 pnpm --filter @workspace/admin run dev   # admin dashboard
pnpm --filter @workspace/tv run dev                 # Smart TV app
pnpm --filter @workspace/mobile run dev             # Expo bundler
```

On Replit the four workflows (`Start API`, `Start application`, `artifacts/tv: web`, `artifacts/mobile: expo`) wire these up automatically.

---

## Package documentation

| Package | Purpose | README |
|---------|---------|--------|
| `artifacts/api-server` | Fastify v5 API, HLS transcoder, broadcast orchestrator, SSE/WS | [→](./artifacts/api-server/README.md) |
| `artifacts/admin` | Operator dashboard — library, broadcast, schedule, analytics | [→](./artifacts/admin/README.md) |
| `artifacts/mobile` | Expo app — iOS, Android, Android TV, Apple TV, Fire TV | [→](./artifacts/mobile/README.md) |
| `artifacts/tv` | Smart TV web app — Samsung Tizen, LG webOS | [→](./artifacts/tv/README.md) |
| `lib/db` | Drizzle ORM schema + PostgreSQL client | [→](./lib/db/README.md) |
| `lib/api-spec` | OpenAPI source of truth + codegen | [→](./lib/api-spec/README.md) |
| `lib/api-zod` | Shared Zod validation schemas | [→](./lib/api-zod/README.md) |
| `lib/api-client-react` | TanStack Query hooks for the API | [→](./lib/api-client-react/README.md) |
| `lib/broadcast-types` | Shared broadcast protocol types | [→](./lib/broadcast-types/README.md) |
| `lib/broadcast-sync` | v1 broadcast sync engine | [→](./lib/broadcast-sync/README.md) |
| `lib/player-core` | Universal player FSM + transport | [→](./lib/player-core/README.md) |

---

## Broadcast / Player v2

The live broadcast stack runs on **v2** across all four player surfaces (admin console, TV, mobile, web). v1 modules are intentionally retained for companion surfaces (chat, graphics, viewer count, reactions).

| Component | Location |
|-----------|----------|
| Server orchestrator FSM | `artifacts/api-server/src/modules/broadcast-v2/` |
| API gateway | `GET/POST /api/broadcast-v2/{snapshot,events,ws,skip,reload,…}` |
| Player FSM (A/B buffer) | `lib/player-core/src/machine.ts` |
| WS/SSE transport | `lib/player-core/src/transport.ts` |
| Stall watchdog | `lib/player-core/src/watchdog.ts` |
| Admin console | `artifacts/admin/src/pages/broadcast-v2.tsx` |
| TV player | `artifacts/tv/src/components/LiveBroadcastV2.tsx` |
| Mobile player | `artifacts/mobile/components/V2PlayerContainer.tsx` |
| Health endpoint | `GET /api/broadcast-v2/health` |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥24 |
| Package manager | pnpm ≥10 (workspace + catalog versions) |
| Language | TypeScript 5.9 (strict, ESM throughout) |
| API server | Fastify v5, fastify-type-provider-zod |
| Database | PostgreSQL via Drizzle ORM (Replit built-in) |
| Validation | Zod (SSOT for schema + OpenAPI) |
| Real-time | Server-Sent Events + WebSockets |
| Caching | Redis (optional) + in-process LRU + PostgreSQL fallback |
| Admin | React 19, Vite, Tailwind CSS, shadcn/ui, wouter, TanStack Query |
| Mobile | Expo ~54, React Native 0.81, expo-av, expo-router |
| TV | React 19, Vite, HLS.js, Tailwind CSS |
| Transcoding | FFmpeg → multi-rendition VOD HLS (360p – 1080p) |
| Observability | Sentry, OpenTelemetry, Prometheus (`/metrics`) |
| Build graph | TurboRepo |
| Release | GitHub Actions + EAS Build + Fastlane |

---

## Required secrets

| Secret | Required | Notes |
|--------|----------|-------|
| `JWT_ACCESS_SECRET` | Yes | ≥32 characters |
| `JWT_REFRESH_SECRET` | Yes | ≥32 characters |
| `SMTP_PASS` | Yes | Email delivery |
| `DATABASE_URL` | Auto | Set by Replit; `PG*` env vars override at boot |
| `API_ORIGIN` | Production | e.g. `https://api.templetv.org.ng` — absolutizes upload URLs |
| `REDIS_URL` | Optional | Falls back to PostgreSQL when unset |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Optional | CDN/S3 delivery |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Optional | Web push notifications |
| `EXPO_ACCESS_TOKEN` | Optional | EAS builds |
| `SENTRY_DSN` | Optional | Error tracking |

---

## Common workflows

```bash
# Regenerate OpenAPI spec + Zod schemas + React Query hooks
pnpm --filter @workspace/api-spec run emit

# Apply schema changes to the local database
pnpm --filter @workspace/db run push

# Typecheck all libraries
pnpm run typecheck:libs

# Run the full verification suite (CI gate)
pnpm run verify

# Bump version + release all platforms (patch)
pnpm run release:production
```

---

## Deployment

| Surface | Platform | Trigger |
|---------|----------|---------|
| API + Admin + TV | Render | `git push main` → Render Blueprint |
| iOS / Android | EAS Build + Submit | `pnpm run mobile:eas:build` |
| TV web (CDN) | AWS S3 + CloudFront | `bash scripts/deploy-tv-cdn.sh` |
| DB schema | Drizzle push | `pnpm --filter @workspace/db run push` |

See [`RELEASE_PIPELINE.md`](./RELEASE_PIPELINE.md) for the full pipeline, GitHub Actions workflow list, and EAS profiles.

---

## Development notes

- Node ≥24 and pnpm ≥10 are enforced in `package.json engines`
- Always run `pnpm install --ignore-scripts` (not plain `pnpm install`) on Replit
- Always run `pnpm --filter @workspace/db run push` after any schema change
- The admin Vite dev server proxies `/api/*` → port 5000 — start the API first
- Default dev admin: `admin@templetv.org.ng` / `Temple124@`
- Mobile cannot be previewed in the browser — use Expo Go or a device/simulator build
- `pnpm --filter @workspace/api-spec run emit` must be re-run after any API schema change; commit the generated files

---

## License

Proprietary © Jesus Christ Temple Ministry (JCTM). All rights reserved.
