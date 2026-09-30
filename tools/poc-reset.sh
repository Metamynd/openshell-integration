#!/usr/bin/env bash
# Recover from an interrupted POC run. Removes only what the POC scripts create, then restores the
# OpenShell gateway to its defaults:
#   - sandboxes named m0-… to m5-… or demo-agent-…, and their adapter bindings;
#   - the providers poc-purchasing and m0-purchasing, then their profiles (…-gw);
#   - ~/.config/openshell/gateway.toml, only if the POC scripts wrote it (marker line, or the POC's
#     metamynd registration and supervisor image); any other gateway.toml is left alone;
#   - the adapter, watcher and stub processes, and the POC stack (signers, mock API, purchasing gateway).
# Usage: bash tools/poc-reset.sh [--dry-run]
# Refuses to run while a POC script is still running.
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/lib/openshell.sh

dry=0
[[ "${1:-}" == --dry-run ]] && dry=1
say()  { printf '%s\n' "$1"; }
# act <cmd…>: runs it quietly and returns its status; under --dry-run only prints it.
act()  { if (( dry )); then say "would: $*"; return 0; fi; "$@" >/dev/null 2>&1; }

running=$(pgrep -af 'tools/(m[0-9][a-z0-9-]*|demo)\.sh' | grep -v poc-reset || true)
if [[ -n "$running" ]]; then
  say "FAIL  a POC script is still running; let it finish or stop it first:"
  say "$running"
  exit 1
fi

echo "== sandboxes"
names=$(openshell sandbox list -o json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let doc; try { doc = JSON.parse(s); } catch { return; }
    const out = new Set();
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      const name = n.metadata?.name ?? (n.id !== undefined || n.phase !== undefined ? n.name : undefined);
      if (typeof name === "string" && /^(m[0-9]-|demo-agent-)/.test(name)) out.add(name);
      for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
    };
    walk(doc);
    console.log([...out].join("\n"));
  });')
if [[ -z "$names" ]]; then say "ok    none"; else
  while read -r sb; do
    [[ -n "$sb" ]] || continue
    if act openshell sandbox delete "$sb"; then (( dry )) || say "ok    deleted $sb"; else say "WARN  could not delete $sb"; fi
  done <<<"$names"
fi
if [[ -f state/bindings.json ]] && (( ! dry )); then
  node --input-type=module -e 'import { readBindings, revokeBinding } from "./packages/adapter/src/registry.mjs"; let n = 0; for (const b of readBindings("state/bindings.json")) if (b.status === "active") { revokeBinding("state/bindings.json", b.sandboxId); n++; } console.log(`ok    revoked ${n} active binding(s)`);' 2>/dev/null
fi

echo "== providers and profiles"
# del_named <provider|profile> <name>: delete it; "not found" is fine, any other failure is reported.
del_named() {
  if (( dry )); then say "would: openshell $1 delete $2 (if present)"; return; fi
  local out
  if out=$(openshell "$1" delete "$2" 2>&1); then say "ok    deleted $1 $2"
  elif ! grep -qiE 'not found|does not exist|no such|unknown' <<<"$out"; then say "WARN  could not delete $1 $2: $(tr '\n' ' ' <<<"$out" | cut -c1-200)"; fi
}
# Providers before the profiles they use.
for p in poc-purchasing m0-purchasing; do del_named provider "$p"; done
(( dry )) || sleep 2 # a just-deleted provider can briefly still reference its profile
for p in poc-purchasing-gw m0-purchasing-gw; do del_named profile "$p"; done

echo "== processes"
for pat in 'packages/adapter/src/main\.mjs' 'packages/adapter/bin/watcher\.mjs' 'packages/adapter/src/stub-main\.mjs' 'tools/lib/upstream-echo\.mjs'; do
  if pgrep -f "$pat" >/dev/null; then act pkill -f "$pat"; (( dry )) || say "ok    stopped ${pat//\\/}"; fi
done
if (( dry )); then say "would: bash tools/poc-stack.sh down"; else bash tools/poc-stack.sh down | sed 's/^/      /'; fi

echo "== gateway.toml"
if [[ ! -e "$GATEWAY_CFG" ]]; then say "ok    none (gateway on its defaults)"
elif grep -qF "$GATEWAY_CFG_MARKER" "$GATEWAY_CFG" \
  || { grep -q '^name = "metamynd"' "$GATEWAY_CFG" && grep -qF "supervisor_image = \"$PCA_IMAGE\"" "$GATEWAY_CFG"; }; then
  act rm -f "$GATEWAY_CFG"
  if (( dry )); then say "would: systemctl --user restart openshell-gateway"
  else
    systemctl --user restart openshell-gateway
    if wait_gateway; then say "ok    removed the POC's gateway.toml; gateway back on its defaults"
    else say "WARN  gateway did not reconnect; check: journalctl --user -u openshell-gateway -n 50"; exit 1; fi
  fi
else
  say "WARN  $GATEWAY_CFG was not written by the POC scripts; left alone. Move it aside yourself if a POC run needs the gateway."
  exit 1
fi
say "== reset complete"
