---
name: Managed GitHub push authentication
description: Recovering from native Git authentication failures without handling credentials or replacing remote history.
---

Native Git HTTPS authentication and the connected GitHub App can have different authorization states. A failed native push does not establish that the connected integration cannot write.

**Why:** Native Git rejected its credentials while the connected GitHub App retained repository write access.

**How to apply:** Check the existing connected integration before requesting reconnection. If using its Git object API, preserve the current remote parent, verify the created tree matches the tested local tree, and update the branch with `force: false`. Run the repository's pre-push validation explicitly, since API writes do not execute local Git hooks. Never retrieve or display credentials.

Preserve local commit identities when publishing through the Git object API,
not just their file trees. Verify returned commit SHAs before advancing a branch.

**Why:** Publishing identical files under a new commit identity left local and
GitHub histories divergent, causing later ordinary pushes to be rejected even
though the committed file trees matched exactly.

**How to apply:** Preserve parents, author and committer timestamps (including
timezone), and exact messages. If equal-tree histories have already diverged,
merge them without force-pushing or resetting uncommitted work. Fetch afterward
and confirm that local and remote heads match.

Revalidate an isolated release checkout's Git root before staging; its files surviving does not establish that its Git metadata still exists.

**Why:** A retained release directory without its own Git metadata resolved Git commands to the enclosing workspace repository instead of the intended release checkout.

**How to apply:** Confirm `git -C <release-directory> rev-parse --show-toplevel` points to that directory and its HEAD matches the current remote base. If it does not, create a fresh remote-based checkout rather than staging through the enclosing repository.
