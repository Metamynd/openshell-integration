#!/usr/bin/env bash
# Re-vendor the OpenShell middleware protos at the pinned commit and verify
# them against versions.lock.json. Usage: scripts/sync-protos.sh [--check]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/versions.lock.json"
dest="$root/adapter/proto/openshell"
repo="$(node -p "require('$lock').openshell.repo")"
commit="$(node -p "require('$lock').openshell.commit")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
git -C "$tmp" fetch -q --depth 1 "$repo" "$commit"
git -C "$tmp" checkout -q FETCH_HEAD

status=0
for rel in $(node -p "Object.keys(require('$lock').openshell.protos).join(' ')"); do
  want="$(node -p "require('$lock').openshell.protos['$rel']")"
  got="$(sha256sum "$tmp/$rel" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    echo "upstream $rel at $commit does not match the lock ($got != $want)" >&2
    exit 1
  fi
  name="$(basename "$rel")"
  if [[ "${1:-}" == "--check" ]]; then
    if ! cmp -s "$tmp/$rel" "$dest/$name"; then
      echo "vendored $name differs from upstream $commit" >&2
      status=1
    fi
  else
    cp "$tmp/$rel" "$dest/$name"
  fi
done
[[ "${1:-}" == "--check" ]] || cp "$tmp/LICENSE" "$dest/LICENSE"
[[ $status -eq 0 ]] && echo "protos match OpenShell $commit"
exit $status
