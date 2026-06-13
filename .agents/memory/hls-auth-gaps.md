---
name: HLS auth gaps — probeDurationFromUrl and index export
description: Three gaps in HLS token auth coverage found and fixed; patterns to watch for in future work.
---

## Rule
Any code path that fetches an HLS URL (via fetch, ffprobe, or any HTTP client) must call `withHlsToken(url)` before making the request when `REQUIRE_HLS_TOKEN` may be enabled. `withHlsToken` is always safe to call — it's a no-op when `REQUIRE_HLS_TOKEN=false`.

## Gaps found and fixed

1. **`probeDurationFromUrl` in queue-integrity-validator.ts** — ffprobe was spawned with the raw URL, no token. When `REQUIRE_HLS_TOKEN=true` (auto-enabled when `HLS_TOKEN_SECRET` is set), ffprobe got 401 and returned no duration. Fix: `const probeUrl = withHlsToken(url)` before spawn.

2. **`.replit.app` missing from SSRF allowlist** — `universal-source-resolver.ts` had `.replit.dev` and `.repl.co` but not `.replit.app` (Replit production deployment domain). Queue items absolutized to a `*.replit.app` origin were rejected by `isAllowed()`. Fix: added `.replit.app` to `ALLOWED_HOST_SUFFIXES`.

3. **`mediaIntegrityScanner` not exported from `broadcast-v2/index.ts`** — imported internally by the index but not in the `export {}` at the bottom. `main.ts` destructured it from the index and got `undefined`, crashing the startup self-heal with `TypeError: Cannot read properties of undefined (reading 'clearFailureCounts')`. Fix: added `mediaIntegrityScanner` to the final export statement.

**Why:** `HLS_TOKEN_SECRET` is set in production secrets → `REQUIRE_HLS_TOKEN` auto-enables → every internal HLS fetch needs `withHlsToken`.

**How to apply:** When adding any new code that fetches an HLS URL server-side (ffprobe, fetch, http.get), always wrap the URL with `withHlsToken()` from `shared/hls-token.ts`. When adding a new export to a module's index.ts, confirm the final `export {}` statement lists it.
