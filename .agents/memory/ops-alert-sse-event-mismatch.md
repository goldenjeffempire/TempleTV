---
name: ops-alert SSE event name mismatch
description: Server emits ops-alert but admin client registered ops-alert-sent — silent alert delivery failure pattern.
---

## Rule
The admin event bus emits `ops-alert` (via `adminEventBus.push("ops-alert", ...)`). The admin SSE context's `KNOWN_EVENTS` array and every `useSSEEvent()` call-site must use exactly `"ops-alert"` — never `"ops-alert-sent"`.

**Why:** The SSE passthrough endpoint sends `e.type` verbatim. If the event name in `KNOWN_EVENTS` doesn't match the server-emitted name, `useSSEEvent()` silently never fires. The `summarize()` function in `sse-context.tsx` also needs a matching `case "ops-alert":` branch or SSE reconnect summaries will swallow the event.

**How to apply:** Any time a new `adminEventBus.push("some-event", ...)` is added to the API, grep `KNOWN_EVENTS` in `artifacts/admin/src/contexts/sse-context.tsx` and add the exact string — and add a `case` in `summarize()`. Same string must appear in every `useSSEEvent("some-event", ...)` call-site.
