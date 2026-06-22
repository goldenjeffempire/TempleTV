---
name: Circuit-breaker + source approval design
description: Tuned thresholds and in-memory approval gate for the broadcast pipeline probe system
---

## The rule

After refactoring, the circuit-breaker system has these thresholds:

**Bad-URL TTL schedule** (`badUrlTtlForCount` in `queue.repo.ts`):
- 1st failure: 60 s (was 20 s)
- 2nd: 3 min
- 3rd: 5 min
- 4th: 10 min
- 5+: 20 min (was 10 min)

**Suspension TTL** (`SUSPENSION_TTL_MS`): 10 min (was 5 min)

**`probeCurrentItem` thresholds** (`broadcast-orchestrator.ts`):
- Interval: 60 s (was 30 s)
- 4xx auto-skip threshold: 5 consecutive (was 3) → 5 min before giving up
- Ambiguous/5xx auto-skip threshold: 8 consecutive (was 5) → 8 min before giving up

**MediaIntegrityScanner** (`media-integrity-scanner.ts`):
- Bad-URL threshold: 5 consecutive scan failures (was 3)
- Interval: 5 min (was 2 min)
- NOTE: scanner is currently disabled (scan() early-return at line 605-608 "MP4-only pipeline")

**Source approval cache** (`queue.repo.ts` exports: `markSourceApproved`, `isSourceApproved`, `clearSourceApproval`, `clearAllSourceApprovals`):
- TTL: `SOURCE_APPROVAL_TTL_MS = 4 hours`
- Stamp set by: `scheduleProactiveProbe` on success, `probeCurrentItem` on success
- Gate checked by: `scheduleProactiveProbe` (skip if approved, except YouTube), `probeCurrentItem` (skip if approved)
- Cleared by: stall report (`/report-stall`), YouTube probe on 403/451, 4xx/ambiguous threshold breach
- Bulk-cleared by: all `clearAllBadUrls()` call sites (reload, stop-override, revalidate-sources, restart-engine)

**Why:**
- 20 s first-failure TTL was shorter than CDN cold-start round-trips, causing false positives
- 30 s probe at threshold 3 = 90 s to auto-skip a healthy item on transient CDN blip
- Re-probing every 30–60 s for hours-long healthy streams adds unnecessary probe load
- Approval cache eliminates all redundant probes while stall reports still immediately invalidate

**How to apply:**
- If adding new "clear all blocks" operator actions, always call both `clearAllBadUrls()` AND `clearAllSourceApprovals()`
- If a new path reports URL failure, call `clearSourceApproval(itemId)` before marking bad
- If thresholds need tuning, the 4-hour approval TTL is the knob most worth adjusting for probe reduction
