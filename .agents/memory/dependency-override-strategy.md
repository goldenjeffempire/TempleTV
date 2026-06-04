---
name: pnpm security override strategy
description: How to safely apply pnpm.overrides for transitive security advisories in this multi-major monorepo
---

# pnpm security-override strategy

The root `package.json` `pnpm.overrides` block is the deliberate, maintained home
for security remediation of transitive dependencies. Many advisories are already
neutralized there (brace-expansion, esbuild, vite, postcss, yaml, path-to-regexp,
picomatch, lodash, xmldom).

## Rule: use version-pinned overrides for multi-major packages
When a flagged package has **multiple majors installed** in the tree, use a
version-pinned override (`"pkg@x.y.z": "patched"`), NOT a global `"pkg": ">=…"`.

**Why:** `ws` ships 3 majors simultaneously here (6.2.3 / 7.5.10 / 8.20.0). A global
`"ws": ">=8.20.1"` would force the v6/v7 consumers up to v8 and break them. The
version-pinned form `"ws@8.20.0": "8.20.1"` surgically bumps only the vulnerable
copy and leaves the other majors intact (lockfile confirms this).

**How to apply:** check installed versions first with
`find node_modules/.pnpm -maxdepth 1 -name "<pkg>@*" -type d`. Single-version
packages can use either form; multi-major ones must be version-pinned. Reinstall
with `pnpm install --ignore-scripts`, then re-run `runDependencyAudit()` to confirm
the count dropped, and re-run the api-server + player-core vitest suites.

## Audit false-positive gotchas
- `runDependencyAudit()` may flag a version that is **outside the advisory's actual
  affected range** (e.g. brace-expansion@5.0.5 flagged under an advisory whose range
  tops out lower). Verify the real installed version and the advisory bounds before
  acting — don't blindly override.
- Major-bump-only advisories (uuid 3/7/9 → 11, vitest 3 → 4, OpenTelemetry minor
  bumps that change instrumentation APIs at boot) are intentionally deferred: they
  carry behavior/breakage risk and need deliberate, separately-tested upgrades, not
  audit-time auto-fixes.

## SAST false positives confirmed in this repo (don't re-flag)
- `middleware/csrf.ts` custom `x-admin-csrf: 1` header check is a correct
  double-submit CSRF guard (un-forgeable cross-origin); Bearer auth skip is correct.
- `lib/player-core/src/transport.ts` (+ mobile/tv) `ws://` derives from baseUrl
  (`https→wss`, `http→ws` for local dev only) — not unconditional insecure transport.
- `admin.service.ts` `sql.raw` interval interpolation is allow-list guarded
  (safeRangeDays / safeGran).
