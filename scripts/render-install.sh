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

# ── Environment detection ──────────────────────────────────────────────────
# RENDER is set to "true" by Render's build environment.
# In Replit (and other non-Render environments) RENDER is unset.
IS_RENDER="${RENDER:-false}"

if [ "$IS_RENDER" = "true" ]; then
  # ── Render only: prune stale node_modules ────────────────────────────────
  # Render restores node_modules from the previous deploy. When the lockfile
  # has changed (catalog bump, override change, etc.) orphan packages survive
  # in node_modules/.pnpm/ and trip the react-types-singleton guardrail.
  # Wiping node_modules forces a clean install from the warm pnpm STORE
  # (typically ~25–45 s — same speed as a cached install, zero orphans).
  #
  # In Replit/Nix the pnpm virtual store uses hardlink trees with in-progress
  # _tmp_NNNN extraction directories that `rm -rf` cannot remove (returns
  # ENOTEMPTY even with -rf). Skipping this block in Replit is safe because
  # Replit never caches node_modules between runs — every boot is a fresh
  # `pnpm install --ignore-scripts` anyway.
  echo "==> [render-install] Pruning stale node_modules to defeat Render-cache orphan-package pollution"
  rm -rf \
    node_modules \
    artifacts/*/node_modules \
    lib/*/node_modules \
    lib/integrations/*/node_modules \
    scripts/node_modules

  # ── Render only: corepack enable ─────────────────────────────────────────
  # Render's container owns its own Node.js bin directory, so corepack can
  # write symlinks freely. In Replit's Nix sandbox the Node.js prefix is
  # read-only (EACCES), so we skip this step there.
  echo "==> [render-install] Enabling corepack (pins pnpm to packageManager version)"
  corepack enable
else
  echo "==> [render-install] Non-Render environment detected — skipping node_modules prune and corepack enable"
fi

echo "==> [render-install] Installing dependencies (frozen-lockfile, prefer-offline, prod=false)"
pnpm install --frozen-lockfile --prefer-offline --prod=false

echo "==> [render-install] Done"
