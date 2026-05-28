---
name: Enterprise hardening sprint 4
description: 17 fixes across transport reliability, admin panel stale-state, zero-dead-air, gapless playback, and 2 bonus TS fixes.
---

## Transport (lib/player-core/src/transport.ts)
- `DEAD_SOCKET_THRESHOLD_MS` 14 000 → 22 000 (1.4× → 2.2× heartbeat margin, reduces flapping on mobile networks)
- `WS_FAIL_STREAK_SSE_FALLBACK` 2 → 3 (fewer spurious SSE fallbacks on transient WS blip)
- EMA clock calibration: `clockEmaInitialized` field + `updateClockOffset()` method — first packet sets directly, subsequent packets blend at α=0.15 so a single rogue timestamp can't skew sync
- `forceReconnect` jitter normalized to `INITIAL_BACKOFF_MS * 0.5` instead of hardcoded 300 ms

**Why:** All four fixes reduce unnecessary reconnect cycling on weak/mobile networks without increasing recovery latency.

## Admin Panel (artifacts/admin/src/pages/)
- `operations.tsx`: engineHealth `refetchInterval` 30 s → 15 s
- `stream-health.tsx`: diagnostics `refetchInterval` 30 s → 10 s + SSE `broadcast-queue-updated` invalidates diagnostics query
- `dashboard.tsx`: reads `sseState` from `useSSE()` and shows grey "Stale" badge on the On-Air tile when SSE is `disconnected`
- `broadcast-v2.tsx`: renamed inner component to `BroadcastV2PageInner`, wrapped with `ErrorBoundary` from `@/components/shared/error-boundary`
- `broadcast-v2.tsx` PageHeader `actions`: added "Restart Engine" button (POST `/broadcast-v2/reload`, shows `Loader2` spinner while busy, tooltip explains what it does) alongside existing "Launch Checklist"

**Why:** Admin operators need real-time visibility and one-click recovery without hunting through operator controls.

## Zero Dead Air (artifacts/api-server)
- `broadcast-orchestrator.ts` `start()`: emits `WARN` at boot if `EMERGENCY_FILLER_URL` is missing, not a valid URL, or not http(s). Message tells operator exactly what to configure.
- `auto-enqueue.service.ts` `scanLibraryAndEnqueue` reason type: added `"self-heal-all-blocked"` to union (was causing TS error when orchestrator called it with that reason)

## Gapless Playback / TV (artifacts/tv/src/components/HlsVideoPlayer.tsx)
- ABR stall-drop recovery timer now fires even at `currentLevel === 0` (previously the `setTimeout` was inside the `currentLevel > 0` guard so level-0 streams never recovered)
- Added `LEVEL_LOAD_ERROR` to stall detection events

## Mobile (artifacts/mobile/components/V2PlayerContainer.tsx)
- Fixed stale comment: `LOAD_TIMEOUT_MS` comment said "(10 s)" but `BUFFERING_STALL_THRESHOLD_MS = 15_000`

## Bonus TS fixes (both were pre-existing, not regressions)
- `faststart-recovery.ts` `backfillPlaceholderDurations`: type annotation `objectPath: string` → `string | null` (WHERE clause already has `isNotNull(v.objectPath)`, usage has `!` assertion)
- `auto-enqueue.service.ts`: added `"self-heal-all-blocked"` to reason union as noted above

## How to apply
- `EMERGENCY_FILLER_URL` warn fires every cold boot — suppressed by setting a valid `https://` HLS/MP4 URL in Replit secrets.
- `scanLibraryAndEnqueue` can now be called with any of: `"yt-sync" | "self-heal-empty" | "self-heal-all-blocked" | "manual"` — keep these in sync if new callers are added.
