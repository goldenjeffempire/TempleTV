---
name: Prod-sync media proxy bypass in dev
description: Root cause and fix for "RECONNECTING TO BROADCAST" on TV player when API_ORIGIN is set in a dev/Replit environment that mirrors production queue.
---

## The Bug
When `API_ORIGIN=https://api.templetv.org.ng` is set in the dev Replit environment (for prod-sync to work), `getOwnBase()` and `normalizeQueueUrl()` in `queue.repo.ts` treated that origin as "same-origin". Prod-sync MP4 items stored relative paths (`/api/v1/uploads/…`) which were absolutized to `https://api.templetv.org.ng/…`. Because those URLs matched `getOwnBase()`, `resolveSource()` skipped the media-proxy step. The browser received raw `api.templetv.org.ng` URLs, which were blocked by the production server's `Cross-Origin-Resource-Policy: same-origin` header → buffer error cascade → player FSM entered reconnect loop → "RECONNECTING TO BROADCAST" amber strip shown indefinitely.

## The Fix
Added `IS_PROD_NODE_ENV = process.env.NODE_ENV === "production"` constant in `queue.repo.ts`. Both `getOwnBase()` and `normalizeQueueUrl()` now use `(IS_PROD_NODE_ENV ? env.API_ORIGIN : undefined)`, so in dev the fallback chain `RENDER_EXTERNAL_URL → REPLIT_DEV_DOMAIN → localhost` is used instead. All prod-sync MP4 items are now routed through the local media proxy (URL shape: `https://{REPLIT_DEV_DOMAIN}/api/v1/media-proxy?url=…&sig=…`).

**Why:** In dev, `API_ORIGIN` is set to the production API URL purely so prod-sync can absolutize relative upload paths when it reads the upstream guide. It must never be used as the "own origin" for media-proxy decisions — that would make the server think prod-sync URLs are local, bypassing the proxy and exposing the browser to CORP-blocked responses.

**How to apply:** Any code that asks "is this URL mine, so I can skip proxying?" must use `IS_PROD_NODE_ENV` to gate `API_ORIGIN`. In production, `API_ORIGIN` = own server URL (correct). In dev, own server URL comes from `REPLIT_DEV_DOMAIN` or `RENDER_EXTERNAL_URL`.

## Secondary fix
`main.ts` startup validation updated: when `API_ORIGIN` is set but `NODE_ENV !== "production"`, logs an INFO explaining the dev-mode behaviour (used only for prod-sync absolutizing; own-origin/proxy uses `REPLIT_DEV_DOMAIN`). Previously it logged the misleading "API_ORIGIN validated — own-origin and media proxy URLs will use this base" even in dev.

## Files changed
- `artifacts/api-server/src/modules/broadcast-v2/repository/queue.repo.ts`
- `artifacts/api-server/src/main.ts`
