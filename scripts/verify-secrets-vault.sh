#!/usr/bin/env bash
# =============================================================================
# Temple TV — GitHub Actions Secrets Vault Verification
# =============================================================================
#
# Checks that all required GitHub Actions secrets are set in the repository.
# Requires the GitHub CLI (gh) to be authenticated.
#
# Usage:
#   bash scripts/verify-secrets-vault.sh [--repo owner/repo]
#
# Prerequisites:
#   gh auth login   (or GITHUB_TOKEN env var)
#
# Exit codes:
#   0  — all required secrets are present
#   1  — one or more required secrets are missing
# =============================================================================

set -euo pipefail

REPO_ARG=""
for arg in "$@"; do
  case "$arg" in
    --repo=*) REPO_ARG="${arg#--repo=}" ;;
    --repo) shift; REPO_ARG="$1" ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
miss() { echo -e "  ${RED}✗${NC} $* ${RED}(MISSING)${NC}"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $* ${YELLOW}(optional but recommended)${NC}"; }
info() { echo -e "  ${CYAN}→${NC} $*"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║    Temple TV — Secrets Vault Verification               ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Detect repo ───────────────────────────────────────────────────────────────
if [ -z "$REPO_ARG" ]; then
  REPO_ARG=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || echo "")
  if [ -z "$REPO_ARG" ]; then
    echo -e "${RED}Could not detect repo. Run from inside the repo or use --repo owner/name${NC}"
    exit 1
  fi
fi
info "Repository: $REPO_ARG"
echo ""

# ── Fetch all set secret names ────────────────────────────────────────────────
SECRETS_LIST=$(gh secret list --repo "$REPO_ARG" --json name -q '.[].name' 2>/dev/null || echo "")
if [ -z "$SECRETS_LIST" ]; then
  echo -e "${RED}Could not fetch secrets. Ensure you have 'gh auth login' and admin access.${NC}"
  exit 1
fi

has_secret() {
  echo "$SECRETS_LIST" | grep -q "^$1$"
}

MISSING=0
OPTIONAL_MISSING=0

check_required() {
  local name="$1"
  local desc="$2"
  if has_secret "$name"; then
    ok "$name — $desc"
  else
    miss "$name — $desc"
    ((MISSING++))
  fi
}

check_optional() {
  local name="$1"
  local desc="$2"
  if has_secret "$name"; then
    ok "$name — $desc"
  else
    warn "$name — $desc"
    ((OPTIONAL_MISSING++))
  fi
}

# ── Required: Core API ────────────────────────────────────────────────────────
echo -e "${BOLD}Core API (required)${NC}"
check_required "JWT_ACCESS_SECRET"   "HMAC secret for JWT access tokens (≥32 chars)"
check_required "JWT_REFRESH_SECRET"  "HMAC secret for JWT refresh tokens (≥32 chars)"
check_required "ADMIN_API_TOKEN"     "Long-lived admin API key"
check_required "DATABASE_URL"        "PostgreSQL connection string"

# ── Required: Email ───────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}SMTP / Email (required)${NC}"
check_required "SMTP_PASS"   "SMTP account password for notification delivery"

# ── Required: Render deployment ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}Render Deployment (required)${NC}"
check_required "RENDER_API_KEY"              "Render API key for deploy triggers"
check_required "RENDER_SERVICE_ID_API"       "Render service ID for the API service"
check_required "RENDER_STAGING_DEPLOY_HOOK_URL" "Render deploy hook URL for staging"

# ── Required: AWS ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}AWS S3 + CloudFront (required for TV CDN deploy)${NC}"
check_required "AWS_ACCESS_KEY_ID"        "AWS access key ID"
check_required "AWS_SECRET_ACCESS_KEY"    "AWS secret access key"
check_required "S3_BUCKET_TV"             "S3 bucket for TV web assets"
check_required "CLOUDFRONT_TV_DISTRIBUTION_ID" "CloudFront distribution for TV CDN"

# ── Required: Expo / EAS ──────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Expo EAS Mobile Builds (required)${NC}"
check_required "EXPO_TOKEN"  "Expo access token for EAS builds"

# ── Required: Docker / GHCR ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Docker / GHCR (required for docker-publish.yml)${NC}"
check_required "GHCR_TOKEN"  "GitHub Container Registry PAT (write:packages scope)"

# ── Optional: Sentry ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Sentry Error Tracking (optional)${NC}"
check_optional "SENTRY_DSN"        "Sentry DSN for error ingestion"
check_optional "SENTRY_AUTH_TOKEN" "Sentry auth token for source map upload"
check_optional "SENTRY_ORG"        "Sentry org slug"

# ── Optional: Push notifications ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}Push Notifications (optional)${NC}"
check_optional "VAPID_PUBLIC_KEY"  "VAPID public key for Web Push"
check_optional "VAPID_PRIVATE_KEY" "VAPID private key for Web Push"

# ── Optional: iOS / Fastlane ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}iOS / Fastlane (optional — needed for native Fastlane lane)${NC}"
check_optional "APPLE_ID"          "Apple Developer account email"
check_optional "APPLE_TEAM_ID"     "Apple Developer Portal Team ID"
check_optional "MATCH_GIT_URL"     "Git repo URL for Fastlane Match certificates"
check_optional "MATCH_PASSWORD"    "Fastlane Match encryption password"
check_optional "APP_STORE_CONNECT_KEY_ID"     "App Store Connect API key ID"
check_optional "APP_STORE_CONNECT_ISSUER_ID"  "App Store Connect API issuer ID"
check_optional "APP_STORE_CONNECT_KEY_CONTENT" "App Store Connect API private key (.p8)"

# ── Optional: Android / Play Store ───────────────────────────────────────────
echo ""
echo -e "${BOLD}Android / Play Store (optional — needed for Fastlane Play Store upload)${NC}"
check_optional "KEYSTORE_BASE64"      "Base64-encoded Android release keystore (.jks)"
check_optional "KEYSTORE_PASSWORD"    "Android keystore store password"
check_optional "KEY_ALIAS"            "Android keystore key alias"
check_optional "KEY_PASSWORD"         "Android keystore key password"
check_optional "PLAY_STORE_JSON_KEY"  "Google Play Store service account JSON key"

# ── Optional: Firebase ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Firebase App Distribution (optional)${NC}"
check_optional "FIREBASE_ANDROID_APP_ID"      "Firebase Android app ID"
check_optional "FIREBASE_SERVICE_ACCOUNT_JSON" "Firebase service account JSON"
check_optional "FIREBASE_TESTERS_GROUP"        "Firebase testers group name"

# ── Optional: Staging environment ────────────────────────────────────────────
echo ""
echo -e "${BOLD}Staging Environment (optional)${NC}"
check_optional "STAGING_API_URL"           "Staging API base URL"
check_optional "STAGING_ADMIN_API_TOKEN"   "Staging admin API token for smoke tests"

# ── Optional: Notifications / Integrations ────────────────────────────────────
echo ""
echo -e "${BOLD}Integrations (optional)${NC}"
check_optional "SLACK_WEBHOOK_URL"   "Slack webhook for CI notifications"
check_optional "YOUTUBE_API_KEY"     "YouTube Data API v3 key for video sync"
check_optional "TURBO_TOKEN"         "Turborepo remote cache token"
check_optional "TURBO_TEAM"          "Turborepo team slug"
check_optional "GITLEAKS_LICENSE"    "Gitleaks commercial license (for private repos)"

# ── Final report ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
if [ "$MISSING" -eq 0 ]; then
  echo -e "${GREEN}✅ All required secrets are set.${NC}"
else
  echo -e "${RED}❌ $MISSING required secret(s) are missing.${NC}"
fi
if [ "$OPTIONAL_MISSING" -gt 0 ]; then
  echo -e "${YELLOW}⚠  $OPTIONAL_MISSING optional secret(s) not set (features that depend on them will be disabled).${NC}"
fi
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo ""

if [ "$MISSING" -gt 0 ]; then
  echo -e "To set a missing secret:"
  echo -e "  ${CYAN}gh secret set SECRET_NAME --repo $REPO_ARG${NC}"
  echo -e "  ${CYAN}bash scripts/github-secrets-setup.sh${NC}  (interactive setup)"
  echo ""
  exit 1
fi
