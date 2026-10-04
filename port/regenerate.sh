#!/usr/bin/env bash
# Regenerate the Ardent port bundle (ardent-port.patch + MANIFEST.txt) from the
# current working tree of the mirror repo. Run from anywhere:
#   bash port/regenerate.sh
#
# The patch rewrites paths to be rooted at packages/cli/ so it applies from the
# monorepo root with `git apply` (which strips the leading a/).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=port
RAW=$(mktemp)

# The ported surface: Ardent docs + modules + tests, plus the three tracked
# mirror files they edit. Globs keep this from drifting as files are added.
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
  src/ardent/*.ts \
  test/ardent-*.test.ts)

# Intent-to-add so `git diff` includes the new (untracked) files; reset after.
git add -N -- $FILES
git diff -- $FILES > "$RAW"
git reset -q -- $FILES

# a/src/... -> a/packages/cli/src/... (and the same for the ---/+++ headers).
sed -E \
  's#^diff --git a/(.*) b/(.*)$#diff --git a/packages/cli/\1 b/packages/cli/\2#; s#^--- a/(.*)$#--- a/packages/cli/\1#; s#^\+\+\+ b/(.*)$#+++ b/packages/cli/\1#' \
  "$RAW" > "$OUT/ardent-port.patch"
rm -f "$RAW"

{
  echo "# Ardent port manifest"
  echo "#"
  echo "# Mirror base commit: $(git rev-parse HEAD)"
  echo "# Mirror base commit date: $(git show -s --format=%cI HEAD)"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "#"
  echo "# 'status' is relative to the mirror repo: modified-in-place or new-file."
  echo "# sha256 is of the file AFTER the port."
  echo "#"
  printf '%-8s  %-64s  %s\n' "status" "sha256" "monorepo path"
  for f in $FILES; do
    status="modified"
    case "$f" in src/ardent/*|test/ardent-*|ARDENT.md) status="new" ;; esac
    printf '%-8s  %s  %s\n' "$status" "$(sha256sum "$f" | cut -d' ' -f1)" "packages/cli/$f"
  done
} > "$OUT/MANIFEST.txt"

echo "wrote $OUT/ardent-port.patch ($(grep -c '^diff --git' "$OUT/ardent-port.patch") files)"
echo "wrote $OUT/MANIFEST.txt"
