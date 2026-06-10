---
name: Broadcast health webhook sprint 102
description: Full broadcast health webhook system — outbound HTTP POST alerts with HMAC-SHA256 signing, admin UI, and three hook points.
---

## What was built

### webhook.service.ts
`artifacts/api-server/src/modules/broadcast-v2/webhook/webhook.service.ts` (new file)
- `sendBroadcastWebhook(event, channel, data)` — fire-and-forget, never throws to caller
- `sendBroadcastWebhookSync(event, channel, data)` — awaitable, returns `WebhookDeliveryResult` (used by test endpoint)
- `getWebhookStatus()` — returns `{ configured, urlMasked?, recentDeliveries: WebhookDelivery[] }` for status endpoint
- `isWebhookConfigured()` — boolean check
- In-memory delivery log: last 20 entries (module-level array, mutated by id)
- HMAC-SHA256 signing: `X-Temple-TV-Signature: sha256=<hex>` header (same as GitHub webhook convention)
- Retry: up to `BROADCAST_WEBHOOK_RETRY_ATTEMPTS` with `1s * 2^(n-1)` backoff between attempts
- Timeout: `AbortController` with `BROADCAST_WEBHOOK_TIMEOUT_MS` per attempt; timer `.unref()`'d
- Extra headers: `X-Temple-TV-Delivery` (UUID), `X-Temple-TV-Event`, `X-Temple-TV-Attempt`
- URL masking: shows `scheme://host/***` only, never the full path (safe for admin display)

### env.ts additions (after `BROADCAST_DEADAIR_FALLBACK_AFTER_MS`)
- `BROADCAST_WEBHOOK_URL` — optional URL, enables the feature
- `BROADCAST_WEBHOOK_SECRET` — HMAC-SHA256 signing secret (min 16 chars)
- `BROADCAST_WEBHOOK_TIMEOUT_MS` — default 5 000
- `BROADCAST_WEBHOOK_RETRY_ATTEMPTS` — default 3, max 10

### Hook points
1. **orchestrator escalateDeadAir()** — fires `dead_air` after confirming DB has items but orchestrator sees 0; fires `recovery` after scheduling self-heal reload. Uses `this.startedAtWallMs` (NOT `startedAtMs`) for uptime calculation.
2. **queue-integrity-validator.ts** — fires `item_deactivated` with `{ reason, count, itemIds }` after each of the 4 auto-deactivation sites: `duplicate_active_video`, `missing_video_join`, `corrupt_upload`, `orphaned_video_ref`. Called AFTER the `adminEventBus.push()` call at each site.

### API routes (in rest.routes.ts)
**IMPORTANT**: Routes inside `restRoutes` must use SHORT paths (no `/broadcast-v2/` prefix) because `broadcastV2Routes` in `index.ts` registers `restRoutes` directly without a prefix, and `broadcastV2Routes` itself is mounted at `/broadcast-v2` in `app.ts`. Using `/broadcast-v2/webhook/status` inside `restRoutes` creates `/broadcast-v2/broadcast-v2/webhook/status` (double prefix bug).

- `GET /api/broadcast-v2/webhook/status` → registered as `app.get("/webhook/status", ...)` — rate limit 30/min, adminGuard
- `POST /api/broadcast-v2/webhook/test` → registered as `app.post("/webhook/test", ...)` — rate limit 5/min, adminGuard; awaits `sendBroadcastWebhookSync` and returns result

### Admin UI (broadcast-v2.tsx)
- Added `Webhook, Send` to lucide-react imports
- Added `WebhookDelivery`, `WebhookStatusData`, `WebhookTestResult` types inside the component
- Added `webhookStatus` query (`["broadcast-v2-webhook-status"]`, 120s refetch, 60s stale)
- Added `testWebhookMutation` (POST `/broadcast-v2/webhook/test`, refetches status on success)
- Webhook card inserted between Queue Health Report card and `<TranscodingProgressPanel />`:
  - Configured/Not configured badge
  - "Send Test" button (spinner while pending)
  - If not configured: instructions for env vars
  - If configured: masked URL + delivery history (last 8, with event badge, status icon, HTTP code/duration)

## Key decisions

**Why** fire-and-forget in the orchestrator/validator: webhook delivery must never block the broadcast tick loop or validator cycle. A slow/offline receiver should not affect broadcast reliability.

**Why** in-memory delivery log (not DB): delivery history is ephemeral monitoring state — it doesn't need to survive restarts, and DB writes would add latency to the hot path. The last 20 deliveries is sufficient for the admin status card.

**Why** the dead_air webhook fires only on the "items_blocked" path (not empty queue): the truly empty queue case (dbCount=0) is handled by the library scan backstop — alerting would be redundant and noisy if the queue is intentionally empty.

**Why** both `dead_air` and `recovery` events in `escalateDeadAir()`: operators need paired events to calculate dead-air duration in their monitoring system. The recovery event fires when the self-heal reload is scheduled (not when it succeeds) to keep the hook synchronous-path only.
