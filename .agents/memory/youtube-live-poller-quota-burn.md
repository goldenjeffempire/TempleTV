---
name: YouTube Live Poller quota burn
description: YtLivePoller was burning 100 quota units every 90s via search.list without checking isQuotaExhausted(), consuming the full 10,000-unit daily budget by late morning.
---

## Root cause

`youtube-live.poller.ts` calls `search.list` every 90 s (100 units per call) but never checked `isQuotaExhausted()` before making the call. Result:
- 40 calls/hour × 100 units = 4,000 units/hour
- By 07:26 UTC (7.44 h into the day): ~29,800 units burned, matching the observed `quotaUsed=28,735`

The sync service (`syncYouTubeChannel`) DID check `isQuotaExhausted()` and fell back to RSS correctly. The poller bypassed that check entirely.

## Secondary discovery

When YouTube returns a 403 (quota exceeded at Google's end), `parseApiResponse` returns `{ isLive: false, detectionMethod: "youtube-api-v3" }` (not `"api-error"`) because `data.items` is undefined → `items = []` → no live items. This means the 1-hour `apiCooldownUntilMs` mechanism ALSO failed to trigger on 403 quota-exceeded responses. The quota guard in `poll()` is the correct fix path.

## Fix

In `poll()`, added an `isQuotaExhausted()` branch between the cooldown check and the `pollApi()` call. When quota is locally exhausted:
1. Sets `apiCooldownUntilMs` to midnight UTC (full-day suppression, not just 1 hour)
2. Falls back to `pollRss()` (quota-free, 60s interval)

This prevents 96,000 units/day of unnecessary search calls while keeping live detection active via RSS.

**Why midnight UTC not 1 hour:** The daily YouTube quota resets at midnight Pacific (~07:00 UTC next day). A 1-hour cooldown would allow the poller to resume API calls (and fail immediately due to real quota exhaustion) every hour for the rest of the day. Midnight UTC is close enough to Pacific midnight to be safe without needing timezone-aware code.

## Quota math reference

| Source | Cost/call | Frequency | Units/day |
|---|---|---|---|
| `search.list` (live poller) | 100 | every 90s | 96,000 |
| `playlistItems.list` (sync) | 1 | ~9 per sync run | 864/day at 15min intervals |
| `videos.list` (sync) | 1 | ~9 per sync run | 864/day at 15min intervals |
| `channels.list` (sync) | 1 | 1 per sync run | 96/day at 15min intervals |
| **Total without fix** | — | — | **~97,824** |
| **Total with fix (quota guard active)** | — | — | ≤10,000 (by design) |
