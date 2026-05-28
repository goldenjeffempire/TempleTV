---
name: Enterprise hardening sprint 2
description: Key lessons and decisions from the second deep-audit hardening pass across all platform surfaces
---

## All-blocked library scan escalation (broadcast-orchestrator.ts)

**Rule:** The stale-queue timer (30s, fires when items.length > 0) now also triggers `scanLibraryAndEnqueue` when `allBlockedSinceMs !== null && elapsed >= EMPTY_POLLS_BEFORE_LIBRARY_SCAN * SELF_HEAL_EMPTY_MS (60s)`. This makes the self-healing guarantee symmetric: the empty-queue backstop fires when items.length === 0, the all-blocked backstop fires when items.length > 0 but all sources are blacklisted. Before this fix, a queue full of broken URLs caused permanent dead air with no automated recovery.

**Why:** The audit identified that `scanLibraryAndEnqueue` was only triggered by `items.length === 0`. A queue with items that all had bad URLs (e.g. CDN outage) would sit in `allBlocked` state forever, never auto-healing by adding fresh content.

**How to apply:** The logic lives entirely in `selfHealStaleTimer`. No API surface change needed.

## Stream Health page upgrade pattern

The admin stream-health page was upgraded to query `/api/broadcast-v2/health` (already available) in addition to `/readyz`. Key new cards:
- **Broadcast Engine v2**: sequence, mode, currentTitle, elapsed/duration progress, nextTitle, allBlocked status, boot/reload stats
- **Playback Analytics**: activeSessions, peakSessionsLast5Min, stall/skip/recovery counts from the in-memory ring buffer (via /broadcast-v2/diagnostics)
- **Engine Boot & Reliability**: uptime, reload success rate, start attempts, bus bridge status

The diagnostics endpoint is auth-guarded but the health endpoint is public (rate-limited 30/min). Both can be safely polled from the admin panel.

## Launch Checklist pattern (broadcast-v2.tsx)

A Dialog-based pre-flight modal was added to the Master Control page. Key lessons:
- Checklist items are computed from already-fetched state (no new API calls needed at open time)
- `checklistItems` array is computed right before the `return` statement in the main component (not inside a sub-component) to access all the derived state
- `CircleCheck`, `CircleX`, `CircleAlert` from lucide-react for pass/warn/fail icons
- Action buttons in DialogFooter: "Clear Blocks" and "Prepare HLS" route directly to the existing `clearBlocks()` and `prepareHls()` functions, closing the dialog on invocation
- Dialog import: `@/components/ui/dialog` — was NOT already imported in broadcast-v2.tsx

## TV Home connectivity banner

Added an offline/connectivity banner to `artifacts/tv/src/pages/Home.tsx`:
- `isOnline` state initialized from `navigator.onLine` in a lazy initializer (SSR-safe: `typeof navigator !== "undefined"`)
- `window.addEventListener("online"/"offline")` with cleanup in a single `useEffect`
- Banner positioned absolute, zIndex 95 (below emergency overlay at 100, above header at 20)
- Reuses the `tv-emergency-slide-in` and `tv-emergency-pulse` CSS keyframes already in the TV app

## TV Home empty catalog state

Added a fourth branch to the loading/error/content ternary chain (after the error state):
- Condition: `!loading && !error && sermons.length === 0 && continueWatching.length === 0 && favorites.length === 0`
- Shows a TV/monitor icon + "No content available" message
- Falls through to the normal content grid otherwise
