---
name: Sprint 40 cross-surface audit fixes
description: 8 bugs fixed across API security, real-time, and admin frontend
---

## Bugs fixed

### 1. Seed endpoint timing oracle (auth.routes.ts)
- `POST /auth/seed` used `===` to compare `SEED_TOKEN` — observable timing difference.
- Fix: `timingSafeEqual(Buffer.from(a), Buffer.from(b))` with equal-length guard.

### 2. Editor-can-ban-admin privilege escalation (admin.routes.ts)
- `POST /admin/users/:id/ban` only checked `requireAuth("editor")` — an editor could ban an admin or system account.
- Fix: after fetching target user, compare numeric `ROLE_RANK` — if target rank ≥ caller rank throw `ForbiddenError`. Also throw `NotFoundError` if user not found (avoids role leak).

### 3. Chat WS cleanup registered after async join (chat.routes.ts)
- `socket.on("close")` / `socket.on("error")` registered AFTER `await chatHub.join()` — if socket closed during the DB fetch, cleanup never ran and viewer count leaked.
- Fix: register both handlers BEFORE the `chatHub.join()` call; `cleanup` idempotent via `cleaned` flag.

### 4. SSE EventSource teardown leak in transport.ts (lib/player-core)
- `teardownSse` was a local variable; `stop()` couldn't reach it, so named event listeners were never removed and GC cycle held the EventSource open on Tizen/webOS.
- Fix: promoted to instance field `this.sseCleanup`; `stop()` calls it.

### 5. transcodeMutation wrong invalidation key (videos.tsx)
- `onSuccess` only invalidated `["admin-videos"]` — the Transcoding Pipeline tab (which uses `["transcoding-queue"]`) stayed stale after queuing a video.
- Fix: added `void qc.invalidateQueries({ queryKey: ["transcoding-queue"] })`.

### 6. schedule.tsx deleteMutation missing playlists key
- Deleting a scheduled item didn't invalidate `["playlists"]` — the Playlists page showed the deleted item referenced in its count until manual reload.
- Fix: added `void qc.invalidateQueries({ queryKey: ["playlists"] })` to `deleteMutation.onSuccess`.

### 7. settings.tsx missing error state
- `isError` from `useQuery` was not rendered — operators saw a blank table with no retry option when the API was unreachable.
- Fix: added `isError` check above the table that renders an `ErrorAlert` with a `refetch` button.

### 8. series.tsx Fragment wrapper — TS compile error
- `EpisodesDialog` returned two sibling root elements (`<Dialog>` + `<AlertDialog>`) without a Fragment — TypeScript TS1005/TS1128 prevented the admin SPA build.
- Fix: wrapped both elements in `<>...</>` Fragment in the return statement.

**Why:** standard pattern — any function returning JSX must have exactly one root element. AlertDialog added in a previous sprint but fragment was never added.
