---
name: EAS build OOM root causes
description: 5 compounding causes of Node.js heap OOM during expo export:embed on EAS workers; permanent fixes applied in v1.0.29.
---

## Rule

When EAS builds die with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` during the Metro/expo-export-embed phase, there are 5 known causes for this codebase:

1. **NODE_OPTIONS too low** — must be `--max-old-space-size=8192` in all eas.json release profiles AND in the `export:embed:android/ios`, `build:web`, `typecheck` npm scripts. 4096 is not enough for a monorepo with 5 workspace packages + Reanimated + Hermes compilation.

2. **Metro maxWorkers unset** — defaults to CPU count (4 on EAS medium = 4 workers × 600 MB = 2.4 GB consumed before the bundler even starts). Fix: `config.maxWorkers = Math.max(1, Math.min(2, os.cpus().length))` in `metro.config.js`. Override via `METRO_MAX_WORKERS` env var.

3. **Dead browser-only deps in mobile package.json** — `shaka-player` was in mobile `dependencies` but never imported in mobile source (TV-only library). Even though metro.config.js stubs it via `resolveRequest`, Metro still traverses its package.json exports map. Remove such deps from mobile package.json; keep the `resolveRequest` stub as defense.

4. **SENTRY_DISABLE_AUTO_UPLOAD missing on staging profiles** — Sentry source map upload on non-production EAS builds adds post-bundle memory pressure. Add `SENTRY_DISABLE_AUTO_UPLOAD=true` to every profile that is not explicitly the production upload target.

5. **resourceClass: medium for production Android bundles** — complex monorepos benefit from `large`. Production and production-android profiles should use `resourceClass: "large"`.

**Why:** These five causes compound. Cause 1 (heap ceiling) × Cause 2 (worker amplification) means 4096 / 4 = only 1 GB effective heap per process at peak — far below Metro's ~2 GB working set for this codebase.

**How to apply:** When any new EAS profile is added to eas.json, it must include `NODE_OPTIONS: "--max-old-space-size=8192"` and, if it's a non-production build, `SENTRY_DISABLE_AUTO_UPLOAD: "true"`. When any new native or browser-only library is added to the monorepo and appears in mobile's node_modules, grep mobile source first to confirm actual usage before adding it to `dependencies`.
