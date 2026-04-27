#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
pnpm --filter @workspace/scripts run backfill-legacy-video-urls

# Activate the versioned pre-commit hook in scripts/git-hooks/. Doing this in
# post-merge guarantees every fresh clone or merged-in environment picks up
# the local verify gate automatically on first merge — no manual setup step
# required, and no risk of a developer forgetting to enable it. Idempotent:
# running this multiple times is a no-op.
git config core.hooksPath scripts/git-hooks

# Cross-platform consistency gate: confirm the OpenAPI spec, generated Zod
# schemas, generated React Query client, and every workspace's TypeScript all
# agree. Any drift between server contract and frontends fails fast here so it
# never reaches production.
pnpm run verify
