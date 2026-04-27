#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
pnpm --filter @workspace/scripts run backfill-legacy-video-urls

# Cross-platform consistency gate: confirm the OpenAPI spec, generated Zod
# schemas, generated React Query client, and every workspace's TypeScript all
# agree. Any drift between server contract and frontends fails fast here so it
# never reaches production.
pnpm run verify
