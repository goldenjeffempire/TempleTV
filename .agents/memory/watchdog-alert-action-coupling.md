---
name: Memory watchdog alert–action coupling rule
description: Every new alert type added to memory-watchdog.ts must be wired into ALL action gates, not just the logging path.
---

## Rule

When adding a new alert flag to `memory-watchdog.ts` (e.g. `arrayBuffersAlertActive`), it must be added to **every** action gate that acts on pressure, not just the alert-logging `if` block:

1. **GC trigger** (`if ((rssAlertActive || heapUsedAlertActive || arrayBuffersAlertActive) && gcFn)`) — the GC runs on any pressure type.
2. **Cache purge trigger** (`if (rssAlertActive || heapUsedAlertActive || arrayBuffersAlertActive)`) — purge expired entries on any pressure.
3. **Sentry capture** — every alert type should send a Sentry event for off-process visibility; omitting it creates a blind spot.
4. **Periodic re-action** — if the first-alert action (e.g. cache trim) fires only once (`!alertActive` guard), add a periodic re-fire branch for the sustained-pressure case (`consecutiveOver % N === 0` while `alertActive`).

**Why:** The `arrayBuffersAlertActive` alert was added after the initial GC/purge wiring. It fired correctly, trimmed the HLS cache once, and logged — but the GC was never called and no re-trim fired if pressure persisted. A sustained leak accumulated unimpeded between the 30-minute watchdog relief cycles.

**How to apply:** After writing any new `*AlertActive` flag and its `if (... && !alertActive)` activation block, immediately search for `rssAlertActive || heapUsedAlertActive` in the file and add the new flag to each occurrence.
