---
name: Corrupted pnpm patch file & duplicate const build blocker
description: Two distinct blockers hit during initial "get it running" setup — a corrupted pnpm patch file and a duplicate `const` in content-rotation.ts.
---

## Corrupted pnpm patch file blocks all installs
`patches/@sentry+react-native@7.11.0.patch` had wrong hunk-header line counts (e.g. `@@ -29,8 +29,8 @@` claiming 8 lines but only 5 present) — a corruption unrelated to concurrency/rate-limiting, even though it surfaced alongside 429s from concurrent `pnpm install`s across workflows.

**Why:** `ERR_PNPM_INVALID_PATCH ... hunk header integrity check failed` looks like a transient/environment error but is a content-level corruption of the patch file itself (likely from how it was originally committed/edited).

**How to apply:** If a `pnpm install` fails with `ERR_PNPM_INVALID_PATCH`, don't assume it's rate-limiting or a stale store — regenerate the patch: extract the real unpatched file from `node_modules/.pnpm/<pkg>/...`, copy it twice, apply the intended edits to one copy, and run `diff -u` to produce a correctly-countable unified diff, then normalize headers to `diff --git a/... b/...` / `--- a/...` / `+++ b/...` style.

## Duplicate `const` silently breaks esbuild build
`artifacts/api-server/src/modules/broadcast-v2/engine/content-rotation.ts` had `const q = schema.broadcastQueueTable;` declared twice at module scope (lines 55 and 98) — a real pre-existing bug, not caused by the patch fix. esbuild's build step (`node ./build.mjs`) failed with "The symbol \"q\" has already been declared" once install got past the patch error.

**Why:** worth remembering because it was masked by the earlier install-level failure — after fixing one blocker, a second, unrelated one surfaced. When setting up an unfamiliar/imported project, expect to fix blockers in layers (install → build → runtime), not all at once.
