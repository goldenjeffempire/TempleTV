#!/bin/bash
set -e

# Use the same install wrapper Render uses (scripts/render-install.sh) so a
# locally-merged task agent branch picks up the same node_modules-pruning
# hygiene as a production deploy. Without this, a merge that includes a
# catalog bump or pnpm.overrides change can leave orphan packages in
# node_modules/.pnpm/ from the pre-merge resolved layout — which then trips
# the `verify:react-types-singleton` (and other future) guardrails during
# the `pnpm run verify` step below, surfacing as a confusing "guardrail
# fails locally even though origin/main passed CI" experience. The wrapper
# wipes node_modules and reinstalls from the (preserved) pnpm store —
# typically ~25-45s on a warm store, the same speed as the previous
# `pnpm install --frozen-lockfile` line. See scripts/render-install.sh for
# the full failure-mode history.
bash ./scripts/render-install.sh

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
