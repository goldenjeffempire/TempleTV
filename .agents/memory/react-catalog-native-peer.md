---
name: React catalog version pin for react-native peer
description: Why mobile's react/react-dom must not just be swapped to "catalog:" without also checking the catalog's pinned version against react-native's peer range.
---

`artifacts/mobile/package.json` had `react`/`react-dom` hardcoded to `19.2.3` instead of the monorepo's `"catalog:"` token, which failed `verify:catalog-callsites` and blocked Render production builds. The literal-version pin wasn't arbitrary: `pnpm-workspace.yaml`'s catalog had `react`/`react-dom` at `19.2.0`, but `react-native@0.86.0` declares a peer dependency on `react@^19.2.3` — so simply switching mobile's package.json to `"catalog:"` at the old catalog version reintroduces an unmet-peer warning (and a real react/react-dom mismatch risk for the mobile bundle).

**Why:** catalog-callsites verification only checks that consumers reference the literal `"catalog:"` token, not that the catalog's pinned version satisfies every consumer's real constraints; react-native's peer range is stricter than the rest of the monorepo needs.

**How to apply:** when a workspace package hardcodes a catalog-managed dependency to a specific version instead of `"catalog:"`, don't just swap the token in — first check why the hardcode exists (usually a peer-dependency constraint from that package specifically) and bump the catalog's pinned version to satisfy it, then swap to `"catalog:"` and rerun `pnpm install` to confirm the peer warning clears and `verify:catalog`/`verify:catalog-callsites` both pass.
