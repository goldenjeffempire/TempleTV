#!/usr/bin/env bash
# =============================================================================
# Temple TV — Seed Production Admin Credentials
# =============================================================================
#
# Seeds (or force-re-seeds) the admin account in a production API instance.
# Safe to run multiple times — uses force=true which wipes and recreates the
# admin account from the provided credentials.
#
# Usage:
#   bash scripts/seed-production.sh [API_URL] [EMAIL] [PASSWORD]
#
# Arguments (all optional — fall back to env vars or defaults):
#   API_URL   Base URL of the deployed API  (default: $API_URL or https://api.templetv.org.ng)
#   EMAIL     Admin email to seed           (default: $SEED_ADMIN_EMAIL or admin@templetv.org.ng)
#   PASSWORD  Admin password to seed        (default: $SEED_ADMIN_PASSWORD — REQUIRED)
#
# Required env vars if not passed as arguments:
#   SEED_ADMIN_PASSWORD  — admin password (min 8 chars)
#
# Optional env vars:
#   ADMIN_API_TOKEN      — long-lived API token for authenticating the seed call
#                          (used as Bearer token; must match the server's ADMIN_API_TOKEN)
#   API_URL              — base URL of the deployed API
#   SEED_ADMIN_EMAIL     — admin email address
#
# Examples:
#   # Using env vars:
#   SEED_ADMIN_PASSWORD=MySecret123 bash scripts/seed-production.sh
#
#   # Inline:
#   bash scripts/seed-production.sh https://api.templetv.org.ng admin@templetv.org.ng MySecret123
#
#   # With admin token for auth:
#   ADMIN_API_TOKEN=xxx bash scripts/seed-production.sh
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}  →${NC} $*"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $*"; }
die()   { echo -e "${RED}  ✗${NC} $*" >&2; exit 1; }

# ── Resolve arguments ─────────────────────────────────────────────────────────
API_URL="${1:-${API_URL:-https://api.templetv.org.ng}}"
ADMIN_EMAIL="${2:-${SEED_ADMIN_EMAIL:-admin@templetv.org.ng}}"
ADMIN_PASSWORD="${3:-${SEED_ADMIN_PASSWORD:-}}"
TOKEN="${ADMIN_API_TOKEN:-}"

[ -z "$ADMIN_PASSWORD" ] && die "SEED_ADMIN_PASSWORD is required. Pass it as the 3rd arg or set the env var."

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║      Temple TV — Seed Production Admin Account           ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
info "API URL:     $API_URL"
info "Admin email: $ADMIN_EMAIL"
info "Force mode:  true (will wipe and recreate elevated accounts)"
echo ""

# ── Health check first ────────────────────────────────────────────────────────
info "Checking API health..."
for i in $(seq 1 12); do
  HTTP_STATUS=$(curl -o /dev/null -s -w "%{http_code}" "$API_URL/api/healthz" 2>/dev/null || echo "000")
  if [ "$HTTP_STATUS" = "200" ]; then
    ok "API is healthy"
    break
  fi
  if [ "$i" -eq 12 ]; then
    die "API health check failed after 2 minutes (last status: $HTTP_STATUS). Is the API deployed?"
  fi
  warn "API not ready yet (HTTP $HTTP_STATUS) — waiting 10s... ($i/12)"
  sleep 10
done

# ── Build request ─────────────────────────────────────────────────────────────
SEED_PAYLOAD=$(cat <<EOF
{
  "email": "$ADMIN_EMAIL",
  "password": "$ADMIN_PASSWORD",
  "name": "Temple TV Admin",
  "role": "system",
  "force": true
}
EOF
)

CURL_ARGS=(-s -w "\n%{http_code}" -X POST "$API_URL/api/auth/seed" \
  -H "Content-Type: application/json" \
  -d "$SEED_PAYLOAD")

if [ -n "$TOKEN" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer $TOKEN")
fi

# ── Execute seed ──────────────────────────────────────────────────────────────
info "Seeding admin account..."
RESPONSE=$(curl "${CURL_ARGS[@]}" 2>&1)
HTTP_STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "201" ]; then
  ok "Admin account seeded successfully"
  echo ""
  echo "  Email:    $ADMIN_EMAIL"
  echo "  Password: [as provided]"
  echo ""
  echo "  Login at: $(echo "$API_URL" | sed 's/api\./admin./')/login"
  echo "         or: https://admin.templetv.org.ng/login"
  echo ""
elif [ "$HTTP_STATUS" = "401" ] || [ "$HTTP_STATUS" = "403" ]; then
  die "Authentication failed (HTTP $HTTP_STATUS). Set ADMIN_API_TOKEN to the server's API token.
  Response: $BODY"
elif [ "$HTTP_STATUS" = "404" ]; then
  die "Seed endpoint not found (HTTP 404). Is the API server running the latest version?
  URL tried: $API_URL/api/auth/seed"
else
  die "Seed failed (HTTP $HTTP_STATUS).
  Response: $BODY"
fi
