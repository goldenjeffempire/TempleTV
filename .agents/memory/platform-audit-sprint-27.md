---
name: Comprehensive platform audit — sprint 27
description: 3 bugs fixed across auth, admin user management, and video/series lifecycle. Extensive false-positive triaging for chat, notifications, background workers, search, and admin UX.
---

## Bugs Fixed

### 1. Admin self-demotion / self-deletion not guarded (HIGH)
- `PATCH /admin/users/:id/role` and `DELETE /admin/users/:id` had no check preventing
  an admin from targeting their own account. Self-demotion would immediately revoke admin
  access; self-deletion is irreversible and could leave the platform without any admin.
- Fix: Added early `ForbiddenError("You cannot change your own role")` /
  `ForbiddenError("You cannot delete your own account")` when `req.params.id === req.principal?.id`.
- File: `artifacts/api-server/src/modules/admin/admin.routes.ts`

**Why:** Self-demotion is a footgun with no recovery path from within the UI. The ban route
(`/users/:id/ban`) was NOT guarded — banning yourself from chat is harmless.

### 2. Orphaned `series_episodes` rows when a video is deleted (MEDIUM)
- `DELETE /admin/videos/:id` cleaned up broadcast_queue and transcoding_jobs (steps 4 & 5
  in the fire-and-forget async block) but skipped `series_episodes`. After deletion, the
  series listing showed episode slots pointing at a non-existent video — the join returned
  null and the episode card could not render a title, thumbnail, or playback URL.
- Fix: Added step 6 to delete from `schema.seriesEpisodesTable` where `videoId = id`.
  Wrapped in `.catch()` (non-fatal; storage GC runs anyway). Logs episode count removed.
- File: `artifacts/api-server/src/modules/admin-videos/admin-videos.routes.ts`

### 3. JWT validation missing clock tolerance (LOW)
- `jwtVerify` in both `verifyAccessToken` and `verifyRefreshToken` had no `clockTolerance`
  option set. On multi-replica deployments or after NTP correction, tokens issued by one
  replica could be rejected by another if clocks drifted by even 1 second.
- Fix: Added `clockTolerance: 30` (seconds) to both calls. Tokens are still bounded by
  `JWT_ACCESS_TTL_SECONDS` / `JWT_REFRESH_TTL_SECONDS` — the tolerance only widens the
  acceptance window at the trailing edge of expiry.
- File: `artifacts/api-server/src/modules/auth/jwt.ts`

## Confirmed False Positives (Sprint 27)

### Auth / JWT
- Token-type claim enforcement prevents access tokens being used as refresh tokens.
- Refresh token rotation + `sessionsValidAfter` global revocation on password change — confirmed robust.
- `ADMIN_API_TOKEN` uses `timingSafeEqual` — constant-time comparison confirmed.
- `safeStringEqual` length check before `timingSafeEqual` leaks token length — this is
  unavoidable and is standard; token length is not secret.

### Chat / Real-time
- Message body sanitization: server stores raw string; React/RN clients auto-escape.
  No actionable XSS vector via the existing surfaces.
- WS `channelId` scoping confirmed correct — no cross-channel message leakage.
- Viewer count negative-count guard (`Math.max(0, ...)`) confirmed in both SSE/WS trackers.
- Emergency alert reliability: missed SSE reconnect → client fetches `/api/emergency/active` on reconnect.

### Notifications
- Double-fire prevention: atomic DB claim + idempotency key — two independent redundant layers.
- Expo/Web Push lazy pruning (410/404/DeviceNotRegistered → immediate token deletion) confirmed.
- Server-side opt-out gap: server delivers to all tokens regardless of mobile preference.
  This is the standard pattern for v1 (client-side gating + token removal on full unsubscribe).
  A per-category server-side preference table would be a follow-up feature, not a bug.

### Background Workers
- YouTube sync: `_syncInProgress` semaphore prevents concurrent scheduled + manual runs.
- Queue validator auto-fixes all idempotent; `DUPLICATE_SORT_ORDER` fix reassigns monotonic sequence.
- Faststart recovery: always restores prior `transcodingStatus` on failure; never leaves `processing`.
- Orphan cleanup: only deactivates broadcast_queue rows where joined video is physically missing.

### Videos / Search
- `plainto_tsquery` correctly used (not `to_tsquery`) — no SQL injection risk; Drizzle parameterizes.
- YouTube pagination: 100-page cap × 50 results = 5000 videos max — well above the 500 requirement.
- Watch history LWW concurrency: "Last Write Wins" is the intended behavior.
- Offset pagination skip/duplicate: known tradeoff; cursor pagination would be a follow-up improvement.
- Thumbnail generation fallback on no video stream: non-fatal warn; job still succeeds.

### Admin Dashboard
- Broadcast queue reorder: single atomic CASE UPDATE — all-or-nothing, no partial order corruption.
- Series episode concurrent add: catches 23505 constraint violation and retries with fresh MAX().
- Channel delete on active broadcast: channel registry stops the in-memory engine immediately.
  This is the correct behavior — no silent half-stopped state.
