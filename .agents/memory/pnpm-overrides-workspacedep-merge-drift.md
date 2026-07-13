---
name: pnpm overrides / workspace-dep drift after a git merge
description: A git merge/rebase can silently revert package.json's pnpm.overrides or a local workspace:* dep back to an older form while pnpm-lock.yaml keeps the newer form (or vice versa) — causes ERR_PNPM_LOCKFILE_CONFIG_MISMATCH or ERR_PNPM_OUTDATED_LOCKFILE only on frozen-lockfile installs (e.g. EAS Build, CI), not on local `pnpm install`.
---

Two real incidents, same root cause: a merge commit resolved package.json and pnpm-lock.yaml from different parent branches, so a fix that touched both files ended up only partially applied.

1. Root `package.json`'s `pnpm.overrides` map lost several security-patch entries (ws/uuid/js-yaml/@babel-core pins) that were still present in `pnpm-lock.yaml`'s `overrides:` block → `pnpm install --frozen-lockfile` fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
2. `artifacts/mobile/package.json` reverted two local module deps from `workspace:*` back to `file:./modules/...`, and `pnpm-workspace.yaml` lost the `artifacts/mobile/modules/*` packages entry — lockfile still expected `workspace:*` → `ERR_PNPM_OUTDATED_LOCKFILE`.

**Why:** `pnpm install` (no `--frozen-lockfile`) silently "fixes" both by rewriting the lockfile to match whatever package.json says, so the drift is invisible in local dev. EAS Build and most CI always run `pnpm install --frozen-lockfile`, which fails loudly instead — the error only surfaces at build time, far from the merge that caused it.

**How to apply:** After any `git pull`/merge/rebase touching `package.json`, `pnpm-workspace.yaml`, or `pnpm-lock.yaml`, run `pnpm install --frozen-lockfile` locally before trusting the tree — it reproduces the exact failure EAS/CI will hit, cheaply and fast. Don't just eyeball `git status`; the overrides/workspace-dep block is easy to miss in a diff.
