---
name: Mobile player/watch page root causes and permanent fixes
description: Full root-cause analysis + fixes for the Temple TV mobile app player screen failing to open.
---

## Root causes (in order of impact)

### 1. Missing EXPO_PUBLIC_API_URL in dev (PRIMARY — FIXED)
`getApiBase()` returns `""` when no env var is set and `window.location.origin` is unavailable on native.
- With `apiBase=""`, `BroadcastHlsPlayer` passes `baseUrl="/api/broadcast-v2"` to V2PlayerContainer.
- `useV2BroadcastNative` in `react-native.ts` accepts any truthy string (even relative), tries to construct WS URL → `ws:///api/...` on native → silent connection failure → FSM stays in BOOTSTRAP.
- `hasActiveBroadcast = false` and `fallbackSermon = null` (API also unreachable) → `watchNowDisabled = true`.
- Watch Now button HIDDEN → player screen **never opens**.

**Fix:** Created `artifacts/mobile/.env.local` with `EXPO_PUBLIC_API_URL=https://api.templetv.org.ng`.

### 2. `watchNowDisabled` gated player navigation (SECONDARY — FIXED)
`watchNowDisabled = !hasActiveBroadcast && !fallbackSermon` disabled both the outer Pressable and all CTA buttons in `HeroSection`. During any API-unreachable period, this permanently blocked navigation.

**Fix:** Set `watchNowDisabled = false` permanently. Added `else` branch in `handleTuneIn` to always navigate to the live player (which shows its own off-air/connecting state).

### 3. lib vs vendor player-core comment drift (MINOR — FIXED)
`lib/player-core/src/react-native.ts` had a stale `@ts-expect-error` directive that the vendor version already removed. Synced them.

## Architecture notes (for future debugging)

- `BroadcastHlsPlayer` is at `artifacts/mobile/components/player/BroadcastHlsPlayer.tsx` (not top-level components/).
- `getOrCreateSession` in `react-native.ts` returns `null` when `!baseUrl` — so **empty string** `""` is safe; it's **relative strings** like `"/api/..."` that cause the silent WS failure (truthy but invalid URL on native).
- `.env.local` is loaded by Expo **before** `.env.production`. Expo CLI log line `"env: load .env.local"` confirms successful load.
- Mobile workflow reads: `pnpm --filter @workspace/mobile run dev` → Expo dev server on port 18115.
- React Native DevTools `libglib-2.0.so.0` error in Replit is non-fatal — Expo still serves the app.

## Comprehensive logging added (July 2026)

Three __DEV__ logging hooks added to make the player pipeline fully observable:
1. `BroadcastHlsPlayer.tsx` — logs apiBase validation on mount, errors when empty/relative.
2. `V2PlayerContainer.tsx` — logs every FSM state transition: `BOOTSTRAP → SYNCING → PLAYING` etc. Label includes minimal/suppressed/primary role + connected status + baseUrl.
3. `player.tsx` — logs routing decision on mount (surface chosen, key params, apiBase check).
4. `HeroSection` (index.tsx) — logs handleTuneIn decision + fallback path.

**Why:** The FSM/WS failure is completely silent otherwise. These logs cut debugging time from "trace the entire pipeline" to "look at Expo console".
