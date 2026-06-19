---
name: Viewer retention analytics endpoint
description: Per-video retention curve using viewer_sessions.watchedSecs as max-position proxy
---

## Endpoint
`GET /analytics/video/:videoId/retention?since=<ISO>` — requires `requireAuth("editor")`

## Algorithm
1. Query all `viewer_sessions` for `videoId` where `watchedSecs > 0` (limit 10k)
2. Compute p95 of `watchedSecs` as `effectiveDuration` — prevents seeked-to-end outliers inflating the x-axis
3. Build 10 equal-width buckets (10%, 20%, ..., 100% of effectiveDuration)
4. For each bucket at `atLeastSecs = effectiveDuration * fraction`: count sessions where `watchedSecs >= atLeastSecs * 0.95` (5% tolerance for early-end events)
5. Returns `{ videoId, totalSessions, buckets: [{ bucketPct, atLeastSecs, viewerPct }] }`

## Limitations
- `watchedSecs` = max position ever reached in session (GREATEST on heartbeats). Skipping forward inflates it, so this is "max reached position" not "contiguous watch time."
- No long-term archiving — results based on all historical sessions in viewer_sessions table.

## Admin UI
`artifacts/admin/src/pages/analytics.tsx` — Row 7 "Viewer Retention Curve"
- Auto-selects first top video on load via `useEffect`
- Select dropdown to switch between top videos
- LineChart with ReferenceLine at y=50%
- Shows session count as Badge

**Why:** watchedSecs is the only position data stored per session. A full per-minute retention curve would require a separate position_samples table (future work).
