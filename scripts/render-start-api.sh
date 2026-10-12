#!/usr/bin/env bash
set -euo pipefail

# Render free-tier services do not support preDeployCommand. Run the
# idempotent schema push immediately before starting the API instead, while
# runtime environment variables such as DATABASE_URL are available.
echo "==> [render-start-api] Applying database schema"
pnpm --filter @workspace/db run push-force

echo "==> [render-start-api] Starting API"
# Keep the API's existing package-script working directory and Node flags,
# without retaining pnpm's Node process alongside the API on a 512 MB host.
cd artifacts/api-server
exec node --max-old-space-size=256 --max-http-header-size=16384 \
  --expose-gc --enable-source-maps \
  --import ./dist/instrument.mjs ./dist/index.mjs