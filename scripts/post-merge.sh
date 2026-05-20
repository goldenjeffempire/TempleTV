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
# Best-effort: Replit's sandbox blocks direct `git config` writes from the
# post-merge script. The hooks are only needed on developer machines / CI.
git config core.hooksPath scripts/git-hooks 2>/dev/null || true

# Cross-platform consistency gate: confirm the OpenAPI spec, generated Zod
# schemas, generated React Query client, and every workspace's TypeScript all
# agree. Any drift between server contract and frontends fails fast here so it
# never reaches production.
#
# Typecheck (tsc --build) is skipped on Replit: the Replit free-tier sandbox
# has ~512 MB heap and tsc --build across the full monorepo reliably OOMs
# (same reason render.yaml uses verify:render instead of verify). All other
# guardrails (codegen drift, catalog sync, react-types-singleton, etc.) still
# run. Typecheck runs in CI (GitHub Actions, which has a full 7 GB heap).
if [ "${RENDER:-false}" = "true" ]; then
  pnpm run verify
else
  # Run every verify gate except the memory-intensive typecheck step.
  pnpm run verify:codegen
  pnpm run verify:catalog
  pnpm run verify:catalog-callsites
  pnpm run verify:recharts-shim
  pnpm run verify:react-types-singleton
  pnpm run verify:tsconfig-parity
  pnpm run verify:render-yaml
  pnpm run verify:env-secrets
  pnpm run verify:db-schema-completeness
  pnpm run verify:mobile-lockfile
  pnpm run verify:platform-consistency
  pnpm run verify:metro-paths
  echo "==> [post-merge] verify guardrails passed (typecheck skipped — run 'pnpm run typecheck' manually or let CI handle it)"
fi
