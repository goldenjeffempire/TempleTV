---
name: Render free-tier startup OOM crash pattern and fixes
description: Root causes and fixes for the May 2026 production crash loop where the API OOMed at startup on Render's 512 MB free tier.
---

## The rule
Always hardcode `--max-old-space-size` directly in the `start:prod` npm script — never rely solely on `NODE_OPTIONS` env var for memory containment.

**Why:** Render caches instance env vars from the time of the last full redeploy. If `NODE_OPTIONS` is added to `render.yaml` after the service was first deployed, the running instance won't pick it up until the next full redeploy that triggers env var re-sync. During the interval the cap is absent, Node grows the heap unconstrained during the startup burst and OOMs. The crash signature is: Mark-Compact failing at ~250 MB committed with ~179 MB live — V8 is lazily deferring GC because it thinks there's no limit.

**How to apply:** `start:prod` in `artifacts/api-server/package.json` must contain `--max-old-space-size=N --max-http-header-size=16384` directly on the node command. `NODE_OPTIONS` in `render.yaml` is belt-and-suspenders only. Command-line flags take precedence over `NODE_OPTIONS`, so both can coexist.

## Second root cause: TRANSCODER_DISABLE was silently ignored
`main.ts` had a comment saying TRANSCODER_DISABLE is "intentionally ignored here" — so even with the env var set to `true` in render.yaml, the transcoder dispatcher always started (FFmpeg check + orphaned-job DB scan = extra memory and I/O pressure during startup burst). Fixed by adding a proper env check in `startWorkers()`.

If the transcoder appears to start in production despite `TRANSCODER_DISABLE=true` in render.yaml, the most likely cause is a Render dashboard manual override on the service's env vars page — dashboard values override yaml values and cannot be seen from the codebase.

## Observability fix
`v8.getHeapStatistics().heap_size_limit` is now logged at process start alongside `NODE_OPTIONS`. In production this confirms the cap is active. Expected value on Render free tier: `heapSizeLimitMb ≈ 350–400` when `--max-old-space-size=256` is in effect (V8 adds overhead for non-old-space heaps; `heap_size_limit` is total, not just old-space).

## Values (current — updated May 2026)
- `--max-old-space-size=256` — bumped from 220 when startup burst (~179 MB live + code/large-object overhead) committed ~250 MB to V8 heap, exceeding the 220 MB cap and making GC ineffective. Budget: 256 MB old-space + ~32 MB new-space + ~15 MB code-space = ~303 MB V8 ceiling + ~100 MB external (pg pool, pino, zlib) + ~30 MB stacks/OS = ~433 MB RSS, leaving ~79 MB margin on 512 MB free tier.
- `MALLOC_ARENA_MAX=2` — still set as env var in render.yaml; reduces glibc malloc arena fragmentation 30–50%
- `MEMORY_WARN_RSS_MB=380`, `MEMORY_RESTART_RSS_MB=430` — watchdog thresholds unchanged (still valid with 256 MB heap)
