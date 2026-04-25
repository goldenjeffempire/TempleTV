# Temple TV (JCTM Broadcasting)

End-to-end media platform for Jesus Christ Temple Ministry — live worship,
sermon-on-demand, 24/7 broadcast continuity, push notifications, and
subscription management — delivered to **mobile, web, smart-TV, and admin**
clients from a single codebase.

> **Live URLs (production)**
> Web · `https://templetv.org.ng` &nbsp;·&nbsp;
> Admin · `https://admin.templetv.org.ng` &nbsp;·&nbsp;
> Smart TV · `https://tv.templetv.org.ng` &nbsp;·&nbsp;
> API · `https://api.templetv.org.ng`

---

## 1. Repository layout

This is a [pnpm](https://pnpm.io) workspace monorepo.

```
.
├── artifacts/                  ← deployable applications (one workflow each)
│   ├── api-server              ← Express API + transcoder + push fan-out
│   ├── admin                   ← React + Vite operator dashboard
│   ├── mobile                  ← Expo (iOS, Android, web)
│   ├── tv                      ← React + Vite Smart-TV (10-foot UI)
│   └── mockup-sandbox          ← design preview server (canvas only)
│
├── lib/                        ← shared library packages
│   ├── api-spec                ← OpenAPI source-of-truth + Orval codegen
│   ├── api-zod                 ← Zod request/response schemas (generated)
│   ├── api-client-react        ← React Query hooks (generated)
│   └── db                      ← Drizzle schema + migrations + client
│
├── render.yaml                 ← Render Blueprint (production deploy)
├── RELEASE_AUDIT.md            ← latest production-readiness audit
├── replit.md                   ← architecture / change log (deep technical)
└── README.md                   ← this file
```

Each artifact and library has its own README with details specific to that
package — see the **Per-package documentation** section below.

---

## 2. Quick start

```bash
pnpm install                   # one-time, hoisted across the workspace
pnpm --filter @workspace/db run push   # apply Drizzle schema to DATABASE_URL

# In separate terminals (or via the configured workflows):
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/admin     run dev
pnpm --filter @workspace/tv        run dev
pnpm --filter @workspace/mobile    run dev    # Expo
```

When using Replit, all four are wired as long-running workflows
(`Run` button starts them automatically).

### Required environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | api-server, db | Postgres connection string (Neon in prod) |
| `YOUTUBE_API_KEY` | api-server | Channel uploads pagination (full 2,114-video catalog) |
| `JWT_SECRET` | api-server | Access + refresh token signing |
| `ADMIN_API_TOKEN` | api-server, admin | Bearer guard for `/api/admin/*` routes |
| `EXPO_PUBLIC_API_URL` | mobile | Canonical API base URL |
| `EXPO_PUBLIC_DOMAIN` | mobile | Fallback API host (legacy Expo Go) |
| `SENTRY_DSN` *(optional)* | api-server | Server error reporting |
| `CLIENT_ERROR_SINK_URL` *(optional)* | api-server | External log sink for `/api/client-errors` |

See `RELEASE_AUDIT.md` § 5 for the production checklist.

---

## 3. Per-package documentation

| Package | Purpose | README |
|---|---|---|
| `artifacts/api-server` | Express 5 API, transcoder, SSE, broadcast engine | [`./artifacts/api-server/README.md`](./artifacts/api-server/README.md) |
| `artifacts/admin` | Operator dashboard — videos, broadcast, schedule, users | [`./artifacts/admin/README.md`](./artifacts/admin/README.md) |
| `artifacts/mobile` | Expo app for iOS, Android, mobile-web | [`./artifacts/mobile/README.md`](./artifacts/mobile/README.md) |
| `artifacts/tv` | React + Vite 10-foot UI for Smart TVs | [`./artifacts/tv/README.md`](./artifacts/tv/README.md) |
| `lib/api-spec` | OpenAPI spec + Orval codegen | [`./lib/api-spec/README.md`](./lib/api-spec/README.md) |
| `lib/api-zod` | Generated Zod schemas | [`./lib/api-zod/README.md`](./lib/api-zod/README.md) |
| `lib/api-client-react` | Generated React Query hooks | [`./lib/api-client-react/README.md`](./lib/api-client-react/README.md) |
| `lib/db` | Drizzle ORM schema + migrations | [`./lib/db/README.md`](./lib/db/README.md) |

---

## 4. The unified broadcast architecture

A single live source feeds every client simultaneously:

```
   Admin Live Control                  YouTube Live channel
        │                                       │
        ▼                                       ▼
   POST /api/admin/live-overrides          live-status poll
        │                                       │
        └──────────► broadcast state ◄──────────┘
                          │
        Server-Sent Events │  GET /api/broadcast/events
                          ▼
   ┌──────────┬──────────┬──────────┬──────────┐
   │ Mobile   │   Web    │ Smart TV │  Admin   │
   │ (Expo)   │ (Expo-W) │  (Vite)  │ (Vite)   │
   └──────────┴──────────┴──────────┴──────────┘
```

- **One source of truth** — `/api/broadcast/current` (HTTP) and
  `/api/broadcast/events` (SSE) return the same payload.
- **All clients reconnect automatically** with polling fallback when SSE drops.
- **Admin can override instantly** — `Live Control` → Go Live pushes a
  state change to every connected client within milliseconds.
- **Failover-safe** — if the YouTube live signal disappears, the server
  promotes the next scheduled item or the broadcast queue front item, never
  showing dead-air to viewers.

### 4.1 Sync-aware playback (Hero + Player)

Every broadcast surface (mobile Hero, TV Hero, mobile `/player`, TV `/player`)
joins the live timeline at the **exact second currently airing** and stays in
sync via a uniform drift-correction loop:

| Concept | Where | Behaviour |
|---|---|---|
| Join offset | `computeLiveBroadcastPosition()` (TV `Home.tsx`); inline `bc.positionSecs * 1000 + networkDriftSecs` on mobile | Computed once per item from `serverTimeMs`, `positionSecs`, and the network round-trip drift, then passed to the player as `startPositionMs` |
| Drift correction | `LiveBroadcastVideo.tsx` (TV), `app/(tabs)/index.tsx` (mobile hero) | Every **12 s**, if playhead drift &gt; **4 s** vs the expected live offset, snap forward / back via `currentTime =` (TV) or `setPositionAsync` (mobile) |
| Stable-ref pattern | Both platforms | Sync data and callbacks held in `useRef`s so identity churn doesn't tear down the video element on every payload |
| Container shape | Both platforms | Two-layer render — blurred `cover` backdrop fills the box, foreground at `contain` so the broadcast frame is **never cropped** |
| MP4 routing | `LocalVideoPlayer.tsx` (mobile web), `HlsVideoPlayer.tsx` (TV) | URL-extension check (`.mp4|.webm|.mov|...`) routes plain video away from `hls.js`; `seekToStart()` honours `startPositionMs` on every code path (HLS, native HLS, direct MP4) |
| Pairing URL | `AuthGateModal.tsx` (TV) | Displayed as **`templetv.org.ng/link`** — the mobile `/link` route claims the TV-displayed code |

This means a viewer who lands on the mobile app, taps **Watch Temple TV**, and
then opens the same channel on a TV will see both screens within a few seconds
of each other, drifting back into lock-step automatically as the broadcast
progresses.

---

## 5. Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 |
| Package manager | pnpm 9 (workspace + catalog versions) |
| Language | TypeScript 5.9 |
| API server | Express 5 + Drizzle ORM + Zod |
| Database | PostgreSQL (Neon in production) |
| Real-time | Server-Sent Events |
| Mobile | Expo SDK 54 (React Native + react-native-web) |
| Web | Vite 7 + React 18 |
| State | React Query (server) + Context (client) |
| Styling | Tailwind CSS + shadcn/ui (admin), platform-native (mobile, TV) |
| Auth | JWT access + refresh, tokens in `expo-secure-store` |
| Storage | Replit Object Storage (HLS bucket) |
| Push | Expo Push Notifications (APNs + FCM) |
| Transcoding | FFmpeg → adaptive HLS (5 quality ladders) |
| Observability | pino (structured) + optional Sentry |

---

## 6. Common workflows

```bash
# Regenerate Zod schemas + React Query hooks from the OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Apply schema changes to the database (DEV ONLY — overwrites)
pnpm --filter @workspace/db run push

# Typecheck every package
pnpm -r run typecheck

# Build a production EAS mobile build
cd artifacts/mobile && eas build --platform ios --profile production
```

---

## 7. Deployment

Both Render and EAS are pre-configured.

| Surface | How |
|---|---|
| API + admin + TV + web | `render.yaml` Blueprint — `git push` to `main` triggers a Render build & deploy |
| iOS / Android | `eas build --profile production` then `eas submit` |
| DB schema | `pnpm --filter @workspace/db run push` (dev) — production migrations follow Drizzle's standard `migrate` flow |

Detailed launch checklist: [`RELEASE_AUDIT.md`](./RELEASE_AUDIT.md).

---

## 8. Contributing

1. **Branch from `main`** — short-lived feature branches.
2. **Type-check before pushing** — `pnpm -r run typecheck`.
3. **Keep `replit.md` current** for any architectural change.
4. **Bump the OpenAPI spec first**, then run codegen — the generated Zod
   schemas and React Query hooks must never be hand-edited.

---

## 9. License & ownership

Proprietary © Jesus Christ Temple Ministry (JCTM). All rights reserved.

For licensing or partnership inquiries, contact the JCTM media office through
[templetv.org.ng](https://templetv.org.ng).
