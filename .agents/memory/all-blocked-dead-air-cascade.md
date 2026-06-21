---
name: All-blocked dead-air + restart cascade
description: Boot revalidation + allBlockedSinceMs TTL race creates infinite dead-air restart loop on memory-constrained hosts.
---

## The bug

Two independent defects combine into an infinite loop on hosts where the memory-watchdog restart window is ≤ 90 s:

### Defect 1 — boot revalidation false early-return

`broadcast-orchestrator.ts` `start()` schedules a 10 s delayed check to clear stale bad-URL cache after a restart. The original guard was:

```ts
if (this.items.length > 0) return; // already playing — nothing to do
```

`this.items` is populated by `resolveSource()` (SSRF allowlist pass), NOT by the bad-URL cache. Items that passed the allowlist but are ALL in the bad-URL cache still appear in `this.items`, so the early-return fires even though the channel is OFF_AIR.

**Fix:** gate on actual playability:
```ts
const anyPlayable = this.items.some(
  (item) => !!item.primaryUrl && !isKnownBadUrl(item.primaryUrl),
);
if (anyPlayable) return;
```

### Defect 2 — allBlockedSinceMs TTL longer than watchdog restart window

`allBlockedSinceMs` is the in-tick all-sources-blocked recovery. It used to fire after `BAD_URL_TTL_MS` = 90 s. On production Render hosts with `MEMORY_RESTART_RSS_MB = 430–470`, the watchdog restarts the process after ~80 s of sustained high RSS. The 90 s recovery never fires; the restart re-hydrates the same bad-URL cache from the DB; dead air persists forever.

**Fix:** use a separate `ALL_BLOCKED_RECOVERY_MS = 45_000`. This reliably beats the 80 s watchdog window.

## Why it matters

The bad-URL cache is persisted to the DB (via `persistBadUrlCache`) and re-hydrated on every restart (via `hydrateBadUrlCache`). A single probe failure before a crash stores the blocked URL in the DB. Without both fixes, every subsequent restart inherits the blocked state and can never clear it autonomously.

## How to apply

- Any time you touch boot revalidation logic: verify the playability check uses `isKnownBadUrl(item.primaryUrl)`, not `items.length > 0`.
- Any all-blocked recovery threshold: must be measurably less than `MEMORY_RESTART_RSS_MB` sustained-samples window (samples × interval).  For 8 × 10 s = 80 s, use ≤ 60 s.
- `clearAllBadUrls()` resets `badUrlFailureCounts` too — items start with fresh 20 s TTL after a manual or auto clear, not the escalated 10 min TTL from repeated failures.
