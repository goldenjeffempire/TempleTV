---
name: Gradle configuration cache — incompatible with React Native / Expo / Sentry
description: org.gradle.configuration-cache=true breaks EAS Android builds; do not re-enable.
---

## Rule: never set org.gradle.configuration-cache=true in this project

**Why:** React Native's `build.gradle`, Expo's `resolveAppEntry` Gradle script, and Sentry's `sentry.gradle` all spawn external `node` processes during the Gradle *configuration phase*. Gradle's configuration cache explicitly forbids external process execution at configuration time. Enabling the cache fails the EAS build immediately with:

```
> Starting an external process 'node -e require('expo/scripts/resolveAppEntry')...' during configuration time is unsupported.
> Starting an external process 'node --print require.resolve('react-native/package.json')' during configuration time is unsupported.
> Starting an external process 'node --print require.resolve('hermes-compiler/package.json'...)' during configuration time is unsupported.
```

Build result: `Configuration cache entry discarded with 9 problems` → `BUILD FAILED`.

**How to apply:** The `with-gradle-config.js` plugin must NOT call `upsert("org.gradle.configuration-cache", "true")`. A comment explaining why is already in the plugin file header. Do not re-add this property until RN, Expo, and Sentry all fix their Gradle scripts to avoid configuration-phase `node` spawning (unlikely until RN adopts Gradle lazy configuration APIs across the board).

`org.gradle.caching=true` (local task-output cache) is safe and stays enabled — it's a different feature from configuration cache.
