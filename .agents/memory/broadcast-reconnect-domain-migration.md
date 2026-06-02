---
name: Broadcast reconnect hardening & canonical domain architecture
description: Canonical domain layout (api.* = API, admin.* = SPA), PROD_SYNC_API_URL misconfiguration root cause, player FATAL state, escape-valve re-report, load timeout reduction.
---

## Canonical domain architecture (CURRENT)

**Rule:** The two canonical production domains are SEPARATE:
- `api.templetv.org.ng` — API server (Fastify). All `/api/*` routes, HLS, uploads, WebSockets.
- `admin.templetv.org.ng` — Admin SPA only (React/Vite). Returns HTML for every non-asset path.

**`API_ORIGIN` must equal `https://api.templetv.org.ng`** — the server's OWN public origin.
Setting it to the admin SPA domain causes `normalizeQueueUrl()` / `getOwnBase()` to absolutize
local upload paths to the SPA, which returns HTML instead of media content.

**`PROD_SYNC_API_URL` must equal `https://api.templetv.org.ng`** — the upstream API to mirror from.
Setting it to `admin.templetv.org.ng` makes every `/api/broadcast/guide` poll return `<!DOCTYPE html>`,
producing `SyntaxError: Unexpected token '<'` on every 30 s tick and silently breaking broadcast
queue mirroring in development. The server now emits a startup WARN when it detects an `admin.*` hostname.

**`absolutizeUrl()` in `prod-queue-sync.ts`** rewrites ONLY `*.onrender.com` hostnames (deprecated
old Render hosting). It must NOT rewrite `api.templetv.org.ng` — that is a valid canonical URL.

**Why:** An earlier migration memo incorrectly recorded that both SPA and API were unified under
`admin.templetv.org.ng`. That architecture was not adopted. The domains are split: API under `api.*`,
SPA under `admin.*`. Any memo saying otherwise is stale.

**CORS_ORIGINS_EXTRA:** Should include `https://admin.templetv.org.ng` (admin SPA origin) so
admin dashboard API requests are accepted cross-origin.

## Player FATAL state from SKIP_PENDING cycles

**Rule:** After `SKIP_PENDING_FATAL_THRESHOLD = 3` same-anchor snapshots (≈24 s), machine.ts transitions to FATAL with 30 s auto-recovery (`FATAL_AUTO_RECOVERY_MS = 30_000`).

**How to apply:** Each snapshot while stuck in SKIP_PENDING with the same `startsAtMs` increments `skipPendingCycles`. At threshold → `transition("FATAL")` + set `fatalRecoveryTimer` (30 s → `transition("SYNCING")` + `onNeedSnapshotCb()`). Clear timer in `transition()` (state !== FATAL) and `destroy()`.

**Why:** Prevents an infinite "loading" spinner for permanently broken items. Viewers see "Stream temporarily unavailable — auto-retrying in 30 s" instead. Machine self-heals after 30 s.

## Escape valve re-reports stall before forceReconnect

**Rule:** The escape-valve `useEffect` in `react.ts` tracks `pendingItemId` and sends `POST /report-stall` before calling `forceReconnect()`. This supplements the primary stall-reporter (which guards against duplicate same-session reports via `lastReportedId`).

**Why:** The per-session duplicate guard can block re-reports when the server didn't advance (e.g., action cooldown). The escape valve re-report ensures skip-count increments even when the guard fires, eventually triggering auto-suspension of permanently-broken items.

**Note:** `baseUrl` must be added to the escape-valve effect's dependency array since it's now used in the timer callback.

## Load timeout reduction (20 s → 15 s)

`BIND_LOAD_TIMEOUT_MS` and `WATCHDOG_INITIAL_LOAD_MS` in `adapters/web.ts`, and the watchdog default in `watchdog.ts`, all reduced from 20 s to 15 s. Cuts per-bad-item dead air by 5 s per retry (3 retries × 5 s = 15 s total improvement). The 90 s `progress` extension still protects large files that are actively downloading.
