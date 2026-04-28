#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Render install wrapper — single source of truth used by every service's
# buildCommand in render.yaml.
#
# WHY THIS EXISTS:
#
# Render's build cache restores `node_modules/` from the previous deploy. When
# a previous deploy installed a different lockfile-pinned version of any
# package (most painfully observed on `@types/react` during the 19.1.x → 19.2.x
# catalog bump on 2026-04-28), the orphaned package directory in
# `node_modules/.pnpm/` survives across deploys. `pnpm install
# --frozen-lockfile --prefer-offline` does NOT proactively prune those
# orphans — it only ensures the linked top-level dependency graph matches the
# lockfile. The `verify:react-types-singleton` guardrail (which scans
# `node_modules/.pnpm/` directly to catch the dual-types-copy class of TS2786
# / TS2607 errors that fail Render builds) then trips on the leftover
# directory and the deploy fails — even when the committed lockfile is
# byte-clean and a fresh `pnpm install` from an empty `node_modules` would
# produce the correct singleton.
#
# This script defeats that failure mode by deleting every workspace
# `node_modules/` directory before install. The pnpm content-addressable
# store at `~/.local/share/pnpm/store/` is cached separately by Render and
# survives across deploys, so the subsequent `--prefer-offline` install is
# just symlink creation from the warm store (typically ~25–45 s — the same
# speed as a warm cache install would have been, but with a guaranteed
# zero-orphan `node_modules`).
#
# This also closes the door on every future variant of "Render cache
# pollution from a prior deploy that pinned different versions" — not just
# the @types/react case. Any catalog bump, override change, or transitive
# resolution shift is now safe.
#
# WHAT IT DOES:
#
# 1. Remove every workspace `node_modules/` so install starts from a clean
#    layout (the pnpm STORE survives, so this is fast).
# 2. `corepack enable` to ensure the pinned pnpm version from `packageManager`
#    in `package.json` is on PATH.
# 3. `pnpm install --frozen-lockfile --prefer-offline --prod=false`:
#      --frozen-lockfile  reproducible CI installs (required for deploys)
#      --prefer-offline   reuse pnpm STORE cache (saves ~60 s)
#      --prod=false       Render sets NODE_ENV=production by default, which
#                         would skip devDependencies. Every artifact's
#                         tsconfig declares `"types": ["node", "vite/client"]`
#                         and both `@types/node` and `vite` live in
#                         devDependencies, so without this flag tsc fails
#                         with TS2688. Forcing this flag overrides Render's
#                         NODE_ENV for the install step only.
# ──────────────────────────────────────────────────────────────────────────────

echo "==> [render-install] Pruning stale node_modules to defeat Render-cache orphan-package pollution"
rm -rf \
  node_modules \
  artifacts/*/node_modules \
  lib/*/node_modules \
  lib/integrations/*/node_modules \
  scripts/node_modules

echo "==> [render-install] Enabling corepack (pins pnpm to packageManager version)"
corepack enable

echo "==> [render-install] Installing dependencies (frozen-lockfile, prefer-offline, prod=false)"
pnpm install --frozen-lockfile --prefer-offline --prod=false

echo "==> [render-install] Done"
