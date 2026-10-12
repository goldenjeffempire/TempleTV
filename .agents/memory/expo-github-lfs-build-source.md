---
name: Expo GitHub builds and generated bundles
description: Generated Android bundles in Git LFS can block source checkout before Expo installs dependencies.
---

Keep generated Android bundles outside tracked release source. An ignore rule
does not remove a bundle already tracked by Git.

**Why:** An Expo GitHub build failed during project preparation because checkout
tried to download an old AAB from Git LFS after the repository exceeded its LFS
budget. App compilation and signing had not started. EAS archive exclusions do
not protect the earlier GitHub clone step.

**How to apply:** Inspect the failed phase and full logs before changing app
dependencies, SDK versions, or credentials. For unused generated outputs,
preserve the local copy and history, remove tracking on the release branch, and
add an ignore rule. Verify a fresh checkout of the exact GitHub release source
without skipping LFS filters before retrying. Do not rewrite repository history
or delete LFS storage to fix this checkout failure.
