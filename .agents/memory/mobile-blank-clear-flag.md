---
name: Mobile (and TV) web preview blank/white in Replit dev workspace
description: Why the Expo mobile / TV web preview goes blank or white in the dev workspace and the two distinct causes
---

# Mobile/TV web preview blank in the Replit dev workspace

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
