---
name: Managed GitHub push authentication
description: Recovering from native Git authentication failures without handling credentials or replacing remote history.
---

Native Git HTTPS authentication and the connected GitHub App can have different authorization states. A failed native push does not establish that the connected integration cannot write.

**Why:** Native Git rejected its credentials while the connected GitHub App retained repository write access.

**How to apply:** Check the existing connected integration before requesting reconnection. If using its Git object API, preserve the current remote parent, verify the created tree matches the tested local tree, and update the branch with `force: false`. Run the repository's pre-push validation explicitly, since API writes do not execute local Git hooks. Never retrieve or display credentials.
