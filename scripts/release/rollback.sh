#!/usr/bin/env bash
set -euo pipefail

: "${RENDER_ROLLBACK_HOOK_URL:?RENDER_ROLLBACK_HOOK_URL must be set}"

echo "Triggering rollback via Render hook..."
curl -fsSL -X POST "$RENDER_ROLLBACK_HOOK_URL"
echo "Rollback hook triggered successfully."
