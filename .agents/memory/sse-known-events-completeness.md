---
name: SSE KNOWN_EVENTS completeness
description: The SSEProvider in sse-context.tsx only forwards events listed in KNOWN_EVENTS. Any useSSEEvent() handler for an unlisted event silently never fires.
---

## Rule
Every event name passed to `useSSEEvent(eventName, ...)` in any admin page/component MUST appear in the `KNOWN_EVENTS` array in `artifacts/admin/src/contexts/sse-context.tsx`.

## Why
The SSEProvider uses `KNOWN_EVENTS.forEach(evt => es.addEventListener(evt, ...))` — it only registers listeners for events in that array. If a page calls `useSSEEvent("broadcast-v2-stall", handler)` but `"broadcast-v2-stall"` is not in KNOWN_EVENTS, the EventSource never delivers it and the handler silently never fires, even though the server correctly pushes it.

## Known gap (fixed)
Four events were missing: `broadcast-v2-stall`, `broadcast-v2-queue-issues`, `feedback-received`, `youtube-quota-warning`. All four have now been added to KNOWN_EVENTS along with activity-feed `summarize()` entries.

## How to apply
When adding a new `useSSEEvent("new-event-name", ...)` call anywhere in the admin app:
1. Add `"new-event-name"` to KNOWN_EVENTS in `sse-context.tsx`.
2. Add a `case "new-event-name": return "..."` entry to the `summarize()` function so it appears in the activity feed.
3. Confirm the server pushes the same event name via `adminEventBus.push("new-event-name", ...)`.
