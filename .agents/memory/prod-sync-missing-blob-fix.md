---
name: prod-sync MISSING_BLOB false positive
description: Two bugs caused prod-sync'd items to be permanently deactivated as MISSING_BLOB when running on Replit dev with API_ORIGIN pointing to the remote prod server.
---

## Rule
When REPLIT_DEV_DOMAIN is set, API_ORIGIN is the remote production server — NOT this process. Any code that determines "is this URL hosted on me?" must exclude API_ORIGIN from own-host lists when REPLIT_DEV_DOMAIN is present.

## Bug 1 — queue-integrity-validator
`deriveStorageKey()` extracted an `uploads/…` key from absolute production URLs like `https://api.templetv.org.ng/api/v1/uploads/abc.m4v` and checked the LOCAL `storage_blobs` table. The blob only exists in the Neon production DB, so local check always returns "missing" → item deactivated.

**Fix:** added `isOwnOriginUrl()` helper with the same REPLIT_DEV_DOMAIN guard as `normalizeQueueUrl`; `deriveStorageKey()` returns `null` for external-origin absolute URLs, skipping the local blob check entirely.

Reverse pass also fixed: items deactivated as `missing_blob` whose `deriveStorageKey` now returns null (external origin) are immediately re-activated rather than staying stuck forever.

## Bug 2 — broadcast-orchestrator `toLocalhostProbeUrl`
`ownHostnames` included `env.API_ORIGIN` unconditionally. On Replit dev this caused the probe for `https://api.templetv.org.ng/api/v1/uploads/abc.m4v` (extracted by `extractRawProbeUrl` from the media-proxy wrapper) to be rewritten to `http://127.0.0.1:PORT/api/v1/uploads/abc.m4v` — which returns 404 (blob not in local DB) → repeated probe failure → MISSING_BLOB deactivation.

**Fix:** moved `replitDevDomain` lookup before the `ownHostnames` array; `API_ORIGIN` excluded from own-hosts when `replitDevDomain` is truthy.

## How to apply
Any future function that asks "is this URL served by *this* process?" must follow the same pattern:
```ts
const replitDevDomain = process.env["REPLIT_DEV_DOMAIN"];
const ownHosts = [
  replitDevDomain,                              // always own-origin on Replit
  process.env["RENDER_EXTERNAL_URL"],           // always own-origin on Render
  process.env["DEV_DOMAIN"],
  !replitDevDomain ? process.env["API_ORIGIN"] : undefined, // prod only
].filter(Boolean)…
```

**Why:** `normalizeQueueUrl` / `getOwnBase` in `queue.repo.ts` already had this guard. `toLocalhostProbeUrl` and `deriveStorageKey` / `isOwnOriginUrl` in the validator did not — they were added after the original fix and the pattern wasn't replicated.
