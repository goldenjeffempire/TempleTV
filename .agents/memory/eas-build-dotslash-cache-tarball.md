---
name: EAS build tarball packing breaks on dotslash .cache dir
description: Local `eas build` fails with EACCES on rmdir during "Compressing project files" because a project-root .cache/dotslash/ dir (downloaded RN DevTools binary) has read-only files that EAS's shallow-clone staging can't clean up.
---

Running `expo`/`react-native` dev tooling locally creates `<repo-root>/.cache/dotslash/.../React Native DevTools-linux-x64/` with several files at mode 444/555/500 (not writable). When `eas build` (local CLI, credentialsSource local) packs the project tarball, it copies this into its own `/tmp/.../<uuid>-shallow-clone/.cache/...` staging dir and then fails to `rmdir` it during cleanup, aborting the upload with:

```
Failed to upload the project tarball to EAS Build
Reason: EACCES: permission denied, rmdir '.../.cache/dotslash/.../React Native DevTools-linux-x64'
```

**Why:** `.gitignore` already excludes `.cache/`, but `.easignore` did not — EAS's local packer walks the filesystem independent of git ignore rules, so it must have its own exclusion.

**How to apply:** Add `.cache/` to the app's `.easignore` (not just `.gitignore`). If a build already failed this way, also `chmod -R u+rwx .cache && rm -rf .cache` (and clear stale `/tmp/*/eas-cli-nodejs/*-shallow-clone` dirs) before retrying — the read-only files block cleanup on every retry until removed.
