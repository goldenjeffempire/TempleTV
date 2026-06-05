---
name: Sprint 36 full-platform audit fixes
description: 10 confirmed bugs fixed across admin frontend, mobile, and API server during comprehensive platform audit.
---

## Fixes

### Admin frontend
1. **videos.tsx** — `updateMutation` and `featureMutation` both missing `broadcast-queue` + `playlists` query invalidation on success.
2. **playlists.tsx `updateMutation`** — missing `schedule` invalidation (playlist rename not reflected in schedule page).
3. **playlists.tsx `deleteMutation`** — missing `schedule` invalidation (deleted playlist still shown as schedule content reference).
4. **schedule.tsx** — no `endTime > startTime` validation; no URL validation for external stream entries; fixed with inline error messages.
5. **notifications.tsx** — `scheduleMutation` had no future-time guard; `min` attribute on datetime-local input was static; fixed with live-updating 60s interval.
6. **broadcast.tsx** — `autoQueuePending` Set lost on page refresh; fixed by persisting to `sessionStorage` key `broadcast:autoQueuePending`.

### Mobile
7. **mobile `_layout.tsx`** — `handleAllow()` had `catch {}` swallowing push permission errors silently; fixed with `console.warn`.
8. **mobile `useEmergencyAlerts.ts`** — initial fetch `.catch(() => {})` swallowed errors; fixed with `console.warn` (SSE still delivers real-time alerts).

### API server
9. **graphics.routes.ts** — `setTimeout(async () => { await db.update() })` without try/catch → unhandledRejection crash on DB error; fixed with void-IIFE + try/catch + `.unref()`.
10. **emergency.routes.ts** — same pattern on alert auto-dismiss timer; same fix applied.

## Key false positives documented
- `ytPoller` stop() not wired to shutdown: intentional (`.unref()` allows process exit — comment in source explains)
- `youtube-live.routes.ts` heartbeat: cleanup fires on `req.raw.on("close")` — correctly clears interval
- `GET /radio` rate limiting: covered by global 120 req/min rate limiter
- `useVideos.ts` retry setTimeout: React's dep-array cleanup runs `clearTimeout` before re-run — correct pattern
- broadcast-v2 forward-scan anchor drift: low-severity, re-applies harmlessly on restart
- `naturalItemEnd` zero-duration gap: anchor advances regardless of duration DB write-back gate
- dashboard `dashboard-engine-health` key vs `broadcast-v2-engine-health`: intentional separate caches; dashboard SSE handler already invalidates `dashboard-engine-health`
