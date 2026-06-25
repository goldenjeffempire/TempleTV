---
name: YouTube dual-slot transition timing
description: Optimal delay values for the A/B iframe swap in LiveBroadcastV2.tsx; history of what the old values were and why the new ones are correct.
---

# YouTube dual-slot transition timing

## Context

`artifacts/tv/src/components/LiveBroadcastV2.tsx` uses two YouTube iframes (slotA / slotB) managed by `ytStateRef` + `setYtRender`. Both iframes are always in the DOM; CSS `opacity` swaps which is visible. The inactive slot autoplay-mutes a pre-loaded video so transitions can be gapless.

## Tuned delay values (June 2026)

| Event | Old delay | New delay | Rationale |
|---|---|---|---|
| First activation unmute | 500 ms | **100 ms** | iframe accepts `postMessage` within a few ms of mount; 500 ms was audibly silent |
| Gapless swap unmute | 100 ms | **0 ms (immediate)** | inactive slot has been playing muted for the full prior video; no decode wait needed |
| Gapless post-swap next-preload | 400 ms | **100 ms** | just enough for CSS opacity transition to finish before the freed slot gets a new src; avoids double-decode stutter on slow TV SoCs |
| Non-gapless unmute | 600 ms | **300 ms** | gives new iframe a head-start on autoplay before audio opens; 600 ms was overlong |
| Non-gapless post-swap next-preload | 1200 ms | **300 ms** | 300 ms lets the new iframe begin its initial decode before we repurpose the freed slot |

## Transition types

- **Gapless**: `inactiveContent === ytId` — inactive slot already has the right video (preloaded during prior item). Pure CSS swap, no iframe reload.
- **Non-gapless**: inactive slot has a different (or null) video. Loads new `src` into the inactive slot simultaneously with the CSS opacity swap. Viewer may see a brief YouTube loading spinner.

## `nextYtVideoId` type safety

`V2Snapshot` in `lib/player-core/src/types.ts` already declares `nextYtVideoId?: string | null`. The cast `as { nextYtVideoId?: ... }` that previously appeared in `LiveBroadcastV2.tsx` line 625 is unnecessary and was removed. Use `snapshot.lastServerSnapshot?.nextYtVideoId ?? null` directly.

## `BROADCAST_PRELOAD_LEAD_MS` alignment

Server default in `env.ts` is `120_000`. The `.replit` `[userenv.shared]` section previously overrode this to `90000`; corrected to `120000` via `setEnvVars` (shared env). All three alignment points now agree: server=120s, `machine.ts` PRELOAD_LEAD_MS=120s, `web.ts` NEAR_END_LEAD_SECS=120s.

**Why:** Mismatched values can cause either premature preload (client tries to preload before server knows next video) or late preload (server sends preload frame after client already triggered near-end). 120s symmetric is safest for YouTube where preload just sets an iframe src.
