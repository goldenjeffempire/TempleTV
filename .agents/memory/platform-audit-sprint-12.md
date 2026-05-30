---
name: Comprehensive platform audit — sprint 12
description: 5 bugs fixed from 4-parallel auditor sprint across Admin, Mobile, DB schema; key false positives documented.
---

## Fixes applied

### Admin Frontend
1. **`alerts.tsx` queryFn swallowed errors** — `.catch(() => ({ alerts: [] }))` meant `error` was always null and the already-present `<ErrorAlert>` never rendered. Operators saw "0 active alerts" even when the API was completely down. Removed the `.catch()`.
2. **`chat.tsx` queryFn swallowed errors** — `.catch(() => ({ messages: [], stats: undefined }))` same pattern; chat moderation page never showed errors. Removed the `.catch()`.

### Mobile
3. **`VideoCard.tsx` missing `React.memo`** — Component re-renders on every parent render during heavy catalog scroll. Wrapped in `React.memo`; export changed from `export function VideoCard` to `export const VideoCard = React.memo(function VideoCard(...))`.

### DB Schema
4. **Missing CHECK constraint on `transcodingStatus`** (`lib/db/src/schema/videos.ts`) — A typo, bad migration, or rogue SQL could silently write an unrecognised status value without any DB-level rejection. Added `check("managed_videos_transcoding_status_check", sql\`${table.transcodingStatus} IN ('none','queued','encoding','processing','ready','failed')\`)`. Added `check` to pg-core import, `sql` from drizzle-orm. Migration applied.

## False positives from audit (confirmed OK, no fix needed)
- **TV `HlsVideoPlayer.tsx` STALL_FAIL_MS(15s) > WATCHDOG_MS(9s)** — INTENTIONAL by design. The code comment at lines 96-101 explicitly documents: watchdog (9s) handles the one-shot initial-load failure; STALL_FAIL_MS (15s) covers stalls during ongoing playback. NOT a double-recovery bug.
- **`lib/api-zod/src/index.ts` deletion stub** — No consumer imports from `@workspace/api-zod` (grep returns empty). The stub exists for workspace install compatibility only; nothing calls it at runtime.
- **`lib/api-client-react` AdminStats `recentImports: 0`** — Documented as intentional at line 258-263: "flat aliases derived from RawAdminStats... live-status fields default to safe values." The 0 is a known safe default, not a data bug.
- **`chat.ts` userId nullable** — INTENTIONAL for anonymous chat. Anonymous users are tracked via `ipHash` (indexed). The chat module enforces rate limiting via ipHash for unauthenticated senders.
- **`operations.tsx` `.catch(() => null)` on engineHealth / system-metrics** — INTENTIONAL resilience pattern. null means "unavailable" and the component gracefully shows blanks/zeros rather than crashing. The `isEngineStuck` guard correctly skips when health check is itself unavailable.
- **TV `vite.config.ts` `allowedHosts: true`** — Required for Replit's proxied preview environment. Vite dev server only; TV production is served from static CDN (CloudFront), not Vite.
- **TV `useTVNav.ts` missing `headerItemCount` dep** — Already present in the `useEffect` dep array at line 130. Audit false positive.
