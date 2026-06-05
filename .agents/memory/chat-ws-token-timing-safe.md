---
name: Chat WS ADMIN_API_TOKEN timing-safe comparison
description: WebSocket identity resolution in chat.routes.ts used === instead of timingSafeEqual for ADMIN_API_TOKEN — fix pattern documented here.
---

## Rule
Any ADMIN_API_TOKEN comparison in route handlers must use `safeStringEqual` from `../../middleware/auth.js`, NOT the `===` operator.

**Why:** Timing attacks on string equality allow an attacker to recover the token byte-by-byte via response-time oracle. The main `requireAuth` middleware and cookie path both use `safeStringEqual` already; `resolveWsIdentity()` in chat.routes.ts was the only missed site.

**How to apply:** When adding any new endpoint that accepts a bearer token and compares it to a static secret (ADMIN_API_TOKEN or similar), always import and use `safeStringEqual` from the auth middleware. Never use `===` for secret comparisons.

Fixed in: `artifacts/api-server/src/modules/realtime/chat.routes.ts` — import `safeStringEqual` added, `token === env.ADMIN_API_TOKEN` replaced with `safeStringEqual(token, env.ADMIN_API_TOKEN)`.
