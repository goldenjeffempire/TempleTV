---
name: LiveHero broadcast-v2 gating pattern
description: Three co-located bugs that prevent LiveBroadcastV2 from mounting in TV hero when broadcast is in override/shuffle-fallback mode.
---

## The rule

`LiveHero.tsx` must gate `LiveBroadcastV2` on `!isLive`, NOT on `broadcastItem !== null` (hasBroadcast). The v2 component is fully self-contained and handles override mode, empty-queue mode, and FATAL recovery internally.

## Why

When the broadcast engine is in YouTube shuffle-fallback override mode (triggered automatically after the local queue empties), `broadcastItem` from the legacy `/api/playback/state` endpoint is `null` — even though the engine IS actively serving content via an override. Three bugs co-exist:

1. `showLiveBroadcast = hasBroadcast && !broadcastVideoFailed` → `LiveBroadcastV2` never mounts (black hero).
2. Metadata panel `hasBroadcast ?` branch → shows "OFF AIR · 24/7 ON DEMAND" when engine is running.
3. `Home.tsx onSelect __live__` (channel grid) has no `else` clause → clicking "Tune In" is a no-op when `broadcastCurrent?.item` is null.
4. `Home.tsx` hero `onSelect` prop (LiveHero) has no `else` clause → same no-op for clicking the hero card itself.

## How to apply

**`artifacts/tv/src/components/LiveHero.tsx`**:
- `showLiveBroadcast = !isLive && !broadcastVideoFailed` (remove `broadcastItem !== null` gate)
- Metadata panel ternary: `isLive ? StateYTLive : !isLive ? StateBroadcast : StateOffAir` (the third branch is now dead code — acceptable, since the truly-off-air state is owned by `LiveBroadcastV2`'s own overlay)
- Remove the derived `hasBroadcast` constant (dead code after the above changes)

**`artifacts/tv/src/pages/Home.tsx`** — TWO places need the else clause:
1. `onItemSelect` callback for `__live__` row (channel grid navigation)
2. `onSelect` prop passed to `<LiveHero>` (clicking the hero card directly)

Both use the same sentinel:
```tsx
} else {
  // Override / shuffle-fallback mode — no queue item in legacy snapshot.
  // LiveBroadcastHlsPlayer is self-contained; pass sentinel hlsUrl to route there.
  onPlay("broadcast-v2", "Temple TV", "broadcast-v2", 0, true);
}
```
`Player.tsx` routes `if (hlsUrl && isLive)` → `LiveBroadcastHlsPlayer`, which uses `LiveBroadcastV2` directly.

## Invariants that must NOT change
- `enableStallReport: false` on ALL admin/preview surfaces (never blacklist sources from monitoring views)
- Admin `BroadcastPreviewV2` is unconditionally rendered — no gating needed there
- `LiveBroadcastHlsPlayer` ignores `hlsUrl` and `videoId` — it connects to broadcast-v2 directly
