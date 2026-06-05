---
name: Mobile broadcasting sprint 41 — confirmed fixes and false positives
description: Outcome of the sprint-41 mobile 24/7 playback audit; what was fixed vs already fixed vs intentional.
---

## Fixed in this sprint

### BroadcastBuffer load-timeout watchdog stale-closure (V2PlayerContainer.tsx)
**Rule:** The 12-second silent-failure load-timeout watchdog in BroadcastBuffer's `bindRevision` effect used `suppressEvents` (prop value) directly rather than `suppressEventsRef.current`. Since the effect only re-runs on `[state.bindRevision]` changes, a fullscreen toggle (which changes `suppressEvents` but not `bindRevision`) left the stale value. Changed to `!suppressEventsRef.current` to match the pattern used correctly in the `isBuffering` watchdog.

**Why:** The inline player transitions from `suppressEvents=false` → `suppressEvents=true` when fullscreen opens. The stale closure meant the load-timeout watchdog could arm on the suppressed instance and fire `buffer-error` → `RECOVERING_PRIMARY`, disrupting the fullscreen stream.

### BroadcastBuffer `onError` memoized via `useCallback` (V2PlayerContainer.tsx)
**Rule:** Added `const handleError = useCallback(...)` before the conditional early-return in BroadcastBuffer, placed before the `if (!url)` guard to satisfy Rules of Hooks (cannot call hooks after a conditional return). Replaced the inline `(error) => { ... }` lambda with `onError={handleError}`.

**Why:** The inline lambda created a new function reference every 500 ms (on every `progressUpdateIntervalMillis` tick), defeating the purpose of `React.memo` on BroadcastBuffer and adding needless re-render work.

**How to apply:** Any new `useCallback` in BroadcastBuffer must be placed before the `if (!url)` early-return at line ~778 (line numbers shift with edits). The inline lambda in `onError` was the only unstable prop.

## Already fixed (sprint-39 candidates — no action needed)

- **`onOnline()` snapshot gap** — already calls `this.onNeedSnapshotCb?.()` at line 1048 of machine.ts.
- **`suppressBanner overlayContent` clause** — comprehensive formula already present (checks PLAYING / HANDOFF / PREPARING_NEXT / LIVE_OVERRIDE_ACTIVE plus `!!overlayContent`).
- **`fsHideTimerRef` cleared on unmount** — cleanup effect already clears it.
- **Fullscreen Modal `isLive && !isHls && !isYoutube` path** — `isLive` fallback branch already rendered `<BroadcastHlsPlayer initialUrl="" .../>` at line 1453 of player.tsx; was NOT a bug in current code.

## Intentional (not bugs)

- **VOD quick-finish retry `playFromPositionAsync(0)`** — Restarting from position 0 is correct for a quick-finish retry: the source either had a bad seek target (position > actual duration) or a spurious end event. The machine re-issues a drift-corrected seek on the next snapshot. Using `lastProgressMsRef` here would re-seek to the stale bad position, repeating the quick-finish loop.
