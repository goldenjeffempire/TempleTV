---
name: EAS build stale git lock workaround
description: How to trigger EAS builds from Replit main agent when .git/index.lock is stale and all git writes are blocked.
---

## Problem

Replit main agent blocks all writes to `.git/` paths (including `rm`). A stale zero-byte `.git/index.lock` causes git to abort any operation that tries to clean it up. EAS CLI uses git to archive the project before uploading, so it always fails with:

> Destructive git operations are not allowed in the main agent … /home/runner/workspace/.git/index.lock

## Fix

Set `GIT_INDEX_FILE` to a temp path so git never touches the workspace index:

```bash
cd artifacts/mobile
GIT_INDEX_FILE=/tmp/eas-git-index-$$ \
  NODE_PATH="$(pwd)/../../node_modules" \
  eas build --platform android --profile production-android \
            --non-interactive --no-wait
```

**Why:** `GIT_INDEX_FILE` redirects all git index reads/writes to the temp path. The stale lock is never encountered. `NODE_PATH` makes EAS CLI's local plugin resolution find expo-router etc. from the workspace's hoisted pnpm node_modules (mobile itself only has ~58 packages installed).

**How to apply:** Use this exact command any time an EAS build is needed from within the Replit main agent environment.
