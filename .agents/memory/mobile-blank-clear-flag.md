---
name: Global NODE_ENV=production breaks dev workflows in this workspace
description: This workspace has a global NODE_ENV=production env var. Any dev workflow that does not explicitly override it breaks. Covers mobile/TV blank preview AND admin/TV/mockup $RefreshSig$ Fast Refresh errors.
---

# Root cause shared by several "works in one workflow, broken in another" bugs

This workspace has a **workspace-global `NODE_ENV=production`** env var. Every dev
workflow that does NOT set its own `NODE_ENV` inherits `production`, which
silently breaks dev-only behavior. Two confirmed symptoms below. The durable
fix is to make the thing run in development mode — either inline in the workflow
command (like "Start application" does) or, more robustly, by prefixing the
package `dev` script with `NODE_ENV=development` so it is correct no matter which
workflow launches it.

## Symptom A — `$RefreshSig$ is not defined` in admin / TV / mockup canvas previews

The canvas artifact dev workflows ("artifacts/admin: web", "artifacts/tv: web",
"artifacts/mockup-sandbox: …") run `pnpm --filter @workspace/<app> run dev` with
NO `NODE_ENV`, so they inherit `production`. `@vitejs/plugin-react`'s
`transformIndexHtml` skips injecting the React Fast Refresh preamble when
`config.isProduction` is true (`skipFastRefresh = config.isProduction`), BUT the
module transform still emits top-level `$RefreshSig$()` / `$RefreshReg$()` calls
→ every component module throws `ReferenceError: $RefreshSig$ is not defined`
(first import-site reported, e.g. `auth-context.tsx`). The whole SPA fails to
mount. The "Start application" workflow (port 5000) is immune only because it
sets `NODE_ENV=development` inline.

**Fix:** prefix each app's `dev` script with `NODE_ENV=development`
(`"dev": "NODE_ENV=development vite …"`) in `artifacts/{admin,tv,mockup-sandbox}/package.json`,
then restart those workflows.

**Verify (mind the canvas base path):** the canvas serves each artifact under a
base path — `/admin/`, `/tv/`, `/__mockup/` (via `BASE_PATH`), NOT `/`. So curl
`http://localhost:<port>/admin/` and `…/admin/@react-refresh` (200 = fixed), not
`/` (404, misleading). Ports: admin 23744, tv 23876, mockup varies — read the
`➜ Local:` line in each workflow log. The HTML must contain
`window.$RefreshSig$ = …` and the preamble import must be base-prefixed
(`/admin/@react-refresh`).

## Symptom B — Mobile/TV web preview blank/white through the main domain

The mobile (`artifacts/mobile`) Expo web preview — and the TV preview — are
served through the **main janeway domain**, which `.replit` maps to
**localPort 8080 → externalPort 80** (the API server, "Start API" workflow).
Expo is configured with `EXPO_PACKAGER_PROXY_URL=https://$REPLIT_DEV_DOMAIN`
(the bare main domain, no port), so the loaded page requests its JS bundle at
`https://<domain>/artifacts/mobile/index.ts.bundle`. That hits the API server,
which must **proxy** mobile/TV paths to the Expo Metro dev server (`:18115`)
and the TV Vite dev server. The proxy lives in `app.ts`.

There are TWO distinct failure modes:

## 1. Permanent white screen — dev proxy disabled by production mode (the real bug)

The dev proxy block in `app.ts` (which registers `/mobile/*`,
`/artifacts/mobile/*`, `/tv/*`, `/assets/*`, Expo HMR `/hot` `/message`) is
gated behind `if (env.NODE_ENV !== "production")`. The workspace has a
**global `NODE_ENV=production`** env var set. The "Start API" workflow command
did not set its own `NODE_ENV`, so it inherited `production` → the dev proxy
**never registered** → every `/artifacts/mobile/*` bundle request returned
**404** → the HTML loaded but the JS never did → white screen.

**Tell:** API logs show `"env":"production"` and the line
`dev Mobile proxy registered …` is ABSENT; `GET /artifacts/mobile/index.ts.bundle`
returns 404 through the janeway domain but 200 when you curl `:18115` directly.

**Fix:** run the dev API workflow in development mode. The "Start API" workflow
command must explicitly set `NODE_ENV=development` (matching the sibling
"Start application" workflow, which already does). The deployment `run` command
in `.replit` keeps `NODE_ENV=production` — that is correct for real production,
where the apps are served as pre-built static SPA files, not proxied.

**Why:** `env.ts` defaults `NODE_ENV` to `development`, and the "Start API"
command passes `MOBILE_DEV_PORT=18115` — both prove the author intended dev
mode + the dev proxy. The workspace-global `NODE_ENV=production` silently
overrode the default. Note `MOBILE_DEV_PORT`/`TV_DEV_PORT` both have defaults
in `env.ts`, so you cannot gate the proxy on their presence — gating must stay
on `NODE_ENV`.

**How to apply:** if mobile/TV preview is white through the main domain, first
check the API server's `NODE_ENV`. If it is `production` in the dev workspace,
that disables the proxies. Verify with
`curl -o /dev/null -w '%{http_code}' http://localhost:8080/artifacts/mobile/index.ts.bundle?platform=web&dev=true&...`
— 404 = proxy off, 200 = healthy.

## 2. Brief blank on restart — `--clear` flag wipes Metro cache

Separately, the mobile `dev` script in `artifacts/mobile/package.json` ran
`expo start … --clear`, wiping Metro's bundler cache on every start
("Bundler cache is empty, rebuilding"). Metro then rebuilds the ~13 MB web
bundle on first request, so the iframe is blank for ~60–90s after each restart.
Removing `--clear` lets restarts reuse the on-disk cache (warm bundle ~0.3s).
This is a flicker/warmup annoyance, NOT the permanent white screen above.

# Local Android .aab build is impossible in this container

No Android SDK (`ANDROID_HOME` empty, no `sdkmanager`/`gradle`), no `android/`
prebuild dir, only JDK 17. The local `build:android` gradle script cannot run
here. Build the `.aab` via **EAS cloud build** (`EXPO_ACCESS_TOKEN` is
configured) with the `production-android` profile — it emits `app-bundle`
(.aab) with `autoIncrement: false`, so `android.versionCode` in `app.json` must
be bumped manually each release. eas-cli is not installed locally; invoke via
`npx eas-cli` (the `scripts/eas-build.sh` wrapper hardcodes a global `eas`).
The npx install of eas-cli is very slow in this container (6+ min).
