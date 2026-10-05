#!/usr/bin/env bash
# Regenerate the Ardent port bundle (ardent-port.patch + MANIFEST.txt) from the
# current working tree of the mirror repo. Run from anywhere:
#   bash port/regenerate.sh
#
# The patch rewrites paths to be rooted at packages/cli/ so it applies from the
# monorepo root with `git apply` (which strips the leading a/).
#
# The base is the LAST MIRROR SYNC, not the local HEAD. The sync commit is the
# state the monorepo actually has, so diffing against it carries every Ardent
# change — including the ones already committed on this branch — and reports the
# files upstream has never seen as new files. Diffing against HEAD instead would
# ship only the uncommitted leftovers and turn new modules into edits of files
# that do not exist upstream (see port/PORT.md).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=port
RAW=$(mktemp)

# The commit that last wrote .mirror-state.json is the last sync from the
# monorepo; its tree is what upstream holds.
BASE=$(git log -1 --format=%H -- .mirror-state.json)

# The ported surface: Ardent docs + modules + tests + the P0 evaluation harness,
# plus the tracked mirror files they edit. Globs keep this from drifting as
# files are added. `eval/` must travel with `test/ardent-eval-*.test.ts`, which
# import from it, and `tsconfig.json` carries the matching `include` entry (it is
# a tracked repo file, not part of the mirror payload).
FILES=$(printf '%s\n' \
  ARDENT.md \
  src/paths.ts \
  src/pi-launch.ts \
  src/provider.ts \
  src/onboarding.ts \
  src/header.ts \
  src/run.ts \
  src/update-check.ts \
  src/vendor/shared/api.ts \
  test/no-subagents.test.ts \
  test/firstrun.test.ts \
  test/header.test.ts \
  test/update-check.test.ts \
  tsconfig.json \
  src/ardent/*.ts \
  eval/*.ts \
  test/ardent-*.test.ts)

# Files this change set DELETES. A deleted tracked path is not matched by the
# globs above (the file is gone), and `git add -N` would fail on a missing
# path, but `git diff` shows the deletion directly — so it is listed and diffed
# separately, or the port would leave the removed module behind upstream. An
# entry that does not exist in the base was never ported, so it produces
# nothing and is not reported in the manifest.
DELETED=$(printf '%s\n' \
  src/ardent/refusal.ts \
  test/ardent-refusal.test.ts)

# Intent-to-add so `git diff` includes the new (untracked) files; reset after.
git add -N -- $FILES
git diff "$BASE" -- $FILES $DELETED > "$RAW"
git reset -q -- $FILES

# a/src/... -> a/packages/cli/src/... (and the same for the ---/+++ headers).
sed -E \
  's#^diff --git a/(.*) b/(.*)$#diff --git a/packages/cli/\1 b/packages/cli/\2#; s#^--- a/(.*)$#--- a/packages/cli/\1#; s#^\+\+\+ b/(.*)$#+++ b/packages/cli/\1#' \
  "$RAW" > "$OUT/ardent-port.patch"
rm -f "$RAW"

{
  echo "# Ardent port manifest"
  echo "#"
  echo "# Mirror base commit: $BASE"
  echo "# Mirror base commit date: $(git show -s --format=%cI "$BASE")"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "#"
  echo "# 'status' is relative to the base commit above — what the monorepo has:"
  echo "#   new       the file does not exist upstream; the patch creates it"
  echo "#   modified  the file exists upstream; the patch edits it"
  echo "#   deleted   the file exists upstream; the patch removes it"
  echo "# sha256 is of the file AFTER the port."
  echo "#"
  printf '%-8s  %-64s  %s\n' "status" "sha256" "monorepo path"
  for f in $FILES; do
    if git cat-file -e "$BASE:$f" 2>/dev/null; then status="modified"; else status="new"; fi
    printf '%-8s  %s  %s\n' "$status" "$(sha256sum "$f" | cut -d' ' -f1)" "packages/cli/$f"
  done
  for f in $DELETED; do
    if git cat-file -e "$BASE:$f" 2>/dev/null; then
      printf '%-8s  %-64s  %s\n' "deleted" "-" "packages/cli/$f"
    fi
  done
} > "$OUT/MANIFEST.txt"

echo "base $BASE ($(git show -s --format=%cs "$BASE"))"
echo "wrote $OUT/ardent-port.patch ($(grep -c '^diff --git' "$OUT/ardent-port.patch") files)"
echo "wrote $OUT/MANIFEST.txt"
