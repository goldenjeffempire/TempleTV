# `@workspace/tv` — Temple TV Smart TV App

React + Vite 10-foot UI for D-pad navigation on Smart TVs and HTML5-capable set-top boxes. Streams the full Temple TV catalog and live broadcasts via the v2 broadcast player, with Samsung Tizen and LG webOS packaging support.

> Production: `https://tv.templetv.org.ng`

---

## Target platforms

| Platform | Notes |
|----------|-------|
| Samsung Tizen (2017+) | Native packaging via `pnpm run package:tizen` |
| LG webOS (2018+) | Native packaging via `pnpm run package:lg` |
| Android TV / Google TV | Chrome browser app or Puffin TV |
| Apple TV | Safari WebView |
| Amazon Fire TV | Silk browser |
| Chromecast / AirPlay | Mirroring target |
| Any modern Smart TV browser | Progressive web fallback |

---

## Pages

| Page | Component | Purpose |
|------|-----------|---------|
| Home | `pages/Home.tsx` | Live hero (v2 player) + categorized sermon rows |
| TV Guide | `pages/TVGuide.tsx` | Schedule grid for today's broadcast slots |
| Search | `pages/Search.tsx` | Full on-screen keyboard with real-time filter |
| Video Details | `pages/VideoDetails.tsx` | Metadata, description, "Up Next" rail |
| Player | `pages/Player.tsx` | Full-screen playback (HLS, MP4, YouTube embed) |
| 404 | `pages/not-found.tsx` | Fallback |

---

## D-pad navigation

`hooks/useTVNav.ts` is the single navigation engine for all remote-control input:

- **↑ / ↓** — move between rows
- **← / →** — move between items in the focused row
- **↑ from top row** — enter header zone (Search / Guide)
- **Enter** — open details or play the live banner
- **Backspace / Esc** — return
- **S** — jump to Search, **G** — jump to TV Guide

---

## Player architecture (v2)

The TV live player uses `LiveBroadcastV2.tsx`, which integrates `@workspace/player-core`:

```
V2Transport (WS-first, SSE fallback)
        │
        ▼
PlayerMachine (A/B-buffer FSM)
        │
        ├── Buffer A  (<video> element via HlsVideoPlayer / attachHls)
        └── Buffer B  (<video> element via HlsVideoPlayer / attachHls)
```

Used in both `LiveHero` (homepage hero) and `Player` (full-screen page).

**Sync-aware join:** every viewer joins the live timeline at the exact server-calibrated second currently airing. Clock offset (`serverTimeMs − Date.now()`) is measured from each WS/SSE frame and applied to `resolvePositionSecs()` so the player seeks to the correct position regardless of local OS clock skew.

**Stall watchdog:** 3-phase adaptive threshold (20 s initial load → 15 s rebuffer → 25 s stable). Fires `buffer-stalled` → `onBufferError` → retry / failover / skip.

---

## Source layout

```
artifacts/tv/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main.tsx
    ├── App.tsx                         ← page switch + QueryClientProvider
    ├── lib/
    │   └── api.ts                      ← fetchVideos, fetchLiveStatus
    ├── hooks/
    │   ├── useTVNav.ts                 ← D-pad focus engine
    │   ├── useData.ts                  ← memoized byCategory catalog
    │   ├── useGuide.ts                 ← schedule loader
    │   ├── useSearch.ts                ← debounced filter
    │   └── useLiveSync.ts              ← v1 SSE hook (chat, graphics, viewer count)
    ├── pages/
    │   ├── Home.tsx
    │   ├── TVGuide.tsx
    │   ├── Search.tsx
    │   ├── VideoDetails.tsx
    │   ├── Player.tsx
    │   └── not-found.tsx
    └── components/
        ├── LiveBroadcastV2.tsx         ← v2 player (PlayerMachine + V2Transport)
        ├── HlsVideoPlayer.tsx          ← hls.js for .m3u8, native <video> for MP4/WebM/MOV
        ├── LiveHero.tsx                ← homepage live banner (v2)
        ├── BroadcastInfoStrip.tsx      ← title + countdown overlay
        ├── AuthGateModal.tsx           ← TV pairing code + templetv.org.ng/link prompt
        ├── SermonRow.tsx
        ├── SermonCard.tsx
        └── Clock.tsx
```

---

## Playback components

| Component | Used for | Mechanism |
|-----------|----------|-----------|
| `LiveBroadcastV2.tsx` | Live broadcast hero + full-screen player | `PlayerMachine` A/B buffer, `V2Transport` WS/SSE |
| `HlsVideoPlayer.tsx` | HLS playlists + direct MP4/WebM/MOV | hls.js for `.m3u8`; native `<video>` for progressive video (URL-extension routing) |
| YouTube embed | YouTube items in Player page | `youtube-nocookie.com` iframe, 12 s watchdog with 2 silent retries |

All playback: `referrerPolicy=strict-origin-when-cross-origin`, auto-hiding controls after 4 s, no redirect to youtube.com.

---

## TV ↔ Mobile pairing

When an unauthenticated viewer opens the TV app, `AuthGateModal` displays a 6-character code and instructs them to visit **`templetv.org.ng/link`** on their phone. The mobile `/link` route claims the code, creating or signing in the user and passing the session back to the TV app.

---

## Development

```bash
pnpm --filter @workspace/tv run dev          # Vite dev server
pnpm --filter @workspace/tv run build        # production build → dist/
pnpm --filter @workspace/tv run typecheck
```

To point at a local API:

```env
VITE_API_URL=http://localhost:8080
```

---

## Build & package

```bash
# Web build (generic)
pnpm --filter @workspace/tv run build

# Samsung Tizen
pnpm --filter @workspace/tv run build:tizen   # → dist/tizen/
pnpm --filter @workspace/tv run package:tizen  # → .wgt file

# LG webOS
pnpm --filter @workspace/tv run build:lg       # → dist/lg/
pnpm --filter @workspace/tv run package:lg     # → .ipk file

# Amazon Fire TV
pnpm --filter @workspace/tv run build:firetv   # → dist/firetv/
```

For CDN deployment: `bash scripts/deploy-tv-cdn.sh` (uploads to S3 + invalidates CloudFront).

---

## Related

- [`@workspace/api-server`](../api-server/README.md)
- [`@workspace/player-core`](../../lib/player-core/README.md)
- [`@workspace/broadcast-sync`](../../lib/broadcast-sync/README.md)
- [`RELEASE_PIPELINE.md`](../../RELEASE_PIPELINE.md)
- Project [README](../../README.md)
