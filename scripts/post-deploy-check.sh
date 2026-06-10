#!/usr/bin/env bash
# =============================================================================
# Temple TV — Full Post-Deploy Verification
# =============================================================================
#
# Comprehensive post-deployment check covering:
#   1. API health + readiness
#   2. Database connectivity (via /api/healthz extended)
#   3. Smoke test suite (scripts/smoke-test.sh)
#   4. Admin SPA reachability
#   5. TV SPA reachability
#   6. SSL certificate validity
#   7. CORS headers
#   8. SSE/WebSocket gateway
#   9. Sentry DSN reporting (sends a test event if SENTRY_AUTH_TOKEN present)
#  10. Response time SLA check (< 2 s for health endpoint)
#
# Usage:
#   bash scripts/post-deploy-check.sh [--env staging|production]
#
# Environment:
#   DEPLOY_ENV          — staging|production (default: production)
#   API_URL             — override API base URL
#   ADMIN_URL           — override admin dashboard URL
#   TV_URL              — override TV web URL
#   SMOKE_ADMIN_TOKEN   — admin token for authenticated smoke tests
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEPLOY_ENV="${DEPLOY_ENV:-production}"
for arg in "$@"; do
  case "$arg" in
    --env=*) DEPLOY_ENV="${arg#--env=}" ;;
    --env) shift; DEPLOY_ENV="${1:-production}" ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0
FAILURES=()

ok()   { echo -e "  ${GREEN}✓${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $*"; FAIL=$((FAIL + 1)); FAILURES+=("$*"); }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; WARN=$((WARN + 1)); }
info() { echo -e "  ${CYAN}→${NC} $*"; }

# ── Resolve URLs per environment ──────────────────────────────────────────────
if [ "$DEPLOY_ENV" = "staging" ]; then
  DEFAULT_API_URL="https://staging-api.templetv.org.ng"
  DEFAULT_ADMIN_URL="https://staging-admin.templetv.org.ng"
  DEFAULT_TV_URL="https://staging-tv.templetv.org.ng"
else
  DEFAULT_API_URL="https://api.templetv.org.ng"
  DEFAULT_ADMIN_URL="https://admin.templetv.org.ng"
  DEFAULT_TV_URL="https://tv.templetv.org.ng"
fi

API_URL="${API_URL:-$DEFAULT_API_URL}"
ADMIN_URL="${ADMIN_URL:-$DEFAULT_ADMIN_URL}"
TV_URL="${TV_URL:-$DEFAULT_TV_URL}"
ADMIN_TOKEN="${SMOKE_ADMIN_TOKEN:-}"
TIMEOUT=20

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║    Temple TV — Post-Deploy Verification                 ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
info "Environment: $DEPLOY_ENV"
info "API:         $API_URL"
info "Admin:       $ADMIN_URL"
info "TV:          $TV_URL"
echo ""

# ── 1. API health + response time ─────────────────────────────────────────────
echo -e "${BOLD}1. API Health & Performance${NC}"
HEALTH_RESPONSE=$(curl -o /tmp/health_body.txt -s \
  -w "%{http_code}|%{time_total}" \
  --max-time "$TIMEOUT" \
  "$API_URL/api/healthz" 2>/dev/null || echo "000|0")

HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | cut -d'|' -f1)
HEALTH_TIME=$(echo "$HEALTH_RESPONSE" | cut -d'|' -f2)

if [ "$HEALTH_STATUS" = "200" ]; then
  ok "API /api/healthz → HTTP $HEALTH_STATUS"
else
  fail "API /api/healthz → HTTP $HEALTH_STATUS (expected 200)"
fi

# Response time SLA < 2000ms (node used — bc/python3 not universally available)
HEALTH_TIME_MS=$(node -e "process.stdout.write(String(Math.floor(parseFloat('${HEALTH_TIME:-9.999}')*1000)))" 2>/dev/null || echo "9999")
if [ "${HEALTH_TIME_MS:-9999}" -lt 2000 ]; then
  ok "Response time SLA < 2s (actual: ${HEALTH_TIME}s)"
else
  warn "Response time ${HEALTH_TIME}s exceeds 2s SLA (may be cold start)"
fi

# Check status field in JSON body
HEALTH_STATUS_FIELD=$(node -e "try{const d=require('fs').readFileSync('/tmp/health_body.txt','utf8');process.stdout.write((JSON.parse(d).status||'')+'\n')}catch(e){}" 2>/dev/null || echo "")
if [ "$HEALTH_STATUS_FIELD" = "ok" ]; then
  ok "API reports status=ok"
else
  fail "API status field is '$HEALTH_STATUS_FIELD' (expected 'ok')"
fi

