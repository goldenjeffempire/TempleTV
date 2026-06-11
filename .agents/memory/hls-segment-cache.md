---
name: HLS segment in-process LRU cache
description: Byte-size-aware LRU cache for immutable HLS .ts segments in video-serve.routes.ts; bypasses DB for repeated segment fetches.
---

## Rule
`HlsSegmentLru` class in `video-serve.routes.ts` caches immutable `.ts` segments in the API process memory. Cache check happens before the DB range/getObject path; cache population happens in the A2 (binary segment) path by buffering `obj.body` with `for await`.

**Why:** Each uncached segment fetch costs 2 DB queries (headObject + BYTEA getObject) = ~30–60 ms + 1 pool connection. With 10 concurrent viewers each pulling a segment every 2s, that's 10+ DB queries/sec just for HLS. A 64 MB in-process LRU eliminates ~80% of those DB hits once warm.

**How to apply:**
- Controlled by `HLS_SEGMENT_CACHE_MB` env var (default 64, 0 = disabled, max 512).
- Lazy-initialised on first HLS request via `hlsSegments()` factory function.
- Registered with `registerNamedStore("hls-segment-cache", ...)` for diagnostics.
- Only caches full (non-range) non-manifest requests; range requests bypass it.
- Per-entry cap at `maxBytes/4` prevents one large segment displacing all others.
- TTL 1 hour — generous but safe since segments are content-addressed and immutable.
- X-Cache: HIT / MISS header for observability.
- A2 path changed from streaming `reply.send(obj.body)` to buffered `for await ... Buffer.concat ... reply.send(segBuf)`. This is safe because segments are small (250 KB–4 MB).
