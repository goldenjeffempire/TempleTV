---
name: ESLint flat-config bare glob misses nested files
description: Why root-level *.js/*.mjs/*.cjs override blocks in eslint.config.mjs silently skipped nested config/plugin files across the monorepo.
---

In ESLint flat config, a bare glob like `"*.js"` in a `files` array only matches
files directly in the config's base directory (the repo root here) — it does
NOT match nested paths like `artifacts/mobile/metro.config.js` or
`artifacts/mobile/plugins/with-*.js`.

**Why:** the monorepo's root `eslint.config.mjs` had a `files: ["*.mjs", "*.cjs", "*.js"]`
block intended to give all Node-run config/build files `globals.node` (require,
module, process, console, __dirname). Because the glob was bare, every nested
`.js` file (Expo config plugins, `metro.config.js`, `babel.config.js`, build
scripts, `server/serve.js`) was instead falling through to the generic
TS/browser-oriented global config and produced ~160 false-positive `no-undef`
errors (console/process/require/URL/fetch/setTimeout "not defined"). Service
worker files (`sw*.js`) have their own scope (`self`, `caches`) and need
`globals.serviceworker`, not `globals.node`.

**How to apply:** any `files` pattern meant to apply repo-wide in a flat config
must use `**/*.ext`, not `*.ext`, unless you deliberately want root-only files.
When auditing a monorepo's lint setup, run ESLint's JSON formatter and count
`no-undef` hits per file — a cluster of "console/process/require not defined"
across unrelated nested config files is almost always this glob bug, not real
code issues.
