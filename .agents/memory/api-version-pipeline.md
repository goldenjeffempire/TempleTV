---
name: API version fallback + version bump pipeline
description: npm_package_version is not set when API started with bare `node` command; all version-carrying files must be bumped together.
---

## Rule
`process.env.npm_package_version` is only auto-set by Node.js when the process is started via `npm run` / `pnpm run`. The Replit and Render start commands invoke `node` directly, so this env var is always `undefined` in production.

**Why:** health.routes.ts, admin-ops.routes.ts, and app.ts all fall back to the hardcoded string literal when APP_VERSION is unset and npm_package_version is unset. That string must be kept current.

## How to apply
1. Every version bump must update all of:
   - `artifacts/mobile/app.json` (expo.version + android.versionCode + ios.buildNumber)
   - `artifacts/mobile/package.json`
   - `artifacts/api-server/package.json`
   - `artifacts/tv/lg/appinfo.json`
   - `artifacts/tv/tizen/config.xml`
2. The three fallback strings in source must also be updated when a major version boundary is crossed:
   - `artifacts/api-server/src/modules/health/health.routes.ts` (2 occurrences)
   - `artifacts/api-server/src/modules/admin-ops/admin-ops.routes.ts` (1 occurrence)
   - `artifacts/api-server/src/app.ts` (1 occurrence — root route)
3. All three release scripts (`scripts/version-bump.sh`, `scripts/release-all.sh`, `.github/workflows/production-release.yml`) already include the api-server package.json update as of v1.0.20.
4. Alternatively: set `APP_VERSION` env var in the start command to avoid the fallback entirely.
