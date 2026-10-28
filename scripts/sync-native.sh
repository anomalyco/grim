#!/usr/bin/env bash
# Sync native/ from the Mac app's working repo (the laptop's ~/projects/grimoire-native, main) into this repo and push.
# On the laptop: a fresh clone of main, `git filter-repo --to-subdirectory-filter native` (same commit ids every run),
# bundled; here: fetched into refs/sync/native, merged into main ("Sync native", a no-op when nothing is new), pushed.
# Only native/ paths change. Uncommitted work on either machine is never touched.
# Usage: scripts/sync-native.sh [ssh-host]        (default james@100.109.145.97)
set -euo pipefail

HOST="${1:-james@100.109.145.97}"
REMOTE_REPO='~/projects/grimoire-native'
SSH=(ssh -o BatchMode=yes "$HOST")

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
GIT_DIR="$(git rev-parse --git-dir)"

die() { echo "sync-native: $*" >&2; exit 1; }

[ -e "$GIT_DIR/MERGE_HEAD" ] && die "a merge is in progress; finish or abort it first"
[ -e "$GIT_DIR/CHERRY_PICK_HEAD" ] || [ -e "$GIT_DIR/REVERT_HEAD" ] && die "a cherry-pick/revert is in progress"
[ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ] && die "a rebase is in progress"
[ "$(git symbolic-ref --short -q HEAD)" = main ] || die "not on main"
[ -z "$(git status --porcelain -- native)" ] || die "native/ has uncommitted changes here"

REMOTE_TMP="$("${SSH[@]}" 'mktemp -d /tmp/grim-sync.XXXXXX')"
LOCAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/grim-sync.XXXXXX")"
cleanup() {
  "${SSH[@]}" "rm -rf '$REMOTE_TMP'" || true
  rm -rf "$LOCAL_TMP"
  git update-ref -d refs/sync/native 2>/dev/null || true
}
trap cleanup EXIT

echo "sync-native: filtering $HOST:$REMOTE_REPO main"
"${SSH[@]}" "set -e
  export PATH=\"\$(echo \$HOME/Library/Python/*/bin | tr ' ' ':'):\$HOME/.local/bin:\$PATH\"
  git clone -q --no-local --single-branch --branch main $REMOTE_REPO '$REMOTE_TMP/repo'
  cd '$REMOTE_TMP/repo'
  git filter-repo --quiet --force --to-subdirectory-filter native
  git bundle create -q '$REMOTE_TMP/native.bundle' main"

scp -q -o BatchMode=yes "$HOST:$REMOTE_TMP/native.bundle" "$LOCAL_TMP/native.bundle"
git fetch -q "$LOCAL_TMP/native.bundle" main:refs/sync/native

[ "$(git ls-tree --name-only refs/sync/native)" = native ] || die "the bundle has paths outside native/"

if git merge-base --is-ancestor refs/sync/native HEAD; then
  echo "sync-native: nothing new (native at $(git rev-parse --short refs/sync/native))"
else
  echo "sync-native: merging $(git rev-list --count HEAD..refs/sync/native) commit(s)"
  git merge --no-ff --no-edit -m "Sync native" refs/sync/native
  changed="$(git diff --name-only HEAD^1 HEAD | grep -v '^native/' || true)"
  if [ -n "$changed" ]; then
    git reset -q --keep HEAD^1
    die "the merge changed paths outside native/ (undone): $changed"
  fi
fi

if command -v push >/dev/null; then push origin main; else git push --no-verify origin main; fi
