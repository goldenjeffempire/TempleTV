---
name: Stale patch causes EAS frozen-lockfile failure
description: A patch whose changes are already present upstream causes pnpm to fail on EAS's clean store, while passing locally due to cached patched versions.
---

# Stale patch → EAS `pnpm install --frozen-lockfile` failure

## The rule
Before running an EAS build, verify every patch in `pnpm.patchedDependencies` still applies to the raw npm package. If the upstream package has already incorporated the patch's changes, remove the patch entry from `package.json`, `pnpm-lock.yaml`, and the `patches/` directory, then run `pnpm install` to regenerate the lockfile.

**Why:** pnpm caches patched packages. Local `pnpm install --frozen-lockfile` passes because it reuses the cached patched version. EAS uses a clean store and must download the raw package from npm, then apply the patch — which fails if the lines to replace no longer exist in the source.

**How to apply:** When EAS shows `pnpm install --frozen-lockfile exited with non-zero code: 1` in the Install dependencies phase, and local install passes, check every `patches/*.patch` file:
1. Look at the `--- a/` file in the patch and compare with the installed version in `node_modules/.pnpm/`.
2. If the installed file already has the "new" content (patch changes already upstream), the patch is stale.
3. Remove: patch file, `package.json` pnpm.patchedDependencies entry, `pnpm-lock.yaml` patchedDependencies + all `(patch_hash=...)` snapshot entries.
4. Run `pnpm install` to regenerate lockfile, verify `pnpm install --frozen-lockfile` passes.

## Incident
`react-native-keyboard-controller@1.21.9.patch` modernized Gradle DSL (`compileSdkVersion→compileSdk`, `lintOptions→lint`). Upstream v1.21.9 already contained these changes. Patch removed July 2026.
