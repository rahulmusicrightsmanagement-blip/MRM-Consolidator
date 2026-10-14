#!/usr/bin/env bash
# Bump the MRM-Consolidator app version (semantic versioning) and log the change.
#   scripts/bump-version.sh patch "Fixed wrong share in compare table"   0.1.3 → 0.1.4  (fix / small change)
#   scripts/bump-version.sh minor "Added updated-master download"        0.1.3 → 0.2.0  (new feature)
#   scripts/bump-version.sh major "New data model, old reports reset"    0.1.3 → 1.0.0  (breaking change)
# VERSION is the single source: the footer, frontend/package.json and CHANGELOG.md follow it.
set -euo pipefail
cd "$(dirname "$0")/.."
kind="${1:-}"; note="${2:-}"
if [[ ! "$kind" =~ ^(patch|minor|major)$ || -z "$note" ]]; then
  echo "usage: $0 patch|minor|major \"what changed\"" >&2; exit 1
fi
IFS=. read -r major minor patch < VERSION
case "$kind" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac
new="$major.$minor.$patch"
echo "$new" > VERSION
sed -i -E "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$new\"/" frontend/package.json
entry="## $new – $(date +%F) ($kind)"$'\n'"- $note"$'\n'
if [ -f CHANGELOG.md ]; then
  { head -n 2 CHANGELOG.md; echo "$entry"; tail -n +3 CHANGELOG.md; } > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
else
  printf '# MRM changelog\n\n%s' "$entry" > CHANGELOG.md
fi
echo "MRM-Consolidator $new"
