---
name: Mobile @expo/cli version drift breaks config plugins
description: A stale @expo/cli devDependency (behind the expo SDK version) silently breaks `expo config`/prebuild for any plugin that needs @expo/config-plugins, including @sentry/react-native's plugin.
---

`@expo/cli` in package.json must track the same major/minor line as the `expo` SDK dependency. When it drifts behind (e.g. `@expo/cli` on SDK 54 while `expo` is on SDK 57), pnpm resolves two conflicting versions of `@expo/config-plugins` (one per @expo/cli major). With `shamefully-hoist=true`, pnpm refuses to hoist a package to root `node_modules` when there are multiple conflicting versions — so `@expo/config-plugins` never lands at the root.

Any Expo config plugin that assumes hoisted resolution (e.g. `@sentry/react-native`'s `app.plugin.js` → `withSentryAndroidGradlePlugin.js`) then throws `Cannot find module '@expo/config-plugins'` the moment `expo config`/`expo prebuild`/EAS build tries to apply it — a full build-time failure, not just a doctor warning.

**Why:** discovered while auditing the mobile app's build system; `npx expo-doctor` did not surface this (it only flags version *mismatches* against SDK-known-good versions, not resolution failures), it only showed up by actually invoking `expo config --json --full` and reading the stack trace.

**How to apply:** after any Expo SDK bump, always bump `@expo/cli` to match, then verify with `npx expo config --json --full` (must exit 0) — don't rely on `expo-doctor` alone to catch this class of bug. Also: `expo-modules-core` as a *direct* dependency is required (not redundant) when the app has local native modules with `peerDependencies.expo-modules-core` (e.g. custom modules in `modules/`) — removing it passes one expo-doctor check but fails another ("missing peer dependency... app may crash outside of Expo Go").
