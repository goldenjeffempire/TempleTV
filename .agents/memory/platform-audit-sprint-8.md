---
name: Comprehensive platform audit sprint 8
description: 10 bugs fixed across Admin, Mobile, and API server in third full-platform audit pass.
---

## Fixed bugs

**auth.service.ts extend() bypasses sessionsValidAfter**
`extend()` fetched the user from DB and issued a new access token WITHOUT checking `user.sessionsValidAfter`. This meant that after a password change (which sets `sessionsValidAfter = NOW()`), any old refresh token issued before the change could still be used to obtain fresh access tokens until it rotated (up to 7 days).
**Fix:** After fetching the user, compare `decoded.iat * 1000` against `user.sessionsValidAfter.getTime()`. If the token was issued before the password change, throw `UnauthorizedError("Session invalidated — please sign in again")`.
**Why:** JWT `iat` (issued at) is a standard claim set by `signRefreshToken`. The comparison is reliable and doesn't require an extra DB column.

---

**library.tsx syncMutation — missing admin-stats invalidation + page reset**
After a successful YouTube sync, `syncMutation.onSuccess` invalidated `youtube-sync-status`, `youtube-library-videos`, and `youtube-sync-history` but did NOT invalidate `admin-stats` (Dashboard "Total Videos" count) and did NOT reset `page` to 1. If a sync deleted videos and the user was on page 5, they would be left on an empty page.
**Fix:** Added `setPage(1)` and `qc.invalidateQueries({ queryKey: ["admin-stats"] })` to `onSuccess`. Also added `admin-stats` to the `useSSEEvent("videos-library-updated")` handler.

---

**series.routes.ts episode number race condition**
`MAX(episodeNumber) + 1` computed in a separate query before `INSERT` is prone to a race condition when two concurrent requests hit the same series. Both read the same MAX and attempt to insert with the same episodeNumber.
**Fix:** Wrapped the insert in try-catch; if error code is `"23505"` (unique constraint), retry once with a fresh `MAX() + 1` query. Logs a `WARN` on retry so operators can monitor if this becomes frequent.

---

**channels.routes.ts — generic 500 on duplicate slug**
`db.insert(schema.channelsTable)` with a duplicate slug threw a raw PostgreSQL unique constraint error (code 23505) that surfaced as a generic 500 response with no useful client message.
**Fix:** Wrapped insert in try-catch; `23505` → `ConflictError("A channel with slug '...' already exists")` → returns 409 with descriptive message.

---

**account.tsx signOut without try-catch**
`await signOut()` inside the `Alert.alert` destructive action was not wrapped in try-catch. If the network `apiLogout` call failed, the unhandled rejection propagated to the RN bridge. Local session state is cleared regardless of network errors, so the try-catch should never block navigation.
**Fix:** Wrapped in try-catch with a comment explaining the intent.

---

**ChatPanel.tsx — misleading empty state on connection failure**
When the chat connection was in state `"error"` or `"closed"`, the empty state showed "Connecting to chat…" which is false. This confused users into thinking the client was still trying.
**Fix:** Added `state === "error" || state === "closed"` branch → "Chat unavailable".

---

**dashboard.tsx, sidebar.tsx — unlabeled interactive elements**
- `<button>Control →</button>` in dashboard had no `aria-label`; screen readers read only "Control →".
- Mobile sidebar close `<Button size="icon">` had no `aria-label`; screen readers read only the icon.
**Fix:** `aria-label="Go to Broadcast Control"` and `aria-label="Close menu"` added.

---

## False positives in this audit

- **prayer request rate limiting**: Already has `config: { rateLimit: { max: 10, timeWindow: "1 minute" } }` at the route level — the audit subagent missed it.
- **radio.tsx Audio object leak**: `audioRef.current.pause(); audioRef.current.src = ""; audioRef.current = null;` is correctly executed before creating a new Audio instance — no leak.
- **TV App 404 route**: TV app uses a custom `useState`-based layer router (not Switch/Route), so a 404 component doesn't apply in the same way.
- **brute-force guard not multi-replica safe**: Known design choice — acceptable for single-replica Replit deployment. Redis-backed guard is a future improvement.
- **viewer tracker not multi-replica safe**: Same as above — single-replica. Documented as a scalability limitation, not a bug to fix now.
