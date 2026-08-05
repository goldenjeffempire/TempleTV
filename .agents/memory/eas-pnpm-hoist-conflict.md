---
name: EAS submission fails when pnpm peer-hash variants block hoisting
description: Multiple peer-hash variants of expo/expo-router prevent pnpm from hoisting them; EAS CLI then can't find expo binary or resolve config plugins.
---

## Rule

Before running `eas build`, verify that `expo` and `expo-router` are hoisted to the workspace root `node_modules/`. Check:

```bash
ls node_modules/.bin/expo     # must exist
ls node_modules/expo-router   # must exist
```

If either is missing, run `pnpm install --ignore-scripts` from the workspace root (typically finishes in ~20s using the pnpm store cache). **Do not proceed with eas build until these exist.**

## Why

pnpm with `shamefully-hoist=true` hoists packages to root `node_modules/`. BUT if there are multiple peer-hash variants of the same package (e.g. `expo@57.0.6_...hash1` and `expo@57.0.6_...hash2`), pnpm refuses to pick one to hoist — the root symlink is simply absent. This happens when a failed install leaves stale store entries with conflicting peer resolutions.

EAS CLI then fails in two ways:
1. `npx expo config --json` exits with code 127 (expo binary not found)
2. Fallback `@expo/config` evaluation fails with "Failed to resolve plugin for module 'expo-router'"

The actual EAS build (on cloud workers) is not affected — it installs from scratch. Only the local submission step fails.

## How to apply

After any failed or partial `pnpm install`, run `pnpm install --ignore-scripts` before `eas build`. The install uses the warm pnpm store cache and completes in ~20s. The `expo` and `expo-router` symlinks are then resolved correctly.

**Why there are multiple variants:** Different workspace packages resolve `react-dom`, `@babel/core`, or `@expo/metro-runtime` to different versions, causing pnpm to create separate peer-resolved instances. Pinning catalog entries (especially react/react-dom) to exact versions reduces the risk.
