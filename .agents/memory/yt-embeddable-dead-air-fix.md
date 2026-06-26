---
name: YouTube non-embeddable dead-air fix
description: Multi-layer fix for dead air caused by YouTube shuffle picking non-embeddable videos (error codes 100/101/150).
---

## Rule
Non-embeddable YouTube videos (e.g. "embedding disabled by owner") cause silent dead air on TV and web surfaces — the server sees override active and healthy, but clients show "Video unavailable". Fix requires **three layers** working together:

1. **DB filter** (`is_embeddable` column on `managed_videos`, default `true`). YouTube sync fetches the `status` part from the Data API (`videos.list`) and persists `embeddable: item.status?.embeddable !== false` (defaults true on any API miss). RSS fallback paths assume `embeddable: true` (RSS has no status data). `ytShuffleFallback.activate()` and `refreshCatalog()` filter `eq(isEmbeddable, true)`.

2. **Client error reporting** (`POST /api/broadcast-v2/yt-playback-error`). No-auth endpoint, 30/min rate-limit, 30 s dedup per videoId. When the server's current override matches the reported videoId, calls `ytShuffleFallback.advance()` immediately. TV player (`LiveBroadcastV2.tsx`) and admin console (`broadcast-v2.tsx`) both listen on `window.message` for YouTube iframe `onError` events with codes 100/101/150.

3. **YouTube API `status` part quota**: the `status` part adds 0 quota units on top of `contentDetails+statistics` — it's free to request. Always default `embeddable: true` when the field is absent to avoid falsely excluding valid videos when API key is invalid or quota-exhausted.

**Why:** YouTube can disable embedding at any time without notice. The DB filter prevents newly-synced unembeddable videos from entering the shuffle; the client error reporting self-heals within seconds if an existing video becomes unembeddable between syncs.

**How to apply:** When adding new video sources to ytShuffleFallback, always filter `eq(isEmbeddable, true)`. Any client surface that embeds a YouTube iframe for the live override should wire the `window.message` → `/yt-playback-error` handler.
