# `@workspace/admin` — Temple TV Operator Dashboard

A React + Vite + wouter single-page application for the JCTM media team.
Manages the entire Temple TV catalog, schedule, broadcast, push notifications,
subscriptions, and live operations — all wired to
[`@workspace/api-server`](../api-server/README.md) through generated React Query
hooks in [`@workspace/api-client-react`](../../lib/api-client-react/README.md).

> Production: `https://admin.templetv.org.ng`

---

## 1. What's inside

| Page | Path | Purpose |
|---|---|---|
| Dashboard | `/` | Stats cards, live status, recent videos, “Import Video” quick action |
| Video Library | `/videos` | Browse / search / edit / delete / import (YouTube URL or local upload) |
| Broadcast Queue | `/broadcast` | The 24/7 channel — order, pause, end items, see what is on air |
| Playlists | `/playlists` | CRUD + drag-and-drop video reordering (`@dnd-kit`) |
| Schedule | `/schedule` | Time-of-day slots — playlist, single video, or live override |
| Notifications | `/notifications` | Compose & send push to all registered devices; history |
| Analytics | `/analytics` | Views per video, daily activity, top categories, registered devices |
| Registered Users | `/users` | Searchable / paginated user table |
| Transcoding Queue | `/transcoding` | HLS pipeline status (queued / processing / done / failed) with retry |
| Live Control | `/live-control` | One-click **Go Live** — overrides every client in real time |
| Live Monitor | `/live-monitor` | Read-only mirror of the current live state, viewer count, SSE health |
| Subscriptions | `/subscriptions` | CRUD subscription tiers, manage subscriber status |
| Operations | `/operations` | Health checks, metrics, cache, broadcast continuity |
| Launch Readiness | `/launch-readiness` | Self-check that surfaces any pre-launch blocker |

---

## 2. Stack

- **React 18** with **wouter** for routing (path-based, base = `/admin`)
- **Vite 7** dev server + production bundler
- **Tailwind CSS** + **shadcn/ui** (`src/components/ui/*`)
- **TanStack React Query** for all API state
- **Generated hooks** from `@workspace/api-client-react` (`useGetLiveStatus`,
  `useListAdminVideos`, etc.) — never hand-roll fetch in pages
- **`framer-motion`** for transitions
- **`recharts`** for analytics
- **`@dnd-kit/sortable`** for playlist reordering
- **Auto theme** — light by default, automatic midnight palette from
  20:00 → 05:59 local time

---

## 3. Authentication

Admin endpoints are gated by `ADMIN_API_TOKEN` server-side. The dashboard:

1. Shows an **Admin key** badge in the header — amber when not set, green when set.
2. Clicking the badge opens a prompt to paste / clear the token.
3. The token is stored in `localStorage` and automatically attached as
   `Authorization: Bearer <token>` on every request via the api-client wrapper.

There is no per-user login — the dashboard itself is a single team tool. Use
your hosting platform (Render IP allowlist, Cloudflare Access, etc.) for any
additional perimeter security.

---

## 4. Local development

```bash
pnpm --filter @workspace/admin run dev          # vite dev server
pnpm --filter @workspace/admin run build        # production build → dist/
pnpm --filter @workspace/admin run serve        # preview the production build
pnpm --filter @workspace/admin run typecheck
```

The dev server reads `BASE_URL` from `vite.config.ts` (`/admin/`). All API
calls go to `import.meta.env.VITE_API_URL` if set; otherwise the same origin.

### Configuring the API base

Edit `.env.local` (gitignored):

```env
VITE_API_URL=http://localhost:8080
```

---

## 5. Source layout

```
artifacts/admin/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── tailwind.config (in package.json)
├── public/
└── src/
    ├── main.tsx
    ├── App.tsx               ← router + QueryClientProvider
    ├── components/
    │   ├── layout.tsx        ← sidebar, header, admin-token badge
    │   └── ui/               ← shadcn/ui primitives
    ├── lib/
    │   ├── admin-access.ts   ← token storage helpers + cross-tab sync
    │   ├── theme.ts          ← auto midnight detection
    │   ├── api.ts            ← shared fetch wrapper
    │   └── videoCompressor.ts← client-side H.264 (WebCodecs) for uploads
    └── pages/
        ├── dashboard.tsx
        ├── videos.tsx
        ├── playlists.tsx
        ├── schedule.tsx
        ├── broadcast.tsx
        ├── notifications.tsx
        ├── analytics.tsx
        ├── users.tsx
        ├── transcoding.tsx
        ├── live-control.tsx
        ├── live-monitor.tsx
        ├── subscriptions.tsx
        ├── operations.tsx
        ├── launch-readiness.tsx
        └── not-found.tsx
```

---

## 6. Notable subsystems

### 6.1 Chunked upload + client-side compression
`src/lib/videoCompressor.ts` runs an H.264 WebCodecs pipeline
(mp4box → VideoDecoder → OffscreenCanvas → VideoEncoder → mp4-muxer). The
upload UI (in `pages/videos.tsx`) splits the result into 8 MB chunks, hashes
each with SHA-256, and uploads in parallel with resume support. Sessions
persist to `localStorage` and survive a browser refresh.

### 6.2 Real-time updates via SSE
The Broadcast and Live pages subscribe to `/api/broadcast/events` and
`/api/live/events` so the UI updates within milliseconds of any change made
by another admin (multi-operator safe).

### 6.3 Auto theme
`lib/theme.ts` re-evaluates every 60 s — pages do not need to import anything
to participate; CSS variables flip automatically.

---

## 7. Deployment

`render.yaml` builds a static bundle:

```
pnpm install --frozen-lockfile
pnpm --filter @workspace/admin run build
# Render's static site serves dist/
```

The base path `/admin/` (set in `vite.config.ts`) makes both the standalone
`https://admin.templetv.org.ng` host and `https://templetv.org.ng/admin`
work transparently.

---

## 8. Related

- [`@workspace/api-server`](../api-server/README.md)
- [`@workspace/api-client-react`](../../lib/api-client-react/README.md)
- Project [README](../../README.md), audit report [`RELEASE_AUDIT.md`](../../RELEASE_AUDIT.md)
