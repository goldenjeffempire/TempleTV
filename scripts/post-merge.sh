#!/bin/bash
set -e

# Install dependencies for all workspaces except mobile.
#
# Mobile (@workspace/mobile) is excluded because Replit's package firewall
# blocks shell-quote@1.8.3 (transitive: react-native → react-devtools-core).
# The mobile workspace cannot be previewed in the browser anyway and EAS builds
# use a separate install step with --config.registry=https://registry.npmjs.org
# to bypass the firewall (see .agents/memory/eas-pnpm-symlink-workaround.md).
#
# On Render the build runs render-install.sh directly from render.yaml (not
# from this post-merge script), so skipping mobile here has no production impact.
pnpm install --ignore-scripts --filter !@workspace/mobile

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
