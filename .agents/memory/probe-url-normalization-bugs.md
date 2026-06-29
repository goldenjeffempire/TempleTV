---
name: Production probe URL normalization bugs
description: 5 probe system bugs fixed across scanner, self-healing worker, and REST routes — all related to raw vs. normalized URL keys in the bad-URL cache.
---

## The Rule
**Always call `normalizeQueueUrl()` before any bad-URL cache operation.** The bad-URL cache is keyed by the fully-normalized absolute URL (the same output `resolveSource()` operates on). Raw `localVideoUrl` values from the DB can be relative paths (`/api/v1/uploads/…`) or non-normalized strings — using them as cache keys causes silent no-ops.

**Why:** `normalizeQueueUrl()` converts relative paths to absolute URLs using the server's own origin (REPLIT_DEV_DOMAIN → API_ORIGIN → RENDER_EXTERNAL_URL → localhost). The orchestrator normalizes before every probe; the scanner normalizes before every scan. Any code that doesn't normalize will silently use the wrong cache key.

**How to apply:** Whenever a DB row's `localVideoUrl` or `hlsMasterUrl` is used with `clearBadUrl()`, `isKnownBadUrl()`, `markBadUrl()`, or `getUrlConfidenceState()`, wrap it with `normalizeQueueUrl()` first.

## Bugs fixed (all in broadcast-v2)

### Bug 1 — media-integrity-scanner.ts: missing import
`getUrlBadSourceSetsSize()` was called at the bottom of the file (for `registerNamedStore`) but not in the import list from `queue.repo.ts`. TypeScript compile error. Fix: add to import.

### Bug 2 — queue-self-healing-worker.ts: `resolveItemUrl()` returned raw URL
`resolveItemUrl()` returned `item.localVideoUrl` as-is (potentially a relative path). All downstream calls — `getUrlConfidenceState(url)`, `isKnownBadUrl(url)`, `clearBadUrl(url)`, `probeSource(url)` — used the wrong key. Detection always returned "healthy" for BYTEA uploads; `probeSource()` would throw on relative URLs (Node.js `fetch()` requires absolute URLs). Fix: return `normalizeQueueUrl(item.localVideoUrl)`.

### Bug 3 — queue-self-healing-worker.ts: `probeSource()` missing loopback + GET fallback
`probeSource()` sent HEAD to whatever URL it received — external REPLIT_DEV_DOMAIN URL for BYTEA uploads → traversed Replit's proxy → timed out → false unreachable. Also missing GET fallback for 405 Method Not Allowed and missing 416 acceptance. Fix: added `toLocalhostProbeUrl()` (mirrors scanner), GET fallback on 405, 416 acceptance, x-internal-token header.

### Bug 4 — rest.routes.ts POST /queue/:id/clear-bad-url
`clearBadUrl(queueItem.localVideoUrl)` used raw localVideoUrl as the cache key. No-op for items with relative paths (cache has normalized key). Fix: wrap with `normalizeQueueUrl()`.

### Bug 5 — rest.routes.ts POST /asset-health/:itemId/approve
`clearBadUrl(updated.sourceHash ?? itemId)` used `sourceHash` (an ETag/Last-Modified string from a probe response) as a URL key — always a no-op since ETags never appear in the URL cache. Fallback `itemId` is a UUID — also never a URL. Fix: query the queue item's `localVideoUrl`, normalize it, call `clearBadUrl()` on the result.
