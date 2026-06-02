---
name: Comprehensive platform audit — sprint 31
description: 7 production bugs fixed across YouTube live detection, analytics atomicity, background worker reliability, and monitoring.
---

## Bugs Fixed

### 1. YouTube live poller silent 403 — no RSS fallback
`youtube-live.poller.ts` `poll()`: when `YOUTUBE_API_KEY` is set but returns 403/quota/network error, `pollApi()` returns `detectionMethod: "api-error"` and the old code stopped there, reporting "Off Air" even while the channel was live. Fix: after `pollApi()`, if `result.detectionMethod === "api-error"`, immediately call `pollRss()` as fallback.

**Why:** API errors are opaque (quota/403/network all look identical) so RSS is always a safe fallback — it's quota-free and parses `yt:liveBroadcastContent`.

### 2. YouTube live routes missing rate limiting
`youtube-live.routes.ts` GET `/` and GET `/status` had no rate limiting while POST routes did. TV polls `/status` every 30s; without rate limiting a polling storm could flood the API. Added `max: 120, timeWindow: "1 minute"` to both.

### 3. Analytics session insert non-atomic
`analytics.routes.ts` event=`started`: `Promise.all([db.insert(sessions), db.update(videos)])` — two independent statements. If `viewCount` increment failed, session was inserted without a matching view count. Wrapped in `db.transaction()`.

### 4. Faststart inFlight Set has no TTL
`faststart-recovery.ts`: added `inFlightSince = new Map<string, number>()` alongside `inFlight`. Each `inFlight.add()` now sets `inFlightSince.set(id, Date.now())`. In `dispatchOne()` before the membership check, entries older than 30 minutes (INFLIGHT_TTL_MS) are evicted with a WARN log. `inFlightSince.delete()` added to the `finally` block.

### 5. Scheduled notifications stuck-sending only reset at boot
`dispatcher.ts`: `resetStuckSending()` only ran once at startup. Long-lived processes accumulated stuck `sending` rows if an unhandled rejection bypassed the finally block. Added `stuckInterval` that fires `resetStuckSending()` every 10 minutes. Cleared in `stop()`.

### 6. Slow-request counter overflow
`slow-request-capture.ts`: `routeAggregates` entries were never reset — on 24/7 servers `total` and `totalDurationMs` grew indefinitely, skewing averages. GC loop now caps at `AGGREGATE_SAMPLE_CAP = 10_000` samples: when exceeded, resets to a single representative entry preserving the current rolling average.

### 7. YouTube channel routes missing quota tracking
`youtube-channel.routes.ts` `fetchAllVideosViaApi()` made `channels.list`, `playlistItems.list`, and `videos.list` API calls without any `trackQuota()` invocations — these costs were invisible to the quota monitoring dashboard. Exported `trackQuota` from `youtube-sync.service.ts` and added calls in all three fetch functions.
