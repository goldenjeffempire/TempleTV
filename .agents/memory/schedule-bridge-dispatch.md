---
name: Schedule-bridge content dispatch pattern
description: Critical dispatch rules for schedule-bridge contentType handling — wrong function choice silently misfires scheduled content.
---

## The Rule

- `contentType === "video"` → **must** call `enqueueIfMissing({ videoId: entry.contentId, reason: "schedule-bridge" })` — queues the **specific** scheduled video.
  - **Wrong**: `scanLibraryAndEnqueue(...)` — that picks a random eligible video from the full library, ignoring the scheduled video ID entirely.
  - Must also skip early if the video row doesn't exist (404 guard → log + return).
- `contentType === "live" | "external"` → call `broadcastOrchestrator.startOverride(...)` **AND** emit `broadcast-queue-updated`.
  - The live/external case was originally missing the `broadcast-queue-updated` emit → Master Control queue panel never refreshed after a live override started.
- `contentType === "playlist"` → `scanLibraryAndEnqueue({ reason: "schedule-bridge-playlist", maxToAdd: 500 })`.
- **All 3 types** must emit `broadcast-schedule-updated` (with `reason: "schedule-bridge-fired"`) so the admin Schedule page auto-refreshes when an entry fires.

## Reason union membership

- `enqueueIfMissing` reason union: must include `"schedule-bridge"`.
- `scanLibraryAndEnqueue` reason union: must include `"schedule-bridge-playlist"`.

**Why:** An operator schedules a specific sermon for Sunday morning. If `scanLibraryAndEnqueue` runs instead of `enqueueIfMissing`, a completely different video airs — silent mismatch that's very hard to diagnose.

**How to apply:** Any time schedule-bridge is modified, verify the correct enqueue function is called for each content type and all 3 SSE emits are present.
