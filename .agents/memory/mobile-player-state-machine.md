---
name: Mobile player state machine + responsive design system
description: Architecture for useMediaPlayerState, StreamStatusBadge, StreamStatusOverlay, useBreakpoint, and library tablet grid
---

## Global media player state machine — `hooks/useMediaPlayerState.ts`

Single hook that reads from NetworkContext + V2BroadcastNative + PlayerContext and derives a canonical `MediaPlayerState` enum: `idle | loading | live | reconnecting | offline | error`.

**Key computed flags:**
- `isWatchLiveCTAVisible` — true ONLY in `idle | offline | error` states. Always false during `live | loading | reconnecting`.
- `isAlreadyLive` — true during `live` (player already connected and playing).
- `isReconnecting` — true during `reconnecting` (shows reconnecting UI, suppress new CTA).
- `isFatal` — true when V2 transport enters fatal/irrecoverable state.

**Why:** Prevents "Watch Live" CTA appearing while already live (double-tap confusion). Normalises all consumers to one source of truth instead of each screen independently reading snapshot.fsmState.

**How to apply:** All mobile screens needing live-awareness import this hook. Never duplicate the state derivation logic inline.

## StreamStatusBadge — `components/StreamStatusBadge.tsx`

Three variants: `compact` (inline pill), `pill` (larger), `banner` (full-width).
States: `live`=red pulsing dot, `loading`=purple spinner, `reconnecting`=amber spinner, `offline`=gray, `error`=red.

Use `variant="compact"` inline next to channel names. Use `variant="banner"` in full-screen overlays.

## StreamStatusOverlay — `components/StreamStatusOverlay.tsx`

Full-surface overlay with exponential-backoff auto-retry countdown. NOT for use inside `V2PlayerContainer` (which has its own resilience UI). Use on standalone surfaces only (e.g. a future standalone "watch live" modal).

## useBreakpoint — `hooks/useBreakpoint.ts`

Reads `Dimensions` and returns `isTablet` (≥768), `isLargePhone` (≥480), `columnCount`, `getCardWidth(cols)`.
Source of truth: `BREAKPOINT` map in `constants/design.ts`.

## Library tablet grid pattern

```tsx
const { isTablet, getCardWidth: getTabletCardWidth } = useBreakpoint();
const numCols = isTablet ? 2 : 1;
const tabletCardWidth = isTablet ? getTabletCardWidth(2) : 0;

// FlatList:
numColumns={numCols}
key={numCols}                           // forces re-render on rotation
columnWrapperStyle={numCols > 1 ? styles.columnWrapper : undefined}
getItemLayout={isTablet ? undefined : /* phone fast-path */ }

// renderItem:
if (isTablet) return <VideoCard sermon={item} cardWidth={tabletCardWidth} onPress={...} />;
return <SermonCard sermon={item} variant="horizontal" onPress={...} />;
```

**Why:** SermonCard horizontal is optimal for phones (dense list). VideoCard accepts `cardWidth` prop and is designed for grid use. `key={numCols}` is required — React Native FlatList crashes on numColumns change without it.

**Note:** `getItemLayout` must be disabled on tablet (cell heights are dynamic for card grid; only safe for fixed-height phone list rows).
