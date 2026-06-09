---
name: Production audit sprint 82
description: Backend 429 schema fixes across 6 route files + 2 admin panel query-invalidation fixes + mobile versionCode bump for v1.0.15 Android .aab release
---

## Fixes applied

### Backend — missing 429 response schemas
All missing `z` imports were added alongside the schema fixes.

| File | Routes fixed |
|---|---|
| `youtube-live.routes.ts` | GET `/`, GET `/status`, POST `/:broadcastId/start`, POST `/:broadcastId/stop` — 4 routes |
| `midnight-prayers.routes.ts` | GET `/`, GET `/state`, POST `/test-send`, PATCH `/config`, DELETE `/log/:id`, DELETE `/log` (+ SSE keepalive `setInterval` now has `.unref()`) — 7 routes |
| `youtube-channel.routes.ts` | GET `/rss`, GET `/videos`, GET `/live-status` — 3 routes |
| `seo.routes.ts` | GET `/sitemap-sermons.xml`, GET `/podcast.xml` — 2 routes |
| `well-known.routes.ts` | GET `/.well-known/assetlinks.json`, GET `/.well-known/apple-app-site-association` — 2 routes |
| `media-proxy.routes.ts` | GET `/media-proxy` — 1 route |

### Admin panel — missing query invalidations
- `youtube-sync.tsx` `triggerMutation`: missing `admin-videos` invalidation (sync imports new videos into library)
- `youtube-sync.tsx` `recategorizeMutation`: missing `admin-videos` invalidation (recategorize updates library-visible category/preacher fields)

### Mobile
- `app.json` `android.versionCode` bumped 52 → 53 for v1.0.15 Android production build

**Why:** Routes using a rate-limit config object but lacking a `response: { 429: ... }` schema block cause TypeScript TS2345/TS2353 errors and produce undocumented 429 responses in production. Every rate-limited route must declare the 429 schema.

**How to apply:** When adding a new rate-limited route, always include `schema: { response: { 429: z.object({ error: z.string() }) } }` (or the local `_429err` alias) alongside the `config: { rateLimit: {...} }` block.
