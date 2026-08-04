---
name: pnpm patch + lockfile sync — both EAS and Render fail
description: When patchedDependencies is in package.json but missing from pnpm-lock.yaml settings, frozen-lockfile installs fail on both EAS and Render with distinct errors.
---

## The rule
After regenerating a pnpm patch file, always run `pnpm install --ignore-scripts` locally and commit both the patch file AND the updated `pnpm-lock.yaml`. The lockfile must have a `patchedDependencies` section in its settings that matches `package.json`.

## Why
- **EAS** (`--frozen-lockfile`): installs the unpatched package (no `patch_hash` in snapshot key) → Gradle/Kotlin compilation fails at runtime
- **Render** (`render-install.sh --frozen-lockfile`): `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` — pnpm detects `patchedDependencies` in `package.json` but nothing in the lockfile settings → build fails immediately before any code compiles

Both failures look unrelated on the surface (Kotlin type error vs config mismatch) but share the same root cause: lockfile not regenerated after adding/changing a patch.

## How to apply
1. When a new patch is created or an existing one is modified: `pnpm install --ignore-scripts` → commit both `patches/*.patch` + `pnpm-lock.yaml`
2. Verify the lockfile has `patchedDependencies:` section at the top level
3. Verify the snapshot key for the affected package includes `patch_hash=...`
4. Also verify the patched store entry has the expected changes (grep for the patched lines)

## Corruption detection
A corrupt patch (bad hunk header) produces: `ERR_PNPM_INVALID_PATCH: hunk header integrity check failed`
Fix: regenerate from raw npm tarball → `curl registry.npmjs.org/pkg/-/pkg-version.tgz | tar xz` → make edits → `diff -u` → write new patch → `pnpm install`.
