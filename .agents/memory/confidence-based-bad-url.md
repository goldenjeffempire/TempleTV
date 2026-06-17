---
name: Three-source confidence-based bad-URL system
description: Prevents premature playback blocking by requiring two independent systems to confirm a URL is broken before it enters the bad-URL cache.
---

## The rule
Never block a URL from broadcast rotation on the first probe failure from a single source. Two or more independent sources must agree before any URL enters the bad-URL cache.

**Why:** CDNs and object-storage origins return transient 4xx on auth races, edge-cache misses, and health-check artefacts that self-resolve within seconds. The orchestrator's proactive probe fires once per item and was marking URLs bad on the first `reachable === false`, dropping healthy content for 20 s – 10 min.

**How to apply:** All markBadUrl call sites for URL-reachability failures must go through `markUrlBadBySource(url, sourceName)` in `queue.repo.ts`. Direct `markBadUrl()` is still correct for TTL-refresh re-marks (scanner re-marks after threshold) and for operator-triggered paths.

## Confidence states (gap count = distinct source names in the Set)
- **gap1** (1 source): warning only; URL stays in rotation; returns "gap1" to caller.
- **gap2** (2 sources): writes to bad-URL cache with exponential-backoff TTL; URL leaves rotation.
- **gap3** (3+ sources): same as gap2 but a quarantine candidate; logged at error level.

## Source names in use
- `"orchestrator-probe"` — `scheduleProactiveProbe()` single-shot next-item check
- `"orchestrator-current"` — `probeCurrentItem()` 3-consecutive-4xx gate (already has own gating)
- `"scanner"` — `MediaIntegrityScanner` 2-minute periodic scan (threshold: 3 consecutive failures)
- `"storage-recon"` — `StorageReconciliationWorker` DB + blob-store gap confirmed

## Key implementation details
- `urlBadSourceSets: Map<string, Set<string>>` lives in `queue.repo.ts` alongside the existing bad-URL cache.
- `clearBadUrl(url)` now also deletes from `urlBadSourceSets` — one-stop total reset.
- `clearAllBadUrls()` also clears `urlBadSourceSets`.
- Recovery: scanner's `ok && prev.count > 0` condition now also checks `getUrlConfidenceState(url) !== "healthy"` so gap1 flags (not yet in bad-URL cache) are cleared when the source recovers.
- `probeCurrentItem()` recovery path (`reachable === true`) also calls `clearBadUrl(url)` to wipe the confidence set.
- Memory diagnostics: `"url-bad-source-sets"` named store registered in `media-integrity-scanner.ts`; `confidenceSourceSets` field added to `GET /api/broadcast-v2/diagnostics` response.

## Files changed
- `queue.repo.ts` — added `urlBadSourceSets`, `markUrlBadBySource`, `getUrlConfidenceState`, `getUrlBadSourceSetsSize`; updated `clearBadUrl` + `clearAllBadUrls`
- `broadcast-orchestrator.ts` — `scheduleProactiveProbe` non-YouTube path uses confidence gate; `probeCurrentItem` recovery clears confidence
- `media-integrity-scanner.ts` — scan uses `markUrlBadBySource` at threshold; recovery also clears gap1 state
- `storage-reconciliation-worker.ts` — HLS + MP4 gap loops call `markUrlBadBySource(url, "storage-recon")`
- `rest.routes.ts` — diagnostics endpoint exposes `confidenceSourceSets` count
