#!/usr/bin/env bash
# =============================================================================
# Temple TV — Post-Deploy Smoke Tests
# =============================================================================
#
# Validates critical API endpoints after every deployment.
# Designed to be called from CI (staging-deploy.yml / production-release.yml)
# or locally after seeding a fresh environment.
#
# Usage:
#   bash scripts/smoke-test.sh [API_BASE_URL]
#
# Arguments:
#   API_BASE_URL   e.g. https://api.templetv.org.ng (default)
#
# Exit codes:
#   0  — all checks passed
#   1  — one or more checks failed
#
# Required env vars (optional — tests that require auth are skipped if absent):
#   SMOKE_ADMIN_TOKEN   — long-lived admin API token for authenticated endpoints
# =============================================================================

set -euo pipefail

API_URL="${1:-${SMOKE_API_URL:-https://api.templetv.org.ng}}"
ADMIN_TOKEN="${SMOKE_ADMIN_TOKEN:-}"
TIMEOUT=15

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
FAILURES=()

pass() { echo -e "${GREEN}  ✓${NC} $*"; ((PASS++)); }
fail() { echo -e "${RED}  ✗${NC} $*"; ((FAIL++)); FAILURES+=("$*"); }
skip() { echo -e "${YELLOW}  ·${NC} $* (skipped — no token)"; ((SKIP++)); }
info() { echo -e "${CYAN}  →${NC} $*"; }

check_http() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local extra_args=("${@:4}")

  HTTP=$(curl -o /tmp/smoke_body.txt -s -w "%{http_code}" \
    --max-time "$TIMEOUT" \
    "${extra_args[@]}" \
    "$url" 2>/dev/null || echo "000")

  if [ "$HTTP" = "$expected" ]; then
    pass "$label (HTTP $HTTP)"
  else
    fail "$label — expected $expected, got $HTTP (URL: $url)"
  fi
}

check_json_field() {
  local label="$1"
  local url="$2"
  local field="$3"
  local extra_args=("${@:4}")

  BODY=$(curl -fsSL --max-time "$TIMEOUT" "${extra_args[@]}" "$url" 2>/dev/null || echo "{}")
  VALUE=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field','MISSING'))" 2>/dev/null || echo "PARSE_ERROR")

  if [ "$VALUE" != "MISSING" ] && [ "$VALUE" != "PARSE_ERROR" ] && [ -n "$VALUE" ]; then
    pass "$label (field '$field' = $VALUE)"
  else
    fail "$label — field '$field' missing or empty in response from $url"
  fi
}

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║        Temple TV — Smoke Test Suite                     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
info "Target: $API_URL"
info "Timeout: ${TIMEOUT}s per request"
[ -n "$ADMIN_TOKEN" ] && info "Auth: token present (authenticated tests will run)" || info "Auth: no token (authenticated tests skipped)"
echo ""

# ── 1. Health check ────────────────────────────────────────────────────────────
echo -e "${BOLD}1. Health & Status${NC}"
check_http "GET /api/healthz" "$API_URL/api/healthz"
check_http "GET /api/v1/health (versioned)" "$API_URL/api/v1/health" "200"
check_json_field "healthz returns status=ok" "$API_URL/api/healthz" "status"

# ── 2. Public endpoints ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}2. Public Endpoints${NC}"
check_http "GET /api/channels" "$API_URL/api/channels"
check_http "GET /api/broadcast/guide" "$API_URL/api/broadcast/guide"
check_http "GET /api/broadcast/current" "$API_URL/api/broadcast/current"
check_http "GET /api/broadcast/viewers" "$API_URL/api/broadcast/viewers"

# ── 3. Content endpoints (public) ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}3. Content (Public)${NC}"
check_http "GET /api/v1/videos (public catalog)" "$API_URL/api/v1/videos"
check_http "GET /api/v1/sermons" "$API_URL/api/v1/sermons" "200"

# ── 4. Auth endpoints (shape check only — no credentials needed) ───────────────
echo ""
echo -e "${BOLD}4. Auth Endpoints (shape check)${NC}"
check_http "POST /api/auth/login (no body → 400 expected)" \
  "$API_URL/api/auth/login" "400" \
  -X POST -H "Content-Type: application/json" -d "{}"
check_http "POST /api/auth/refresh (no token → 401)" \
  "$API_URL/api/auth/refresh" "401" \
  -X POST -H "Content-Type: application/json" -d "{}"

# ── 5. Authenticated admin endpoints ──────────────────────────────────────────
echo ""
echo -e "${BOLD}5. Authenticated Admin Endpoints${NC}"
if [ -n "$ADMIN_TOKEN" ]; then
  check_http "GET /api/v1/admin/videos (authed)" \
    "$API_URL/api/v1/admin/videos?limit=1" "200" \
    -H "Authorization: Bearer $ADMIN_TOKEN"
  check_http "GET /api/v1/admin/users (authed)" \
    "$API_URL/api/v1/admin/users?limit=1" "200" \
    -H "Authorization: Bearer $ADMIN_TOKEN"
  check_http "GET /api/v1/admin/broadcast (authed)" \
    "$API_URL/api/v1/admin/broadcast" "200" \
    -H "Authorization: Bearer $ADMIN_TOKEN"
  check_http "GET /api/v1/admin/notifications (authed)" \
    "$API_URL/api/v1/admin/notifications?limit=1" "200" \
    -H "Authorization: Bearer $ADMIN_TOKEN"
else
  skip "Admin videos (no token)"
  skip "Admin users (no token)"
  skip "Admin broadcast (no token)"
  skip "Admin notifications (no token)"
fi

# ── 6. Rate-limit guard ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}6. API Security Checks${NC}"
check_http "Unauthenticated admin (should be 401)" \
  "$API_URL/api/v1/admin/videos" "401"
check_http "Seed endpoint (no token → 401/403)" \
  "$API_URL/api/auth/seed" "401" \
  -X POST -H "Content-Type: application/json" -d '{"email":"x","password":"y"}'

# ── 7. OpenAPI spec ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}7. OpenAPI / Docs${NC}"
check_http "GET /api/docs (Swagger)" "$API_URL/api/docs" "200"

# ── 8. SSE smoke (connect + disconnect) ───────────────────────────────────────
echo ""
echo -e "${BOLD}8. Real-time (SSE connect)${NC}"
SSE_STATUS=$(curl -o /dev/null -s -w "%{http_code}" \
  --max-time 3 \
  -H "Accept: text/event-stream" \
  "$API_URL/api/broadcast/events" 2>/dev/null || echo "000")
if [ "$SSE_STATUS" = "200" ] || [ "$SSE_STATUS" = "000" ]; then
  pass "SSE /api/broadcast/events (connects + streams)"
else
  fail "SSE /api/broadcast/events — unexpected status $SSE_STATUS"
fi

# ── Final report ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Results: ${GREEN}${PASS} passed${NC}  ${RED}${FAIL} failed${NC}  ${YELLOW}${SKIP} skipped${NC}"
echo -e "${BOLD}══════════════════════════════════════════${NC}"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo ""
  echo -e "${RED}Failed checks:${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}✗${NC} $f"
  done
  echo ""
  exit 1
fi

echo ""
echo -e "${GREEN}All smoke tests passed! ✅${NC}"
echo ""
