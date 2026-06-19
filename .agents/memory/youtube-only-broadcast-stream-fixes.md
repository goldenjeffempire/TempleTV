---
name: YouTube-only broadcast stream fixes
description: Root causes and fixes for broadcast not showing on TV/mobile when library is YouTube-only (ytShuffleFallback path)
---

## Root Causes

### 1. TV Web — YouTube iframe missing `mute=1` (CRITICAL)
Both YouTube override iframes in `LiveBroadcastV2.tsx` used:
```
https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1
```
Missing `mute=1` causes browsers to block autoplay (autoplay-with-sound policy) → video silently never starts → black screen.

**Fix:** Use `youtube-nocookie.com` + add `mute=1&controls=0&playsinline=1&iv_load_policy=3&disablekb=1`.

### 2. Server — ytShuffleFallback 30-second startup dead-air
The selfHealEmptyTimer activates ytShuffleFallback only after `EMPTY_POLLS_BEFORE_LIBRARY_SCAN × SELF_HEAL_EMPTY_MS` (6 × 5s = 30s) because it requires a library scan to complete first. Every server restart = 30s of dead-air before YouTube shuffle kicks in.

**Fix:** In `reloadInner()`, in the `resolved.length === 0` branch, immediately `void ytShuffleFallback.activate(...)` when `!isActive && mode !== "override" && !DISABLE`. Fire-and-forget (non-blocking). Since it's `void`, it runs asynchronously — by the time `startOverride()` executes, `this.started` is already true (set after `reloadInner` returns). Result: **45ms** instead of **30s**.

**Critical:** Do NOT add `this.started` as a guard in `reloadInner` for this path — `reloadInner` runs from `start()` BEFORE `this.started = true` is set (line 641 in orchestrator). The async fire-and-forget means `startOverride` executes after `this.started = true`.

### 3. Mobile — YouTube override shows static info card
`V2PlayerContainer.tsx` renders "This broadcast is airing on YouTube" text only. No way to actually watch content.

**Fix:** Added `youtubeUrl?: string | null` field to `OverlayContent` interface. When set, renders a "Watch on YouTube ▶" `Pressable` that calls `Linking.openURL(url)` to open the YouTube app/browser. Added `Linking` to react-native imports.

## Architecture Notes
- `hydrate: dropping stale override mode` fires on every restart (intentional — override not persisted). The fast-path fix in `reloadInner` compensates by re-activating ytShuffle within 50ms.
- TV web YouTube iframe: `snapshot.state === "LIVE_OVERRIDE_ACTIVE"` + `override.kind === "youtube"` → overlay returns `null` (correct) and iframe renders at zIndex 5.
- Mobile: `isYouTubeOverride = state === "LIVE_OVERRIDE_ACTIVE" && activeItem.kind === "youtube"` → triggers branded overlay (no native expo-av playback possible for YouTube URLs).
