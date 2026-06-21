---
name: Admin SSE rate-limit death spiral
description: Why per-minute rate limits on SSE endpoints cause persistent "Reconnecting" banners and how to fix it.
---

## The rule

Never put a per-minute `rateLimit` plugin on a long-lived SSE endpoint.
Use a **concurrent-per-IP Map** instead (same pattern as `realtime/sse.gateway.ts`).

## Why

Rate-limit plugins increment their counter when the request arrives.
For a normal SSE session (one connection per tab, held open for hours) this is fine — each tab uses one rate-limit slot that expires in a minute.

But during a **server restart** (OOM, deploy) every open tab disconnects simultaneously and every tab reconnects within milliseconds, burning through the entire per-minute window instantly.
Once the limit is hit:
- Client gets 429 → `onerror` → `scheduleReconnect()`
- Reconnect attempt → 429 again
- Loop persists for the full 60-second rate-limit window
- Admin sees "Reconnecting" banner for up to a minute per restart

**Why:** The per-minute primitive is designed for repeated quick requests (API calls), not for long-lived connections where "how many times did you connect this minute?" is the wrong question.

## How to apply

- `/admin/live/events`: removed `rateLimit` plugin; added `adminSseConnections Map<ip, count>` + `MAX_ADMIN_SSE_PER_IP = 20`.
- Auth failure early-returns must `adminSseDecrement(ip)` before replying — wrap in a `rejectAuth()` helper to avoid leaking slots.
- `/sse-token` endpoint (quick token fetch before each SSE handshake): rate limit IS appropriate here, but raise to ≥ 120/min so reconnection storms don't exhaust it (was 30/min).
- Client-side `OPEN_TIMEOUT_MS`: 45 s (was 20 s) to cover Render cold-start (~30 s) + Redis auth round-trips.
