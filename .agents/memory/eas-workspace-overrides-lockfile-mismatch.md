---
name: EAS frozen-lockfile failure from pnpm-workspace.yaml overrides mismatch
description: pnpm-workspace.yaml overrides section being out of sync with pnpm-lock.yaml causes instant "Unknown error" in EAS Install dependencies phase.
---

## Rule

Never add an `overrides` section to `pnpm-workspace.yaml` without immediately running `pnpm install` to regenerate `pnpm-lock.yaml`. The lockfile's `overrides:` block must exactly match the effective overrides (merged from `package.json#pnpm.overrides` + `pnpm-workspace.yaml#overrides`). Any mismatch causes `pnpm install --frozen-lockfile` to fail immediately.

**Symptom**: EAS build ERRORED with `UNKNOWN_ERROR` in "Install dependencies" phase, build duration ~16 seconds (no real work done), no readable error in the log.

**Root cause found (June 2026)**: An `overrides` section with 81 entries (platform binary exclusions for esbuild/rollup/lightningcss/@tailwindcss/oxide/@expo/ngrok-bin, plus `esbuild: 0.27.3` pin and `@esbuild-kit/esm-loader` alias) was added to `pnpm-workspace.yaml` without regenerating the lockfile. The lockfile only reflected `package.json`'s 17-entry overrides (`esbuild: '>=0.25.0'`). pnpm v10 detected the mismatch and failed `--frozen-lockfile` before downloading a single package.

**Fix applied**: Removed the entire `overrides` section from `pnpm-workspace.yaml`. The lockfile was already consistent with `package.json` overrides alone. The platform binary packages that were being excluded are already present in the lockfile; pnpm's OS/CPU filtering handles skipping inapplicable native binaries without explicit exclusions.

**Why:** `pnpm install` OOMs on Replit (see eas-build-oom.md), so we edit the lockfile directly for small changes. For large changes like an entire new `overrides` section this is impractical — the right fix is to not add workspace.yaml overrides that can't be synced to the lockfile.

**How to apply:**
- Keep all pnpm overrides in `package.json#pnpm.overrides` only — do NOT use `pnpm-workspace.yaml#overrides`.
- If you must add platform binary exclusions, do it in `package.json` and run `pnpm install` (NOT on Replit — do it on a machine with >4 GB RAM).
- The `onlyBuiltDependencies` key in workspace.yaml is safe (it is not recorded in the lockfile).
- Diagnostic: build duration < 30 s + `UNKNOWN_ERROR` in Install phase = almost certainly a lockfile mismatch.
