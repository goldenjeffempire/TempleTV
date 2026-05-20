#!/usr/bin/env bash
#
# release-rollback.sh — safely undo the most recent LOCAL release before push.
#
# Reverses what release.sh did, in reverse order:
#   1. Delete the local annotated tag.
#   2. git reset --hard to the commit before the release commit.
#
# This restores app.json (version + versionCode), package.json (version),
# and RELEASES.md (the prepended stub) to their pre-release state in one
# atomic operation.
#
# Hard refuses if any of these are true:
#   - working tree is dirty (we can't tell your edits from the release's)
#   - HEAD commit isn't a release commit (subject doesn't match "Release v*")
#   - the tag named in the release commit doesn't exist locally
#   - the tag has been pushed to any remote (rollback would diverge history)
#
# These guards mean: if release-rollback succeeds, your repo state is
# byte-identical to what it was immediately before you ran release:patch.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# ── Guard 1: clean working tree ──────────────────────────────────────────────
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "ERROR: working tree is not clean. Commit or stash your changes first."
  echo "Cannot safely roll back when there are unrelated uncommitted edits."
  echo ""
  echo "Uncommitted files:"
  echo "$DIRTY" | sed 's/^/  /'
  exit 1
fi

# ── Guard 2: HEAD must be a release commit ───────────────────────────────────
HEAD_SUBJECT="$(git log -1 --pretty=%s)"
if [[ ! "$HEAD_SUBJECT" =~ ^Release\ v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: HEAD commit is not a release commit."
  echo ""
  echo "  HEAD subject: $HEAD_SUBJECT"
  echo ""
  echo "release-rollback only undoes the most recent release commit. If you"
  echo "have other commits on top of the release, rewind them manually first"
  echo "(git reset / git revert) until the release commit is HEAD again."
  exit 1
fi

TAG="${HEAD_SUBJECT#Release }"

# ── Guard 3: the tag must exist locally ──────────────────────────────────────
if ! git rev-parse --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "ERROR: HEAD looks like release $TAG, but no local tag '$TAG' found."
  echo "Refusing to roll back — the repo state is inconsistent. Inspect with:"
  echo "  git log -1"
  echo "  git tag -l '$TAG*'"
  exit 1
fi

# ── Guard 4: the tag must NOT be on any remote ───────────────────────────────
REMOTE_HITS="$(git ls-remote --tags 2>/dev/null | awk -v t="refs/tags/$TAG" '$2==t || $2==t"^{}" {print}' || true)"
if [ -n "$REMOTE_HITS" ]; then
  echo "ERROR: tag '$TAG' has been pushed to a remote — rollback would"
  echo "diverge history. If you really need to retract a published release,"
  echo "do it deliberately:"
  echo "  git push --delete origin $TAG     # withdraw remote tag"
  echo "  git revert HEAD                   # forward-fix instead of rewind"
  exit 1
fi

# ── Confirm with the user ────────────────────────────────────────────────────
PARENT="$(git rev-parse HEAD~1)"
PARENT_SUBJECT="$(git log -1 --pretty=%s "$PARENT")"

echo "About to roll back the most recent local release:"
echo ""
echo "  Tag to delete:         $TAG"
echo "  Commit to discard:     $(git rev-parse --short HEAD)  $HEAD_SUBJECT"
echo "  HEAD will move back to: $(git rev-parse --short "$PARENT")  $PARENT_SUBJECT"
echo ""
echo "This will revert app.json, package.json, and RELEASES.md to their"
echo "pre-release state. The release .aab on disk is NOT deleted (it's"
echo "useless without the tag, but harmless to keep)."
echo ""
read -r -p "Proceed? [y/N] " ANSWER
case "$ANSWER" in
  y|Y|yes|YES) ;;
  *) echo "Aborted. No changes made."; exit 0 ;;
esac

# ── Execute rollback ─────────────────────────────────────────────────────────
git tag -d "$TAG"
git reset --hard "$PARENT"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Rollback complete."
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "  Tag '$TAG' deleted (local only — was never pushed)."
echo "  HEAD reset to $(git rev-parse --short HEAD)."
echo ""
echo "  Working tree is now byte-identical to pre-release state."
echo "  You can edit and re-run 'pnpm run release:patch' when ready."
echo ""
