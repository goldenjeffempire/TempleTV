---
name: zod esbuild externalize on Replit
description: zod v4 ESM files cannot be bundled by esbuild through pnpm virtual store on Replit — must be externalized.
---

# zod must be externalized in esbuild builds on Replit

**Rule:** Add `"zod"` to the `external` array in `artifacts/api-server/build.mjs`.

**Why:** zod v4 ships ESM-only sub-path files (e.g. `v4/core/schemas.js`). esbuild resolves these through pnpm's virtual store symlinks using relative paths like `../../node_modules/.pnpm/zod@3.25.76/...`. On Replit this resolution fails with "Cannot read file" errors even though the files exist on disk. Node's own ESM resolver handles the package exports map correctly at runtime, so externalizing zod fixes the build without breaking runtime behavior.

**How to apply:** In `artifacts/api-server/build.mjs`, in the `external` array of the shared esbuild config, include `"zod"`. This is already done — do not remove it.
