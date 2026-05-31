---
name: Upload RSS memory hardening
description: 6 root-cause fixes for 523 MB RSS watchdog restart loops during concurrent chunk uploads.
---

## Root causes

Production logs showed `rssMb:523`, `consecutiveRssOverRestart:10` (5 min sustained) with 3 concurrent files uploading 8 MiB chunks at 13-15 s/chunk. The watchdog restart threshold was 430 MB.

1. **No chunk-write concurrency semaphore** — 3 files × 4 parallel chunks = up to 12 × 8 MiB body buffers simultaneously in Node.js heap during the slow DB write window (driven by O(n²) background-assembly I/O pressure). Combined with pg hex-encoding overhead and V8 heap fragmentation, peak RSS spiked ~100 MiB above the restart threshold.

2. **Body buffer held for full DB write duration** — `body` local var kept the 8 MiB Buffer alive across both the `uploadPart` INSERT and the subsequent `chunks` INSERT (13-15 s total). No opportunity for GC between the two awaits.

3. **`MEMORY_RESTART_RSS_MB` default too tight** — code comment said 600, actual default was 490. Production ran with 430 (env var). With `--max-old-space-size=460`, legitimate peak RSS can reach 500-550 MB under upload load, so 430 triggered false-positive restarts.

4. **`start:prod --max-old-space-size=256`** — npm script used 256 MB heap while the Replit workflow used 460 MB. Any Render/Docker deployment using `npm run start:prod` got a critically undersized heap.

5. **`DB_POOL_MAX` default 10** — background `completeMultipartUpload` advisory lock pins 1 of 10 connections; 3 concurrent uploads × 2+ sequential queries each = pool pressure, slowing chunk INSERTs and extending buffer lifetimes.

6. **`probeCache` in prod-sync never pruned** — `const probeCache = new Map()` grows unbounded; entries older than 2× PROBE_TTL_MS (10 min) are dead weight.

## Fixes applied

| File | Change |
|------|--------|
| `chunked-upload.routes.ts` | Module-level semaphore `MAX_CONCURRENT_CHUNK_DB_OPS=6` (env-overridable); wraps the `uploadPart` + `chunks INSERT` block in `acquireChunkDbSlot` / `releaseChunkDbSlot` |
| `chunked-upload.routes.ts` | Capture `sizeBytes = body.length` before hash; null out `body = Buffer.alloc(0)` + `req.body = null` immediately after `uploadPart` returns (before the smaller `chunks INSERT` await) |
| `env.ts` | `MEMORY_RESTART_RSS_MB` default 490 → **600** (matches comment; gives headroom above 460 MB heap) |
| `env.ts` | `DB_POOL_MAX` default 10 → **20** |
| `api-server/package.json` | `start:prod --max-old-space-size=256` → **460** |
| `prod-queue-sync.ts` | `setInterval` every 10 min prunes probeCache entries older than 2× PROBE_TTL_MS; `.unref()` so it doesn't block graceful shutdown |

## Key design rule

**Why MAX_CONCURRENT_CHUNK_DB_OPS=6:** Half the pool max (now 20 → 10 effective half). Leaves room for the advisory-lock connection from background assembly + general API queries. Env-overridable so operators can tune with `DB_POOL_MAX`.

**Why null out body after uploadPart (not before):** `uploadPart` needs the full Buffer as its payload. The `chunks INSERT` only needs `sizeBytes` (captured before) and the etag. Nulling between the two awaits gives V8 a GC opportunity during the second, slower await without any correctness risk.

**Why 600 MB restart default:** With `--max-old-space-size=460`, RSS can legitimately reach 500-550 MB under peak upload load (heap + Buffer external + native). 600 MB leaves a comfortable margin while still catching genuine leaks that grow past that.
