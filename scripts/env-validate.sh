#!/usr/bin/env bash
# =============================================================================
# Temple TV — Environment Variable Validator
# =============================================================================
#
# Validates that all required environment variables are set before a deploy.
# Exits non-zero if any required variable is missing or invalid.
#
# Usage:
#   bash scripts/env-validate.sh [--surface api|admin|tv|mobile|all]
#
# Surfaces:
#   api     — Fastify API server variables
#   admin   — Admin Vite build variables
#   tv      — TV Vite build variables
#   mobile  — Expo build variables
#   all     — All surfaces (default)
#
# Exit codes:
#   0 — all required variables present and valid
#   1 — one or more required variables missing or invalid
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

SURFACE="${1:-all}"
case "$SURFACE" in
  --surface=*) SURFACE="${SURFACE#--surface=}" ;;
esac

ERRORS=0
WARNINGS=0

fail()  { echo -e "${RED}  ✗ MISSING${NC} $1${2:+ — $2}" >&2; ((ERRORS++)) || true; }
warn()  { echo -e "${YELLOW}  ⚠ WARN${NC}   $1${2:+ — $2}"; ((WARNINGS++)) || true; }
ok()    { echo -e "${GREEN}  ✓ OK${NC}     $1"; }
info()  { echo -e "${CYAN}  ▸${NC} $*"; }

check_required() {
  local VAR="$1"
  local DESC="${2:-}"
  local MIN_LEN="${3:-0}"
  local VAL="${!VAR:-}"
  if [ -z "$VAL" ]; then
    fail "$VAR" "$DESC"
  elif [ "$MIN_LEN" -gt 0 ] && [ "${#VAL}" -lt "$MIN_LEN" ]; then
    fail "$VAR" "must be ≥$MIN_LEN chars (got ${#VAL})"
  else
    ok "$VAR"
  fi
}

check_optional() {
  local VAR="$1"
  local DESC="${2:-}"
  local VAL="${!VAR:-}"
  if [ -z "$VAL" ]; then
    warn "$VAR" "not set — ${DESC}"
  else
    ok "$VAR"
  fi
}

check_not_wildcard() {
  local VAR="$1"
  local VAL="${!VAR:-}"
  if [ "$VAL" = "*" ]; then
    fail "$VAR" "must not be '*' in production"
  elif [ -n "$VAL" ]; then
    ok "$VAR"
  else
    fail "$VAR" "required"
  fi
}

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║      Temple TV — Environment Variable Validation         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── API Server ────────────────────────────────────────────────────────────────
if [[ "$SURFACE" == "api" || "$SURFACE" == "all" ]]; then
  info "=== API Server (Fastify) ==="

  check_required "DATABASE_URL"            "PostgreSQL connection string" 10
  check_required "JWT_ACCESS_SECRET"       "HMAC secret for access tokens" 32
  check_required "JWT_REFRESH_SECRET"      "HMAC secret for refresh tokens" 32
  check_required "NODE_ENV"                "application environment"
  check_required "PORT"                    "HTTP listen port"

  if [ "${NODE_ENV:-}" = "production" ]; then
    check_not_wildcard "CORS_ORIGINS"
    check_required "ADMIN_API_TOKEN"       "long-lived admin API key" 16
    check_required "APP_BASE_URL"          "canonical base URL for email links"
  else
    check_optional "CORS_ORIGINS"          "defaults to * in development"
    check_optional "ADMIN_API_TOKEN"       "recommended even in staging"
    check_optional "APP_BASE_URL"          "defaults to http://localhost:5000"
  fi

  check_optional "REDIS_URL"               "falls back to in-process LRU cache"
  check_optional "SMTP_HOST"              "email delivery — notifications disabled without it"
  check_optional "SMTP_PASS"              "SMTP password"
  check_optional "SENTRY_DSN"             "error tracking"
  check_optional "AWS_ACCESS_KEY_ID"      "S3 media storage"
  check_optional "AWS_SECRET_ACCESS_KEY"  "S3 media storage"
  check_optional "VAPID_PUBLIC_KEY"       "web push notifications"
  check_optional "VAPID_PRIVATE_KEY"      "web push notifications"
  check_optional "EXPO_ACCESS_TOKEN"      "Expo push notifications"
  echo ""
fi

# ── Admin SPA (Vite build-time) ───────────────────────────────────────────────
if [[ "$SURFACE" == "admin" || "$SURFACE" == "all" ]]; then
  info "=== Admin SPA (Vite build-time) ==="
  check_optional "VITE_API_URL"           "API base URL (relative path works in dev)"
  check_optional "BASE_PATH"              "defaults to /"
  echo ""
fi

# ── TV SPA (Vite build-time) ─────────────────────────────────────────────────
if [[ "$SURFACE" == "tv" || "$SURFACE" == "all" ]]; then
  info "=== TV SPA (Vite build-time) ==="
  check_optional "VITE_API_URL"           "API base URL (relative path works in dev)"
  check_optional "BASE_PATH"              "defaults to /"
  echo ""
fi

# ── Mobile / Expo (build-time) ────────────────────────────────────────────────
if [[ "$SURFACE" == "mobile" || "$SURFACE" == "all" ]]; then
  info "=== Mobile / Expo (build-time) ==="
  check_optional "EXPO_PUBLIC_API_URL"    "API base URL for Expo build"
  check_optional "EXPO_PUBLIC_DOMAIN"     "API domain (no https://)"
  check_optional "EXPO_TOKEN"             "Expo account token for EAS builds"
  check_optional "SENTRY_DSN"             "mobile error tracking"
  echo ""
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo "────────────────────────────────────────────────────────────"
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}✗ $ERRORS required variable(s) missing or invalid.${NC}"
  if [ "$WARNINGS" -gt 0 ]; then
    echo -e "${YELLOW}⚠ $WARNINGS optional variable(s) not set.${NC}"
  fi
  echo ""
  exit 1
else
  echo -e "${GREEN}✓ All required variables present.${NC}"
  if [ "$WARNINGS" -gt 0 ]; then
    echo -e "${YELLOW}⚠ $WARNINGS optional variable(s) not set (non-blocking).${NC}"
  fi
  echo ""
fi
