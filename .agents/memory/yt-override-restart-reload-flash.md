---
name: YouTube override restart reload-flash bug
description: Client-visible buffering flash when the broadcast engine restarts mid-override, even though server-side resume position was correct.
---

## Symptom
Confirmed by live-testing: restarting the process that owns the broadcast
orchestrator (the Broadcast Daemon in dev, or the API process itself in
production where `RUN_MODE=all` runs the engine in-process with no separate
daemon) while a YouTube override is active causes
`youtube-shuffle-fallback.ts`'s `tryResumeFromHydratedState()` to correctly
resume the *same* video at the right elapsed position — but it does so by
minting a **brand new `override.id`** (`resumeSeconds` computed from the old
`startedAtMs`). This is by design at the engine level: the position math is
correct and playback never actually needed to reset.

## The gap
On the client (`artifacts/tv/src/components/LiveBroadcastV2.tsx`), the
dual-slot YouTube iframe swap logic keyed its "is this a new video?" decision
purely off `override.id !== lastOverrideId`. Since the restart always mints a
new id even for the *same* video, a viewer who stayed connected through the
brief server restart (WS/SSE reconnect, no page reload) would see the iframe
torn down and reloaded into a fresh slot — a visible buffering/black flash —
even though nothing about the actual content needed to change.

## Fix
Added a same-video guard: before treating an `override.id` change as "new
video starting", check whether the currently *active* slot's video id already
equals the incoming one. If so, just update `lastOverrideId` in the ref and
return — no slot swap, no iframe reload, no visual change. Only genuinely
different videos still go through the gapless/non-gapless dual-slot swap.

**Why:** any server-side "resume with a new id but same content" event (this
one specifically, and potentially future ones) must be absorbed silently by
clients that stayed connected — reload/flash logic should always be gated on
*content identity* (video id / url), never on an opaque id that can be
reissued for unchanged content.

**How to apply:** if you add another override-recreation path in the engine
(e.g. a different fallback or recovery mechanism that reuses `startOverride`
with a fresh id), check whether the client-side comparison logic in
`LiveBroadcastV2.tsx` (and any sibling player component, e.g. mobile/admin
preview, if they grow the same dual-slot pattern) needs the same same-content
guard.
