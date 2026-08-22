---
name: Safe nav push pattern — player navigation telemetry
description: navLogger + safeNavPush/safeNavReplace wrappers that guard every /player navigation call site; implemented Jul 2026.
---

# Safe navigation wrapper for /player call sites

## The rule
Every `router.push` or `router.replace` that targets `/player` (or any screen where a silent failure strands the user) MUST go through `safeNavPush`/`safeNavReplace` from `@/lib/safeNavPush`. Plain `router.push` is fine for non-critical in-app routing (login, settings, back nav).

**Why:** Expo Router can throw on rapid taps, mid-animation state, or when the navigator hasn't fully attached yet (cold start). Bare `router.push` silently discards the error — the user sees nothing and can't enter the player. `safeNavPush` try/catches, retries once after 300ms, and sends Sentry breadcrumbs + exceptions.

**How to apply:**
- Replace `router.push({ pathname: "/player", params: {...} })` with `safeNavPush("/player", {...}, "source-tag")`.
- Replace `router.replace(...)` targeting the player with `safeNavReplace("/player", {...}, "source-tag")`.
- Source tags are short kebab-case strings identifying the call site ("home-hero", "channels-live", "notification:live", "player-related", etc.). They appear in Sentry breadcrumbs.
- For non-player navigations (settings tabs, login/signup flows, go-back), bare `router.push/replace` is acceptable.

## Async recovery must revalidate every dispatch

Route-recovery callbacks that can resolve after user input (initial links, incoming links, notification fallbacks) must not replace a valid current route or compete with an active push. A guarded replace must re-run its live route/push predicate before both its first dispatch and every delayed retry.

**Why:** Android can resolve the initial URL after the user taps Watch. An unconditional Home replace—or a retry scheduled before the tap—can overwrite `/player` and remount Home, producing a skeleton refresh instead of the Player.

**How to apply:** Keep current pathname in a render-ref, check the active-push latch, avoid replacing known routes (including Home), and pass a live guard into any retrying replace helper. Never rely only on a check made when the async callback first started.

## navLogger
`@/lib/navLogger` is a 30-event ring buffer + Sentry breadcrumbs + `__DEV__` console. Three events form the full session timeline:
1. `logAttempt` — fired by `safeNavPush` before the push
2. `logSuccess` — fired by `safeNavPush` after a successful push (call accepted by router)
3. `logSuccess` with source `player-mount:${surface}` — fired by `player.tsx` `useEffect` after first render

## Files with safeNavPush
- `lib/safeNavPush.ts` — the wrapper implementation
- `lib/navLogger.ts` — the ring buffer + Sentry bridge
- `app/(tabs)/index.tsx` — hero, mini-bar, continue-watching
- `app/(tabs)/channels.tsx` — live channel tap + schedule card
- `app/(tabs)/library.tsx` — sermon card + continue-watching
- `app/player.tsx` — navigateToRelated (safeNavReplace), mount telemetry
- `app/downloads.tsx`, `app/favorites.tsx`, `app/history.tsx`, `app/watch-later.tsx`
- `app/search.tsx`, `app/playlists/[id].tsx`, `app/series/[slug].tsx`
- `app/_layout.tsx` — notification handler (all types), deep-link guard
- `components/LiveBroadcastSupervisor.tsx` — SSE-triggered auto-nav

## Hero Watch availability (index.tsx)
Every non-fatal hero state renders the same Watch button. Do not hide it while loading, reconnecting, idle, or off-air; the existing player screen is the authoritative connection and recovery UI.

## isFatal Reconnect button (index.tsx)
When `isFatal=true`, the Reconnect button now calls BOTH `forceRebind()` AND `navigateToLive(...)` — the player's own recovery UI is superior to the home screen spinner.
