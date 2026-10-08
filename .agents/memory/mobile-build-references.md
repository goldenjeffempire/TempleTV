---
name: Mobile build references
description: Index of historical Android signing, package-lock, and native build constraints.
---

Consult current mobile/package-management skills for permitted tooling; these
references preserve historical failure lessons, not authorization to run old
release commands.

**Why:** Mobile build lessons are closely related and were crowding the
always-loaded memory index.

**How to apply:** Open the relevant reference when investigating signing,
clean-build behavior, patch synchronization, or native build compatibility.

- [Signing key format](eas-local-credentials-jks-required.md)
- [Play upload key source](android-play-upload-key-source.md)
- [Peer-hash hoisting conflicts](eas-pnpm-hoist-conflict.md)
- [Patch and lockfile synchronization](pnpm-patch-lockfile-sync.md)
- [Clean-store patch validation](stale-patch-eas-failure.md)
- [Gradle configuration-cache incompatibility](gradle-config-cache-incompatibility.md)
- [Archive/git-index environment constraints](eas-replit-git-index-workaround.md)
- [Build memory limits](eas-build-oom.md)
- [Workspace override drift](eas-workspace-overrides-lockfile-mismatch.md)
- [Build runtime version pins](eas-node-pnpm-version-pins.md)
- [Local native module build constraints](expo-local-module-android-build.md)
- [Archive cache-directory exclusion](eas-build-dotslash-cache-tarball.md)
- [Workspace dependencies after merge](pnpm-overrides-workspacedep-merge-drift.md)
- [Local Gradle toolchain and signing](android-local-gradle-build.md)
- [GitHub checkout blocked by generated AABs in LFS](expo-github-lfs-build-source.md)
