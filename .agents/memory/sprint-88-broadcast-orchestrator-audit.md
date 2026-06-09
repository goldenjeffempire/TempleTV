---
name: Broadcast orchestrator audit sprint 88
description: 3 fixes across broadcast-orchestrator.ts and broadcast-v2.tsx — skip() double-skip, fallback stuck-state, adminPost invalidation gap.
---

## Fixes

### Bug 1 — `reloadInner()` missing fallback flag resets (covered by sprint 88 continuation)
Already documented in sprint 87; confirmed complete.

### Bug 2 — `skip()` double-skip after `markBadUrl()`
**Root cause:** `skip()` called `snapshot().current.endsAtMs - Date.now()` for `remainingMs`. After `markBadUrl()` marks item A's URL bad, `snapshot()` forward-scans past A and returns item B as current. So `remainingMs = A_remaining + B_duration`, and `cycleStartedAtMs -= that` — silently advancing past two items instead of one.

**Fix:** Rewrote `skip()` to use elapsed-based slot finding (identical logic to `tickInner`'s auto-skip):
- Compute `elapsed = (now - cycleStartedAtMs) % cycleDurationMs`
- Walk item slots until `elapsed < acc + span`
- Advance by exactly `(acc + span) - elapsed` (the current slot's remaining time)
- No dependency on `snapshot()` — works correctly regardless of URL blocking

**Why:** The elapsed-based approach finds the physical slot that contains the current clock position regardless of whether any URL in that slot is blocked. The snapshot forward-scan is correct for *display* but wrong for *time advance* when the displayed item is not the same as the slot being vacated.

**Affects:** Both the REST `/skip` operator command (lines 481, 893) and the `probeCurrentItem()` → `markBadUrl()` → `skip()` path. Behavior is identical to old `skip()` for the non-blocked case.

### Bug 3 — `adminPost()` helper insufficient invalidation on skip/reload/failover
**Root cause:** `adminPost()` used for 8 operator commands (skip ×1, reload ×5, force-failover ×1, clear-failover ×1) only invalidated `broadcast-v2-engine-health` + `broadcast-queue`. Missing: `broadcast-v2-diagnostics`, `broadcast-v2-source-health`, `broadcast-v2-remediation-report`.

**Fix:** Added the 3 missing keys to `adminPost()` on-success block.

**Why:** After a manual skip or failover the diagnostics panel and source-health badges showed stale state for up to 15 s (until the next SSE poll). Operators see "source blocked" badges not clearing after a confirmed skip.

## Areas confirmed clean (false positives)
- `probeUrlReachability()` — HLS body validation + HEAD→GET fallback chain solid
- `scheduleProactiveProbe()` — correctly marks bad + emits snapshot, does NOT call skip() (tick handles advance)
- `persistCheckpoint()` — `checkpointWriting` always reset in `finally`; dirty flag pattern correct
- `emitSnapshot()` — calls `this.snapshot()` internally, so always reflects current blocked-URL state
- `skip()`-after-reload (skip-to-front REST path, line 893) — new elapsed logic produces identical result to old snapshot logic when no URL is blocked
