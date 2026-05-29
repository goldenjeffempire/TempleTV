---
name: EAS build profile conventions
description: versionCode management rules, node version, and profile completeness checks for EAS builds.
---

## Rules

**versionCode — manual management for `production-android`**
The `production-android` profile sets `autoIncrement: false`. This means EAS will NOT auto-increment versionCode; it reads directly from `app.json` `android.versionCode`. You MUST bump this field manually before each Play Store release via this profile.

The `production` profile (combined iOS + Android) and all other store profiles use `autoIncrement: true`, so EAS handles the counter from the Play Store / App Store automatically.

**Why:** Two separate profiles exist intentionally — `production` for automated CI/CD pipelines (EAS tracks the counter), `production-android` for manual releases where operators need deterministic versionCode control.

**How to apply:** Before every `eas build --platform android --profile production-android` run, check `app.json` `android.versionCode`, bump it by 1, commit, then build.

---

**Node version — all profiles must have a `node` key**
Every EAS build profile should declare `"node": "22.14.0"` (or the current LTS). The `appletv` profile was missing this key entirely and was relying on EAS default (older). Fixed: all 10 profiles now have `node: "22.14.0"`.

**Why:** Missing `node` key falls back to EAS's default which may differ from the workspace Node version (24.x), causing subtle build failures or package compatibility issues with Node-version-sensitive native build scripts.

**How to apply:** When adding a new EAS profile, always copy the `node` key from an existing profile.

---

**`__DEV__` guard for console statements in mobile**
Any `console.warn` / `console.error` / `console.log` in mobile library code (not in component render paths where React DevTools already strips them) must be wrapped with `if (__DEV__)`. Bare calls fire in production Hermes builds and show up in device logs / crash reporters.

**Why:** `lib/apiBase.ts` had a bare `console.warn` in the protocol auto-fix path. Fixed to `if (__DEV__ && typeof console !== "undefined")`.
