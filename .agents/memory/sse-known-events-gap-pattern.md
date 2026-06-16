---
name: SSE KNOWN_EVENTS gap — broadcast-source-upgraded + corrupt-media page
description: Two SSE event gaps fixed: broadcast-source-upgraded missing from KNOWN_EVENTS (silently dropped); corrupt-media page had no useSSEEvent handlers.
---

## Rule
Any `adminEventBus.push("X", ...)` call in server code requires three matching client-side registrations:
1. `KNOWN_EVENTS` in `artifacts/admin/src/contexts/sse-context.tsx`
2. A `summarize()` case in the same file (or `return null` for silent events)
3. A `useSSEEvent("X", ...)` handler in the relevant admin page

## What was missing
- `broadcast-source-upgraded` (pushed by `faststart.service.ts` and `transcoder.dispatcher.ts` on quality upgrades to mp4_faststart/hls) was absent from KNOWN_EVENTS → SSE router silently dropped every quality-upgrade notification.
- `corrupt-media.tsx` page had NO `useSSEEvent` handlers → newly quarantined videos didn't appear until 60 s poll.

## How to apply
Run this audit command before closing any SSE-related PR:
```bash
# Events pushed by server but absent from KNOWN_EVENTS:
comm -23 \
  <(grep -rn "adminEventBus.push" artifacts/api-server/src/ | awk -F'"' '{print $2}' | sort -u) \
  <(grep -o '"[^"]*"' artifacts/admin/src/contexts/sse-context.tsx | tr -d '"' | sort -u)
```
Empty output = no gaps. Non-empty = bugs to fix.

**Why:** The SSE router in sse-context.tsx only registers listeners for events in KNOWN_EVENTS. Events not in the list are silently ignored — no warning, no error. This makes the gap invisible in production.
