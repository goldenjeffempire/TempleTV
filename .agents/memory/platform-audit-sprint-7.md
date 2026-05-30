---
name: Comprehensive platform audit sprint 7
description: 6 bugs fixed across CI/CD, TV lib, API telemetry, API security in the second full-platform audit pass.
---

## Fixed bugs

**CI Node version mismatch**
`engines` in `package.json` requires Node ≥24. Dockerfile uses node:24-alpine. But `.github/workflows/ci.yml` used `node-version: "20"` in all 5 jobs (typecheck, build-api, build-admin, build-tv, expo-doctor). Fixed to "24" in all jobs.
**Why:** Mismatched CI runtime can silently mask Node-version-specific bugs — e.g. native ES2022/2023 features that work in Node 24 but not 20 could pass CI then fail in production.

---

**liveFailureSignal.ts — window.location.origin vs resolveApiOrigin()**
`postFailureReport()` built the report URL as `${window.location.origin}/api/live/report-failure`. In packaged TV apps (Tizen, LG WebOS), the app is loaded from a local bundle so `window.location.origin` is `"null"` or `"file://"`, making the URL invalid and swallowing all failure signals silently.
**Fix:** Import and use `resolveApiOrigin()` from `./api.js` — same function all other TV API calls use.
**How to apply:** Any TV lib file that needs to call the API must use `resolveApiOrigin()`, never `window.location.origin`.

---

**telemetry.routes.ts — URL PII in logs**
`req.log.warn({ clientError: { url: body.context?.url } })` logged the full URL including query strings. URLs in client error reports can contain `?token=...`, `?code=...`, or session identifiers.
**Fix:** Strip query params before logging: `body.context?.url?.split("?")[0]`.
**How to apply:** Any server-side logging of client-supplied URLs should strip the query string first.

---

**video-serve.routes.ts — warn→error for missing HLS_TOKEN_SECRET**
When `HLS_TOKEN_SECRET` is unset in production, token signing falls back to a hardcoded default. The severity was `logger.warn`, which operators might miss. Changed to `logger.error` so it surfaces immediately in error dashboards.

---

**YouTube webhook — missing X-Hub-Signature verification**
YouTube PubSubHubbub allows operators to pass a `hub.secret` during subscription; the hub then signs every POST with `X-Hub-Signature: sha1=<hmac>`. The server was not passing a secret during subscription and not verifying signatures on incoming POSTs, allowing anyone to spoof webhook notifications.
**Fix:**
1. Added `YOUTUBE_WEBHOOK_SECRET` optional env var (min 16 chars) to `env.ts`.
2. When set, passes `hub.secret` in the subscription `URLSearchParams`.
3. POST handler verifies `X-Hub-Signature` using HMAC-SHA1 + `timingSafeEqual` before triggering sync.
**How to apply:** Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and set in Replit secrets. Verification is opt-in — omitting the env var disables it gracefully.

---

## False positives in this audit (do not re-investigate)

- **V2PlayerContainer timer cleanup**: Lines 515-522 have a dedicated `useEffect` cleanup that calls `clearBufferingWatchdog()`, `clearQuickFinishRetry()`, and `clearLoadTimeout()` — all timers are properly cleaned on unmount.
- **transport.ts heartbeatWatchdog in `stop()`**: `stop()` at line 299 explicitly calls `stopHeartbeatWatchdog()` which clears the interval at lines 503-505.
- **transport.ts `loadSnapshotCache` localStorage guard**: Lines 191-207 are already wrapped in a `try { } catch { return null; }` block.
- **fetchWithRetry.ts AbortSignal**: Intentional design — callers passing their own signal take precedence over the per-attempt timeout. The comment documents this explicitly.
- **usePlatformInit mouseover listener teardown**: Lines 167-170 document that Magic Remote hover→focus listeners are intentionally process-lifetime and don't need teardown.
- **live-ingest SSRF via probeEndpoint**: Only reachable by `requireAuth("editor")` + rate-limited to 10/min. Acceptable risk for an internal tool. Not a priority fix.
