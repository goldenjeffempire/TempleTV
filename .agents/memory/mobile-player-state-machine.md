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

## Skeleton loading wiring

All skeleton components live in `components/SkeletonCard.tsx`. Wire them in as follows:
- **Library videos loading**: `Array.from({length:5}).map((_,i) => <SkeletonHorizontalCard key={i} />)` in a `skeletonList` View
- **Library series loading**: `Array.from({length:3}).map((_,i) => <SkeletonSeriesCard key={i} />)` in same `skeletonList` View  
- **Channels loading**: `Array.from({length:3}).map((_,i) => <SkeletonChannelCard key={i} />)` in `channelList` View
- Home screen already has `SkeletonHero` + `SkeletonVerticalCard` rows (complete)

Never replace "load more" footer spinners with skeletons — `ActivityIndicator` is correct there.

## Hero streaming resilience

Three-state CTA priority chain in `HeroSection`:
1. `isFatal === true` → red "Reconnect" `<Pressable onPress={forceRebind}>` (highest priority)
2. `isWatchLiveCTAVisible` (idle/offline/error, !fatal) → brand-color "Watch Live" / "Watch Now"
3. `!isWatchLiveCTAVisible && !isReconnecting` → ghost "Open Player" secondary button
4. `isReconnecting` → no button (StreamStatusBadge provides amber spinner feedback)

Destructure `forceRebind` from `useV2BroadcastNative()` alongside `snapshot`.
Destructure `isFatal` from `useMediaPlayerState()`.

## Channels category grid — tablet responsiveness

`CategoryTile` calls `useBreakpoint()` directly and applies `styles.categoryTileTablet` (`width: "31%"`) on tablets,
giving a 3-column grid versus the phone default `width: "47.5%"` (2-column).

## LINE_HEIGHT system — where applied

- `SectionHeader.tsx`: `title` = `LINE_HEIGHT.xl` (26), `subtitle` = `LINE_HEIGHT.sm` (17)
- `channels.tsx categoryTileLabel`: `LINE_HEIGHT.lg` (22); `categoryTileDesc`: `LINE_HEIGHT.xs` (15)

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