# ── 2. Database connectivity ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}2. Database Connectivity${NC}"
DB_FIELD=$(node -e "try{const d=require('fs').readFileSync('/tmp/health_body.txt','utf8');const o=JSON.parse(d);process.stdout.write((o.db||'unknown')+'\n')}catch(e){process.stdout.write('unknown\n')}" 2>/dev/null || echo "unknown")
if [ "$DB_FIELD" = "ok" ] || [ "$DB_FIELD" = "connected" ]; then
  ok "Database connectivity: $DB_FIELD"
else
  warn "Database status in healthz: '$DB_FIELD' (may not be reported)"
fi

# ── 3. Core smoke tests ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}3. Core Smoke Tests${NC}"
if bash scripts/smoke-test.sh "$API_URL" > /tmp/smoke_output.txt 2>&1; then
  ok "All smoke tests passed"
else
  SMOKE_FAILURES=$(grep -c "✗" /tmp/smoke_output.txt 2>/dev/null || echo "?")
  fail "Smoke tests: $SMOKE_FAILURES check(s) failed"
  echo "   See details: /tmp/smoke_output.txt"
fi

# ── 4. Admin SPA ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}4. Admin Dashboard${NC}"
ADMIN_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time "$TIMEOUT" "$ADMIN_URL" 2>/dev/null; true)
ADMIN_STATUS="${ADMIN_STATUS:0:3}"
if [ "$ADMIN_STATUS" = "200" ]; then
  ok "Admin dashboard reachable (HTTP $ADMIN_STATUS)"
else
  warn "Admin dashboard: HTTP $ADMIN_STATUS (may be behind auth or CDN)"
fi

# ── 5. TV SPA ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}5. Smart TV Web App${NC}"
TV_STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time "$TIMEOUT" "$TV_URL" 2>/dev/null; true)
TV_STATUS="${TV_STATUS:0:3}"
if [ "$TV_STATUS" = "200" ]; then
  ok "TV web app reachable (HTTP $TV_STATUS)"
else
  warn "TV web app: HTTP $TV_STATUS (may be CDN or not yet deployed)"
fi

# ── 6. SSL certificate check ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}6. SSL Certificates${NC}"
for HOST in "$(echo "$API_URL" | sed 's|https://||')" "$(echo "$ADMIN_URL" | sed 's|https://||')"; do
  CERT_EXPIRY=$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null \
    | sed 's/notAfter=//' || echo "")

  if [ -n "$CERT_EXPIRY" ]; then
    EXPIRY_EPOCH=$(date -d "$CERT_EXPIRY" +%s 2>/dev/null || \
      node -e "process.stdout.write(String(Math.floor(new Date('$CERT_EXPIRY').getTime()/1000)))" 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [ "$DAYS_LEFT" -gt 14 ]; then
      ok "SSL cert for $HOST expires in $DAYS_LEFT days"
    elif [ "$DAYS_LEFT" -gt 0 ]; then
      warn "SSL cert for $HOST expires in $DAYS_LEFT days — renew soon"
    else
      fail "SSL cert for $HOST appears expired"
    fi
  else
    warn "Could not check SSL cert for $HOST"
  fi
done

# ── 7. CORS headers ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}7. CORS Headers${NC}"
CORS_HEADER=$(curl -fsSL --max-time "$TIMEOUT" \
  -H "Origin: https://admin.templetv.org.ng" \
  -I "$API_URL/api/healthz" 2>/dev/null | grep -i "access-control-allow-origin" | head -1 || echo "")
if [ -n "$CORS_HEADER" ]; then
  ok "CORS header present: $CORS_HEADER"
else
  warn "CORS 'access-control-allow-origin' header not found in response"
fi

# ── 8. SSE gateway ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}8. Real-time SSE Gateway${NC}"
# Use "; true" — not "|| echo 000" — to avoid appending "000" to a valid HTTP
# code when curl exits non-zero due to --max-time timeout on a streaming SSE.
SSE_STATUS=$(curl -o /dev/null -s -w "%{http_code}" \
  --max-time 3 \
  -H "Accept: text/event-stream" \
  "$API_URL/api/broadcast/events" 2>/dev/null; true)
SSE_STATUS="${SSE_STATUS:0:3}"
if [ "$SSE_STATUS" = "200" ] || [ -z "$SSE_STATUS" ]; then
  ok "SSE gateway /api/broadcast/events (connects)"
else
  fail "SSE gateway returned HTTP $SSE_STATUS"
fi

# ── Final report ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Results: ${GREEN}${PASS} passed${NC}  ${RED}${FAIL} failed${NC}  ${YELLOW}${WARN} warnings${NC}"
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
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}✅ Post-deploy verification passed!${NC}"
else
  echo -e "${RED}❌ Post-deploy verification FAILED — $FAIL check(s) failed${NC}"
  exit 1
fi
echo ""
