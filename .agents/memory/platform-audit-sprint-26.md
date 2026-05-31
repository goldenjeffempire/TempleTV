---
name: Comprehensive platform audit — sprint 26
description: 4 bugs fixed across mobile hooks and API error tracking. Extensive false-positive triaging documented for API, TV, Admin, transcoder, and infra subsystems.
---

## Bugs Fixed

### 1. useFavorites stale-closure AsyncStorage race condition (HIGH)
- `addFavorite` and `removeFavorite` closed over the React `favorites` state. Two rapid calls
  (e.g., double-tap on a favorite button before re-render) would both read the same stale list,
  causing one update to be silently dropped.
- Fix: Added `favoritesRef = useRef<Sermon[]>([])`. Updated in all 3 write paths:
  - Initial AsyncStorage load (sets ref when hydrating from storage)
  - Cloud-sync merge path (`apiGetFavorites` → merge → `favoritesRef.current = merged`)
  - `persist()` — updates ref *before* `setState` so same-tick calls see the fresh list
- `addFavorite` and `removeFavorite` now read `favoritesRef.current`, not `favorites`.
  Deps arrays tightened to `[persist]` only.
- File: `artifacts/mobile/hooks/useFavorites.ts`

### 2. useNotificationPreferences stale-closure race condition (MODERATE)
- `save(update)` closed over `prefs` state. Toggling two notification switches faster than
  a re-render would cause the second toggle to overwrite the first because both closures
  captured the same initial `prefs` value.
- Fix: Added `prefsRef = useRef<NotifPrefs>(DEFAULT)`. Kept in sync on load (`prefsRef.current = loaded`)
  and updated before `setPrefs` in `save`. `save` deps array now `[]` (no longer needs `prefs`).
- File: `artifacts/mobile/hooks/useNotificationPreferences.ts`

### 3. Sentry 500 errors missing user context (LOW)
- The global error handler (`error-handler.ts`) logged 500 errors to pino but never called
  `captureException`, so Sentry received no server-side 500 traces at all.
- Fix: Added `import { captureException } from "../infrastructure/sentry.js"` and
  `void captureException(err, { requestId, userId, userRole, method, path })` inside the `status >= 500` branch.
  Uses `req.principal?.id / .role` (optional chaining — safe if unauthenticated) and
  `req.routeOptions?.url` (template path, not raw URL) to avoid PII/token leakage in breadcrumbs.
- File: `artifacts/api-server/src/middleware/error-handler.ts`

**Why:** `req.routeOptions.url` gives the route pattern (e.g. `/api/v1/videos/:id`) rather than
the actual URL (`/api/v1/videos/abc123?token=...`), so no path PII or query-string tokens leak.

## Confirmed False Positives (Sprint 26)
- **API auth**: Token rotation, session revocation, role enforcement — all correct.
- **API rate limits**: Brute-force guard, path-normalization bypass — already fixed in prior sprints.
- **FFmpeg stream cleanup**: Node.js cleans up piped streams when child exits/is SIGKILL-ed.
  Explicit `destroy()` calls not needed; FD exhaustion risk is bounded by one-at-a-time dispatcher.
- **TV HLS lifecycle**: Proper destroy in `unbind` and `detachElements`; double-attach prevented.
- **TV D-pad focus traps**: All intentional (modal pattern), with BACK mapped to onClose.
- **Admin aria-labels**: Action buttons already have `aria-label={\`Actions for ${v.title}\`}`.
- **Admin double-submit**: Upload singleton engine prevents duplicates; dialog closes before engine runs.
- **Admin TanStack Query**: Stale-closure risk is only theoretical; all current queryKeys include deps.
- **DB unique constraints**: All high-traffic tables have correct unique indexes (broadcast_queue, user_favorites, playlist_videos, series_episodes).
- **lower(email) index**: Already in `infrastructure/db.ts` as `idx_users_email_lower`.
