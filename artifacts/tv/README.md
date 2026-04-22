# `@workspace/tv` — Temple TV Smart TV App

A React + Vite **10-foot UI** designed for D-pad navigation on Smart TVs and
HTML5-capable set-top boxes. Streams the full Temple TV catalog and live
broadcasts in-platform via embedded YouTube.

> Production: `https://tv.templetv.org.ng`

---

## 1. Pages

| Page | Route component | Purpose |
|---|---|---|
| Home | `pages/Home.tsx` | Live hero + categorized sermon rows; D-pad navigable |
| TV Guide | `pages/TVGuide.tsx` | Schedule grid (today's slots) |
| Search | `pages/Search.tsx` | Full on-screen keyboard, real-time filter across the whole library |
| Video Details | `pages/VideoDetails.tsx` | Description, metadata, "Up Next" rail before playback |
| Player | `pages/Player.tsx` | Full-screen YouTube embed with retry / error UI |
| 404 | `pages/not-found.tsx` | Fallback |

---

## 2. D-pad navigation

`hooks/useTVNav.ts` is the single navigation engine:

- ↑ / ↓ moves between rows
- ← / → moves between items in the focused row
- ↑ from the top row enters the **header zone** (Search / Guide); ←/→ moves
  between the header buttons; **Enter** activates
- **Enter** opens details (or plays the live banner)
- **Backspace / Esc** returns

Keyboard shortcuts: `S` jumps to Search, `G` jumps to TV Guide.

---

## 3. Categorization

Videos arrive flat from `/api/youtube/videos` and are categorized client-side
in `hooks/useData.ts` using keyword matching (Faith, Healing, Deliverance,
Worship, Teachings, Special Programs). The map is memoized so changing focus
never re-runs categorization.

---

## 4. In-platform playback

`pages/Player.tsx` renders an embedded `youtube-nocookie.com` iframe with:

- `enablejsapi=1` and `origin=window.location.origin` for postMessage support
- `referrerPolicy=strict-origin-when-cross-origin`
- 12 s load watchdog → 2 silent retries → friendly "Playback unavailable"
  error UI with **Try again** / **Back** buttons
- Picture-in-Picture allowed where supported
- Auto-hiding control overlay after 4 s

There is **no** redirect to youtube.com.

---

## 5. Real-time live sync

`hooks/useLiveSync.ts` opens an `EventSource` to `/api/broadcast/events`. When
the admin starts or ends a live broadcast, the home screen updates within
milliseconds. If SSE is unavailable (older smart-TV browsers), it falls back
to a 30 s poll on `/api/youtube/live/status`.

---

## 6. Source layout

```
artifacts/tv/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main.tsx
    ├── App.tsx                     ← simple page switch
    ├── lib/
    │   └── api.ts                  ← fetchVideos, fetchLiveStatus
    ├── hooks/
    │   ├── useData.ts              ← memoized byCategory + featured
    │   ├── useGuide.ts             ← schedule loader
    │   ├── useSearch.ts            ← debounced filter
    │   ├── useLiveSync.ts          ← SSE + polling fallback
    │   ├── useTVNav.ts             ← D-pad focus engine
    │   ├── use-mobile.tsx          ← (shared)
    │   └── use-toast.ts            ← (shared)
    ├── pages/
    │   ├── Home.tsx
    │   ├── TVGuide.tsx
    │   ├── Search.tsx
    │   ├── VideoDetails.tsx
    │   ├── Player.tsx
    │   └── not-found.tsx
    └── components/
        ├── LiveHero.tsx
        ├── SermonRow.tsx
        ├── SermonCard.tsx
        ├── Clock.tsx
        └── ...
```

---

## 7. Local development

```bash
pnpm --filter @workspace/tv run dev          # vite dev server
pnpm --filter @workspace/tv run build        # production build → dist/
pnpm --filter @workspace/tv run typecheck
```

Dev URL: `http://localhost:$PORT/tv/` (base path is `/tv/`, set in
`vite.config.ts`).

### Configure API base

```env
VITE_API_URL=http://localhost:8080
```

If unset, the TV app calls the same origin.

---

## 8. Targeted devices

The TV app runs in any modern Smart-TV browser:

- **Apple TV** — Safari WebView via AirPlay / Apple TV browser apps
- **Android TV / Google TV** — Chrome browser apps, Vewd, Puffin TV
- **Tizen / webOS** — built-in browser
- **Hospitality / hotel TVs** — most modern STBs ship with a Chromium browser
- **Casting** — works as a target for Chromecast and AirPlay mirroring

For native Smart-TV submissions (tvOS, Tizen, webOS), see
[`RELEASE_AUDIT.md`](../../RELEASE_AUDIT.md) §5.5 — these would be greenfield
projects.

---

## 9. Deployment

`render.yaml` builds the static bundle and serves it from
`https://tv.templetv.org.ng`. The base path `/tv/` makes both the standalone
host and `https://templetv.org.ng/tv` work.

---

## 10. Related

- [`@workspace/api-server`](../api-server/README.md)
- Project [README](../../README.md)
- Audit report [`RELEASE_AUDIT.md`](../../RELEASE_AUDIT.md)
