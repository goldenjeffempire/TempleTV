#!/usr/bin/env bash
set -euo pipefail

# Render free-tier services do not support preDeployCommand. Run the
# idempotent schema push immediately before starting the API instead, while
# runtime environment variables such as DATABASE_URL are available.
echo "==> [render-start-api] Applying database schema"
pnpm --filter @workspace/db run push-force

echo "==> [render-start-api] Starting API"
exec pnpm --filter @workspace/api-server run start:render-free