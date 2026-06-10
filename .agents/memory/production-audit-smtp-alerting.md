---
name: Production audit — SMTP alerting and monitoring gaps
description: 4 confirmed bugs found and fixed in SMTP transport, pre-flight checks, admin alerting, and operational email coverage.
---

## Bug 1 — `sendAdminAlert` defined but never wired to any health monitor

**Rule:** Every Tier-2 (full-recovery) escalation path MUST call both ops-alert SSE AND `sendAdminAlert`. SSE only reaches an open admin dashboard; email is the out-of-band path for overnight incidents.

**Fixed in:**
- `broadcast-health-monitor.ts` — Tier 2 full-recovery now emails admin
- `storage-health-monitor.ts` — `consecutiveFailures === FAILURE_THRESHOLD` now emails admin
- `memory-watchdog.ts` — critical RSS exit now emails admin (fire-and-forget before SIGTERM)

**Why:** If no one has the admin dashboard open at 3am when the broadcast is stuck or storage degrades, ops-alert SSE silently disappears and there is NO out-of-band notification.

---

## Bug 2 — SMTP pre-flight checks absent from production pre-flight block

**Fixed in:** `main.ts` production pre-flight block (lines 252–350 after fix).

**Rule:** Three SMTP scenarios:
- All three absent (`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`) → **warning** (intentional no-op is OK)
- Partially configured (1 or 2 of 3 set) → **error** (mailer always no-ops despite intent)
- All three present → **pass** (verifyMailer() confirms connectivity later)

---

## Bug 3 — `_transport` singleton in `mailer.ts` never resets after auth failure

**Rule:** After an SMTP auth failure (password rotation, credential change), `getTransport()` keeps returning the dead singleton — every `sendMail()` call keeps failing until process restart.

**Fix:** `sendMail()` now resets `_transport = null` when it catches `EAUTH` or `ECONNREFUSED`, so the next call to `getTransport()` recreates the pool with the current credentials.

**Added:** `export function resetTransport()` — allows admin test endpoint and integration tests to force a pool rebuild without a process restart.

**How to apply:** Any code that rotates SMTP credentials at runtime should call `resetTransport()` before the next send.

---

## Bug 4 — No SMTP test endpoint

**Fixed in:** `notifications.routes.ts` — `POST /api/v1/notifications/test-email` (admin-only, rate-limited 5/min).

Returns `{ ok, configured, recipient, messageId?, error? }`. On failure the response includes the error message so the operator knows exactly what is wrong (auth, host unreachable, TLS, etc.) without needing to read server logs.

---

## Confirmed non-bugs (false positives)

- `channels=1, engines=0` on boot — INTENTIONAL. Primary channel is managed by the v2 orchestrator; ChannelRegistry only creates ChannelEngine instances for non-primary channels.
- WS gateway (`ws.gateway.ts`) — all race conditions already fully handled: activeFrameHandler pointer, socketClosed flag, concurrent-resume guard, zombie detection, per-IP cap, graceful-shutdown registry.
- SSE gateway (`sse.gateway.ts`) — aborted sentinel, narrow-race guard, idempotent cleanup — all correct.
- storage-health-monitor `void this.check()` at initial probe — `check()` is fully wrapped in try/catch/finally and never throws externally; not a real bug.
- Broadcast-v2 startup/shutdown sequence — complete and correct across all 7 workers.
