---
name: Comprehensive platform audit — sprint 15
description: 20 bugs fixed across API, TV, Admin, Mobile, and DB schema in sprint 15 audit cycle.
---

## Fixes applied

### API
- **auth.service.ts resetPassword**: `Promise.all` replaced with `db.transaction()`. Without the transaction, a partial failure leaves the reset token reusable (token marked used, password unchanged) or the password updated but the token still valid — both are security bugs.

### TV
- **LiveBroadcastV2.tsx useMidnightPrayersSwitch**: Added `AbortController` to the config fetch — without it, `setCfg()` can fire on an unmounted component causing a React state-update-after-unmount warning and potential memory leak.

### Admin
- **BroadcastPreviewV2.tsx ABR stall recovery timer**: Added `stallRecoveryTimer` variable (tracked across the closure), cleared in the HLS cleanup function. The untracked 30 s `setTimeout` would call `hls.currentLevel = -1` on a destroyed instance after navigation. Wrapped the callback body in `try/catch`.
- **videos.tsx filter select handlers**: Added `setSelectedIds(new Set())` to all 4 filter dropdowns (source, category, status, sort). They already called `setPage(1)` but did not clear selected video IDs, leaving ghost selections from a prior filter state visible in the bulk-action bar.

### Mobile — 11× KeyboardAvoidingView `behavior` fix
All 11 occurrences of `behavior={Platform.OS === "ios" ? "padding" : undefined}` changed to `"height"` on Android. `undefined` means no keyboard avoidance at all — inputs under the keyboard were hidden with no scroll compensation. Files:
- `app/login.tsx`, `app/signup.tsx`, `app/forgot-password.tsx`, `app/reset-password.tsx`
- `app/link.tsx`, `app/change-password.tsx`, `app/account.tsx`
- `components/ChatPanel.tsx`, `components/BroadcastLiveSheet.tsx`

### Mobile — data safety
- **useWatchProgress.ts**: `JSON.parse(raw)` at line 42 was not wrapped in try-catch. Corrupted AsyncStorage (common after app crashes or forced updates) would throw an unhandled exception that silently killed the progress-map initialization. Added try/catch that falls through to an empty map.

### DB — 3 new indexes (pushed to production schema)
| Index | Table | Columns | Reason |
|-------|-------|---------|--------|
| `idx_viewer_sessions_video_id` | `viewer_sessions` | `video_id` | Analytics panels "viewers by video" did full table scans — table grows 1 row/viewer/session and is never trimmed |
| `idx_scheduled_notifications_video_id` | `scheduled_notifications` | `video_id` | "notify when ready" flow looks up pending notifications by videoId |
| `user_watch_history_user_video_idx` | `user_watch_history` | `(user_id, video_id)` | "Has this user watched this video?" query (video detail page) required bitmap AND between two single-column indexes without this composite |

## False positives from audit
- `useLiveStatus` timer in `useData.ts` — already correct; `cancelled` flag prevents both state update and new timer scheduling after unmount; timer ref cleared synchronously in cleanup.
- `pollFinalizeStatus` abort listener — already uses `{ once: true }` (confirmed at line 215 of upload-queue.ts).
- `categorizeVideo` apiCategory null guard — already present: `if (video.apiCategory)` at line 51 of useData.ts.
- `/report-stall` endpoint auth — intentionally unauthenticated by design (any player reports stalls, rate-limited to 5/min per IP).
