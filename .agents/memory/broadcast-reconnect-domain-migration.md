---
name: Broadcast reconnect hardening & domain migration
description: Domain migration api.→admin.templetv.org.ng, player FATAL state, escape-valve re-report, load timeout reduction.
---

## Domain migration (api.templetv.org.ng → admin.templetv.org.ng)

**Rule:** The canonical production domain is now `admin.templetv.org.ng` — both the admin SPA and the API are served from the same origin.

**Where to update when this happens again:**
- `API_ORIGIN` env var (shared) → `https://admin.templetv.org.ng`
- `PROD_SYNC_API_URL` env var (development) → `https://admin.templetv.org.ng`
- `CORS_ORIGINS_EXTRA` secret → delete (onrender.com wildcard no longer needed)
- `render.yaml`: `CORS_ORIGINS_EXTRA: ""`, `API_BASE_URL: https://admin.templetv.org.ng`
- `api-base.ts`: remove `admin.* → api.*` hostname rewrite inference (was for old split-domain Render setup)
- `prod-queue-sync.ts absolutizeUrl()`: add `parsed.hostname === "api.templetv.org.ng"` to the onrender.com rewrite condition, so DB rows from before migration still resolve correctly
- Orchestrator log messages that hardcode the domain

**Why:** Old split-domain Render setup had admin SPA at admin.* and API at api.*. The new unified setup serves both from admin.*. Without removing the inference, the SPA would rewrite its own origin to a non-existent api.* host.

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
