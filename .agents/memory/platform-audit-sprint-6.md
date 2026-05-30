---
name: Comprehensive platform audit sprint 6
description: 14 bugs found and fixed across TV app, Admin panel, API server, and DB in full end-to-end audit.
---

## Durable lessons

**React Query mutation invalidation discipline**
Every mutation that affects multiple UI surfaces must invalidate ALL affected query keys, not just the primary one. Common missed cases:
- Deactivating a broadcast queue item → must invalidate `broadcast-v2-engine-health` (not just `broadcast-queue`)
- `adminPost` for reload/skip/restart → must invalidate `broadcast-v2-engine-health` + `broadcast-queue`
- Upload completion → must invalidate `admin-stats` (Dashboard total count)
- Schedule create/update/delete → must invalidate `broadcast-queue` (queue panel shows schedule labels)
- `banChatMutation` → must invalidate `users` query (ban status must reflect immediately)

**Why:** React Query only refetches when the query key is explicitly invalidated or the stale time expires (10–30 s). Missing invalidations cause the UI to show stale state for up to one poll cycle, creating the appearance of silent failures to operators.

---

**Smart TV HLS GPU cleanup**
After `hls.destroy()`, always follow with `video.removeAttribute('src'); video.load()`. Without this, older Tizen/WebOS runtimes keep the last decoded frame resident in GPU texture memory and the audio hardware "claimed".

**Why:** `hls.destroy()` tears down hls.js's internal state but does NOT reset the underlying HTMLVideoElement. Samsung/LG Smart TVs with WebKit-based browsers do not auto-release GPU resources when the JS side destroys the HLS instance.

---

**Auth refresh loop floor**
`Math.max(0, expiryMs - Date.now() - leadTime)` produces `0` when the token is already expired, creating an immediate → refresh → schedule → immediate tight loop. Use `Math.max(5_000, ...)` as the floor.

**Why:** If a TV is left on overnight and the stored token expires, on next wake the proactive refresh fires at delay=0, which immediately succeeds, calls scheduleProactiveRefresh again, and if the server returns a slightly stale expiry (e.g. clock skew), the loop can spin. 5 s floor breaks the cycle without meaningfully delaying actual refresh.

---

**Abandoned upload session sweep**
The periodic DB cleanup only swept `completed/failed/cancelled` upload_sessions. Sessions stuck in `uploading` (client disconnected mid-upload, never resumed) were never cleaned up and could accumulate indefinitely.

**Fix:** Added a separate sweep: `DELETE FROM upload_sessions WHERE status = 'uploading' AND created_at < NOW() - INTERVAL '48 hours'`.

**How to apply:** Any time you add a new "in-progress" state to a lifecycle table, explicitly add a sweep for it in the periodic cleanup function in `infrastructure/db.ts`.

---

**sendPush return value — sentCount**
`notificationsService.sendPush()` returns `{ sentCount, delivered }`. The scheduled-notifications dispatcher was hardcoding `sentCount: 1` instead of using the actual return value, causing inaccurate delivery counts in the audit log.

**Fix:** `const pushResult = await notificationsService.sendPush(...); sentCount: pushResult.sentCount ?? pushResult.delivered ?? 1`

---

**Self-demotion guard pattern**
Admin role-change endpoints don't guard against self-demotion server-side. Add a client-side check in the mutation: if `id === user?.id && role !== 'admin' && role !== 'system'`, reject with a descriptive error before calling the API. The `onError` handler surfaces it as a toast.

---

**"Send to all" confirmation**
Any action that broadcasts to a large audience (push notifications) must show a confirmation dialog with the exact reach count before executing. Pattern: gate `sendMutation.mutate()` behind `AlertDialog` with the subscriber count in the description.

---

## False positives in this audit

- **Mobile notification tap deep-link**: The listener IS present at `artifacts/mobile/app/_layout.tsx` lines 291-303 — the audit subagent missed it. Verified in code.
- **HLS stall timer (HlsVideoPlayer)**: `stallTimerRef` is already wired at lines 553-561/595, and the inner timer at line 299 has a try/catch that handles destruction safely.
- **bulkDeleteMutation broadcast-queue**: Already invalidates `broadcast-queue` at line 406 — audit was a false positive.
