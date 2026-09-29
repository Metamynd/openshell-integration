#!/usr/bin/env bash
# Build plan 4.2: lint a sandbox's EFFECTIVE policy (sandbox policy + provider layers) for the
# configurations that would let traffic to the purchasing gateway bypass the MetaMynd adapter:
#   tls: skip / protocol: tcp (uninspected), allowed_ips or literal-IP hosts (IP reachability),
#   enforcement: audit (L7 logs instead of blocking), on_error: fail_open, or any middleware
#   ordered after the adapter. Text-level checks on `openshell sandbox get <name> --policy-only`.
# Usage: bash tools/policy-lint.sh <sandbox-name>
set -uo pipefail
name=${1:?usage: policy-lint.sh <sandbox-name>}
policy=$(openshell sandbox get "$name" --policy-only 2>/dev/null) || { echo "FAIL  could not read the effective policy of $name"; exit 1; }
fail=0
check() { # <description> <regex that must NOT match>
  if grep -qiE "$2" <<<"$policy"; then echo "FAIL  $1"; grep -niE "$2" <<<"$policy" | sed 's/^/      /' | head -n 5; fail=1; else echo "ok    $1"; fi
}
check "no uninspected TLS (tls: skip)"            '^\s*tls:\s*"?skip'
check "no raw TCP endpoints (protocol: tcp)"      '^\s*protocol:\s*"?tcp'
check "no IP allow-lists (allowed_ips)"           'allowed_ips'
check "no literal-IP hosts"                       '^\s*-?\s*host:\s*"?[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'
check "no audit-only L7 enforcement"              '^\s*enforcement:\s*"?audit'
check "no fail-open middleware"                   'fail_open'
grep -qE '^\s*middleware:\s*"?metamynd' <<<"$policy" && echo "ok    the metamynd adapter is attached" || { echo "FAIL  the metamynd adapter is not attached"; fail=1; }
# The adapter must be the last stage: its order is the highest of all middleware entries.
orders=$(grep -oE '^\s*order:\s*-?[0-9]+' <<<"$policy" | grep -oE -- '-?[0-9]+' | sort -n)
mm=$(awk '/^[[:space:]]*metamynd:/{f=1} f && /order:/{gsub(/[^0-9-]/,"",$0); print; exit}' <<<"$policy")
if [[ -n "$mm" && "$mm" == "$(tail -n1 <<<"$orders")" && $(grep -c -x -- "$mm" <<<"$orders") -eq 1 ]]; then echo "ok    the adapter is the last middleware stage (order $mm)"
else echo "FAIL  the adapter is not uniquely the last middleware stage (adapter order ${mm:-?}; all: $(tr '\n' ' ' <<<"$orders"))"; fail=1; fi
exit "$fail"
