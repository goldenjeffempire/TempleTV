#!/usr/bin/env bash
# eas-build-pre-install.sh
#
# EAS Build pre-install hook — runs before pnpm install on every EAS build.
#
# Strategy: make every step non-fatal so EAS's own "pnpm": "10.26.1" mechanism
# (set in eas.json) can take over if our upgrade attempts fail.
#
# Required EAS secrets (set via: eas secret:create --scope project):
#   GOOGLE_SERVICES_JSON_BASE64         — base64-encoded android google-services.json
#   GOOGLE_SERVICE_INFO_PLIST_BASE64    — base64-encoded ios GoogleService-Info.plist

echo "[pre-install] === Temple TV pre-install hook starting ==="
echo "[pre-install] Node: $(node --version 2>/dev/null || echo 'unknown')"
echo "[pre-install] npm:  $(npm --version 2>/dev/null || echo 'unknown')"
echo "[pre-install] corepack: $(corepack --version 2>/dev/null || echo 'not found')"

# ── 1. Determine current pnpm version ─────────────────────────────────────────
CURRENT_PNPM="$(pnpm --version 2>/dev/null || echo '0.0.0')"
CURRENT_MAJOR="${CURRENT_PNPM%%.*}"
echo "[pre-install] pnpm location: $(which pnpm 2>/dev/null || echo 'not found')"
echo "[pre-install] pnpm version:  ${CURRENT_PNPM} (major=${CURRENT_MAJOR})"

# ── 2. Upgrade pnpm to 10 if needed (ALL steps non-fatal) ─────────────────────
if [ "${CURRENT_MAJOR:-0}" -lt 9 ] 2>/dev/null; then
  echo "[pre-install] pnpm < 9 — attempting upgrade to pnpm@10.26.1"

  # Attempt A: corepack enable (replaces pnpm shim in Node bin dir)
  echo "[pre-install] Attempt A: corepack enable"
  corepack enable 2>&1 || echo "[pre-install] corepack enable failed (non-fatal)"

  # Attempt B: corepack prepare (downloads and activates pnpm 10)
  echo "[pre-install] Attempt B: corepack prepare pnpm@10.26.1 --activate"
  corepack prepare pnpm@10.26.1 --activate 2>&1 || echo "[pre-install] corepack prepare failed (non-fatal)"

  # Attempt C: npm install -g (adds pnpm 10 to npm global bin)
  echo "[pre-install] Attempt C: npm install -g pnpm@10.26.1"
  npm install -g pnpm@10.26.1 --registry https://registry.npmjs.org 2>&1 || \
    echo "[pre-install] npm install -g pnpm@10.26.1 failed (non-fatal)"

  # Attempt D: direct binary replacement at $(which pnpm)
  echo "[pre-install] Attempt D: direct binary replacement"
  OLD_PNPM="$(which pnpm 2>/dev/null || echo '')"
  NPM_ROOT="$(npm root -g 2>/dev/null || echo '')"
  PNPM10_CJS="${NPM_ROOT}/pnpm/bin/pnpm.cjs"
  if [ -n "$OLD_PNPM" ] && [ -n "$NPM_ROOT" ] && [ -f "$PNPM10_CJS" ]; then
    if [ -w "$OLD_PNPM" ]; then
      printf '#!/bin/sh\nexec node "%s" "$@"\n' "$PNPM10_CJS" > "$OLD_PNPM" 2>/dev/null && \
        chmod +x "$OLD_PNPM" 2>/dev/null && \
        echo "[pre-install] Replaced $OLD_PNPM with pnpm@10.26.1 wrapper" || \
        echo "[pre-install] Could not replace $OLD_PNPM (non-fatal)"
    else
      echo "[pre-install] $OLD_PNPM is not writable (non-fatal)"
    fi
  else
    echo "[pre-install] pnpm10.cjs not found at $PNPM10_CJS (non-fatal)"
  fi

  UPGRADED_PNPM="$(pnpm --version 2>/dev/null || echo 'unknown')"
  echo "[pre-install] pnpm version after upgrade attempts: ${UPGRADED_PNPM}"
else
  echo "[pre-install] pnpm ${CURRENT_PNPM} is already >= 9 — no upgrade needed"
fi

# ── 3. Inject Firebase credential files (non-fatal) ───────────────────────────
echo "[pre-install] Injecting Firebase credentials"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd 2>/dev/null || echo '.')"

if [ -n "${GOOGLE_SERVICES_JSON_BASE64:-}" ]; then
  echo "[pre-install] Writing real google-services.json from EAS secret"
  echo "$GOOGLE_SERVICES_JSON_BASE64" | base64 --decode > "$SCRIPT_DIR/google-services.json" 2>/dev/null && \
    echo "[pre-install] google-services.json written" || \
    echo "[pre-install] Failed to write real google-services.json — placeholder remains (non-fatal)"
else
  echo "[pre-install] GOOGLE_SERVICES_JSON_BASE64 not set — placeholder google-services.json will be used (push notifications require the real file)"
fi

if [ -n "${GOOGLE_SERVICE_INFO_PLIST_BASE64:-}" ]; then
  echo "[pre-install] Writing GoogleService-Info.plist from EAS secret"
  echo "$GOOGLE_SERVICE_INFO_PLIST_BASE64" | base64 --decode > "$SCRIPT_DIR/GoogleService-Info.plist" 2>/dev/null && \
    echo "[pre-install] GoogleService-Info.plist written" || \
    echo "[pre-install] Failed to write GoogleService-Info.plist (non-fatal)"
else
  echo "[pre-install] GOOGLE_SERVICE_INFO_PLIST_BASE64 not set (non-fatal)"
fi

echo "[pre-install] === Done. Exiting with 0 ==="
exit 0
