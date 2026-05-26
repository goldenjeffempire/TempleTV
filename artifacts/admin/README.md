# `@workspace/admin` — Temple TV Operator Dashboard

React + Vite + Tailwind single-page application for the JCTM media team. Manages the entire Temple TV catalog, broadcast schedule, live operations, push notifications, analytics, and user management — all wired to the API through the shared client library.

> Production: `https://admin.templetv.org.ng`

---

## Pages

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/` | Stats, live status, recent videos, quick actions |
| Video Library | `/library` | Browse, search, edit, delete, upload, import from YouTube |
| Broadcast Queue | `/broadcast` | 24/7 channel — order items, pause, skip, see what is on air |
| Broadcast v2 Console | `/broadcast-v2` | **Master Control** — v2 orchestrator with skip/reload/override/failover |
| Playlists | `/playlists` | CRUD + drag-and-drop video reordering (`@dnd-kit`) |
| Series | `/series` | Sermon series management |
| Schedule | `/schedule` | Time-of-day broadcast slots |
| Live Control | `/live-control` | One-click Go Live — overrides every client in real time |
| Live Monitor | `/live-monitor` | Read-only current live state, viewer count, SSE health |
| Live YouTube | `/live-youtube` | YouTube Live status and override controls |
| Live Ingest | `/live-ingest` | RTMP ingest endpoint metadata |
| Notifications | `/notifications` | Compose and send push to all registered devices; history |
| Analytics | `/analytics` | Views per video, daily activity, top categories, registered devices |
| Audit Log | `/audit-log` | Admin action history |
| Prayers | `/prayers` | Prayer request moderation |
| Midnight Prayers | `/midnight-prayers` | Scheduled midnight prayer stream management |
| Chat | `/chat` | Live chat moderation |
| Graphics | `/graphics` | Lower-third and channel graphics management |
| Radio | `/radio` | Radio stream controls |
| Stream Health | `/stream-health` | HLS / RTMP stream health monitoring |
| SSE Bus | `/sse-bus` | Real-time event bus diagnostics |
| Playback | `/playback` | Playback session monitoring |
| Security | `/security` | RBAC, API token management |
| Settings | `/settings` | Platform-wide configuration |
| Operations | `/operations` | Health checks, cache, broadcast continuity |
| Launch Readiness | `/launch-readiness` | Self-check surfacing any pre-launch blocker |
| Purge | `/purge` | Cache + CDN purge controls |
| Alerts | `/alerts` | Emergency alert management |

---

## Stack

- **React 19** with **wouter** for client-side routing
- **Vite** dev server + production bundler
- **Tailwind CSS** + **shadcn/ui** (`src/components/ui/*`)
- **TanStack React Query** — all API state, `staleTime=60s / gcTime=10min / placeholderData=prev`
- **`@workspace/api-client-react`** — generated hooks; never hand-roll fetch in pages
- **`@workspace/player-core`** — v2 broadcast player FSM for the Master Control console
- **`framer-motion`** — page transitions
- **`recharts`** — analytics charts
- **`@dnd-kit/sortable`** — drag-and-drop playlist reordering
- **hls.js** — in-admin HLS preview player
- **Auto theme** — light by default; midnight palette active 20:00 → 05:59 local time

---

## Authentication

Routes and API calls require a JWT session. Login at `/login`.

RBAC roles that have admin access: `editor`, `admin`, `system`. The `requireAuth("editor")` guard protects broadcast mutations; `requireAuth("admin")` protects destructive operations.

The legacy `ADMIN_API_TOKEN` bearer header is also accepted for machine-to-machine operator scripts.

---

## Upload engine

Multi-file upload queue (`src/lib/upload-queue.ts`) — module-level singleton:

- Max 3 concurrent files; adaptive 1–4 chunk concurrency (slow/moderate/fast network detection)
- Chunk size: 8 MiB max; SHA-256 per chunk
- Per-item pause / cancel / retry / prioritize
- `UploadQueuePanel` (fixed bottom-right) mounts once in `AuthenticatedApp`
- XHR chunks for real-time byte-level progress bars
- Auto-pause on `offline` event, auto-resume on `online`

Vite proxy order matters: `/api/v1/admin/videos/upload` (600 s timeout) MUST appear before the generic `/api` proxy rule.

---

## Broadcast v2 console

`src/pages/broadcast-v2.tsx` — the **Master Control** page. Connects to `/api/broadcast-v2/ws` (WebSocket, SSE fallback) via `useV2Broadcast` from `@workspace/player-core`.

Operator actions available:
- **Skip** current item (requires `editor` role + `idempotencyKey`)
- **Reload** queue from DB (requires `editor` role)
- **Override** — inject an emergency source URL (requires `admin` role)
- **Failover** — switch to backup source (requires `admin` role)
- **End override** — return to scheduled programming

---

## Source layout

```
artifacts/admin/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main.tsx
    ├── App.tsx                    ← router + QueryClientProvider + AuthGuard
    ├── components/
    │   ├── layout/                ← sidebar, header, breadcrumbs
    │   └── ui/                    ← shadcn/ui primitives
    ├── lib/
    │   ├── upload-queue.ts        ← multi-file upload singleton
    │   ├── api.ts                 ← shared fetch wrapper + auth headers
    │   ├── theme.ts               ← midnight palette detection
    │   └── utils.ts               ← cn(), formatBytes(), etc.
    └── pages/
        ├── broadcast-v2.tsx       ← Master Control console
        ├── library.tsx
        ├── schedule.tsx
        ├── analytics.tsx
        └── ... (see Pages table above)
```

---

## Development

```bash
pnpm --filter @workspace/admin run dev          # Vite dev server (port 5000 on Replit)
pnpm --filter @workspace/admin run build        # production build → dist/
pnpm --filter @workspace/admin run serve        # preview production build
pnpm --filter @workspace/admin run typecheck
```

The dev server proxies `/api/*` to port 5000 (the API server) — **start the API first**.

To point at a different API base during local development, create `.env.local` (gitignored):

```env
VITE_API_URL=http://localhost:8080
API_DEV_PORT=8080
```

---

## Deployment

`render.yaml` builds a static bundle:

```bash
pnpm install --ignore-scripts
pnpm --filter @workspace/admin run build
# Render static site serves dist/
```

---

## Related

- [`@workspace/api-server`](../api-server/README.md)
- [`@workspace/api-client-react`](../../lib/api-client-react/README.md)
- [`@workspace/player-core`](../../lib/player-core/README.md)
- Project [README](../../README.md)
