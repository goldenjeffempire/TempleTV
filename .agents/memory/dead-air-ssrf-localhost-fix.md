---
name: Dead-air SSRF localhost fix
description: Root cause and fix for broadcast queue items being rejected in production mode on Replit/no-API_ORIGIN environments.
---

## The Rule

`isAllowed()` in `universal-source-resolver.ts` must NOT block localhost unconditionally in `NODE_ENV=production`. It must only block localhost when `API_ORIGIN` or `RENDER_EXTERNAL_URL` is set (proving a real production deployment).

**Why:** The `Start API` workflow sets `NODE_ENV=production` for performance. Without `API_ORIGIN` or `RENDER_EXTERNAL_URL`, `normalizeQueueUrl()` falls back to `http://localhost:PORT` for relative `/api/v1/uploads/…` paths. The old `isLoopbackHost && NODE_ENV=production → return false` check then rejected every locally-uploaded item → `resolved.length=0` → OFF_AIR with items in queue.

**Fix applied:**
```js
const hasConfiguredPublicOrigin = !!(
  process.env["API_ORIGIN"] || process.env["RENDER_EXTERNAL_URL"]
);
if (isLoopbackHost && env.NODE_ENV === "production" && hasConfiguredPublicOrigin) return false;
```

## How to Apply

Any time locally-uploaded videos are in the queue but `reloadInner` reports "no playable local content" with `API_ORIGIN` unset — this is the bug. Check `normalizeQueueUrl()` output and `isAllowed()` for the localhost gate.

## Supporting Fixes (same session)

- `normalizeQueueUrl()` and `getOwnBase()` now check `REPLIT_DEV_DOMAIN` as a fallback origin before `http://localhost:PORT`
- `.replit.dev` and `.repl.co` added to `ALLOWED_HOST_SUFFIXES` so Replit public HTTPS URLs pass the allowlist
- `reloadInner()` resets `_lastQueueHash = ""` when `resolved.length === 0 && rawRows.length > 0` — forces the next drift poll to retry resolution instead of short-circuiting forever
- `orchestrator.resetQueueHash()` public method added; `/reload` REST endpoint now calls it before `reload()` so "Reload from queue" forces full re-resolution even when DB content is unchanged

## Content Context

As of June 2026 this Replit dev DB has 955 videos — ALL YouTube imports (`video_source='youtube'`). YouTube videos are excluded from the v2 broadcast queue by design. The YouTube shuffle fallback activates ~30s after startup on an empty queue and plays catalog videos as an override. The broadcast queue must contain locally-uploaded (non-YouTube) videos for the v2 orchestrator to use them.
