#!/usr/bin/env bash
# Scenario helpers for the M4+ scripts. Source after tools/lib/poc-env.sh and tools/lib/openshell.sh.

ADAPTER_LOG=state/logs/adapter.log
WATCHER_LOG=state/logs/watcher.log
ADAPTER_PID=""
WATCHER_PID=""
PROFILE_ID="poc-purchasing-gw"
PROVIDER="poc-purchasing"
CREATED_PROFILE=0
CREATED_PROVIDER=0
SANDBOXES=()

ok()   { printf 'ok    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; FAIL=1; }
note() { printf 'note  %s\n' "$1"; }
die()  { printf 'FAIL  %s\n' "$1"; exit 1; }

# start_adapter [VAR=value ...]: extra env for this adapter instance (e.g. MM_API=...)
start_adapter() {
  stop_adapter
  : > "$ADAPTER_LOG"
  env ADAPTER_TLS_CERT=state/certs/server.pem ADAPTER_TLS_KEY=state/certs/server.key OPENSHELL_JWT_DIR="$OPENSHELL_JWT_DIR" \
    ADAPTER_REGISTRY=state/bindings.json ADAPTER_JOURNAL_DIR=state/journal ADAPTER_AGENTS_DIR=state/agents ADAPTER_GATE=on "$@" \
    nohup node packages/adapter/src/main.mjs >> "$ADAPTER_LOG" 2>&1 &
  ADAPTER_PID=$!
  for _ in $(seq 1 20); do grep -q '"event":"listening"' "$ADAPTER_LOG" && return 0; sleep 0.5; done
  cat "$ADAPTER_LOG"
  return 1
}
stop_adapter() { [[ -n "$ADAPTER_PID" ]] && { kill "$ADAPTER_PID" 2>/dev/null; wait "$ADAPTER_PID" 2>/dev/null; ADAPTER_PID=""; }; return 0; }

start_watcher() {
  : > "$WATCHER_LOG"
  ADAPTER_REGISTRY=state/bindings.json WATCH_INTERVAL_MS=${WATCH_INTERVAL_MS:-2000} nohup node packages/adapter/bin/watcher.mjs >> "$WATCHER_LOG" 2>&1 &
  WATCHER_PID=$!
}
stop_watcher() { [[ -n "$WATCHER_PID" ]] && { kill "$WATCHER_PID" 2>/dev/null; wait "$WATCHER_PID" 2>/dev/null; WATCHER_PID=""; }; return 0; }

setup_provider() {
  openshell profile lint -f deploy/openshell/poc-purchasing-profile.yaml >/dev/null || return 1
  openshell profile import -f deploy/openshell/poc-purchasing-profile.yaml >/dev/null || return 1
  CREATED_PROFILE=1
  PURCHASING_TOKEN=$(cat state/purchasing-api-token) openshell provider create --name "$PROVIDER" --type "$PROFILE_ID" --credential PURCHASING_TOKEN >/dev/null || return 1
  CREATED_PROVIDER=1
}

# create_sandbox <name> <policy>; bind_sandbox <name> <agentKey> -> prints the sandbox UUID
create_sandbox() {
  openshell sandbox create --name "$1" --from "$SMOKE_IMAGE" --no-auto-providers --provider "$PROVIDER" \
    --policy "$2" --detach -- sleep 3600 >/dev/null || return 1
  SANDBOXES+=("$1")
}
bind_sandbox() {
  local id
  id=$(sandbox_id "$1") || return 1
  node packages/adapter/bin/bindings.mjs bind "$id" "$1" "$2" >/dev/null || return 1
  echo "$id"
}

# save_sandbox_logs <label>: keep OpenShell's view before sandboxes are deleted
save_sandbox_logs() {
  for sb in "${SANDBOXES[@]}"; do openshell logs "$sb" --source sandbox -n 5000 > "docs/report/runs/$1-$sb.log" 2>&1 || true; done
  cp "$ADAPTER_LOG" "docs/report/runs/$1-adapter.log" 2>/dev/null || true
  cp state/logs/gateway.log "docs/report/runs/$1-gateway.log" 2>/dev/null || true
  cp "$WATCHER_LOG" "docs/report/runs/$1-watcher.log" 2>/dev/null || true
}

run_cleanup() {
  for sb in "${SANDBOXES[@]}"; do openshell sandbox delete "$sb" >/dev/null 2>&1 || true; done
  node --input-type=module -e 'import { readBindings, revokeBinding } from "./packages/adapter/src/registry.mjs"; for (const b of readBindings("state/bindings.json")) if (b.status === "active") revokeBinding("state/bindings.json", b.sandboxId);' 2>/dev/null
  (( CREATED_PROVIDER )) && { sleep 2; openshell provider delete "$PROVIDER" >/dev/null 2>&1 || echo "WARN  could not delete provider $PROVIDER"; }
  (( CREATED_PROFILE )) && { openshell profile delete "$PROFILE_ID" >/dev/null 2>&1 || echo "WARN  could not delete profile $PROFILE_ID"; }
  restore_gateway_cfg
  stop_watcher
  stop_adapter
  bash tools/poc-stack.sh down >/dev/null
}

ledger_count() {
  curl -s -H "x-ledger-token: $(cat state/ledger-token)" http://127.0.0.1:18080/ledger | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).count)}catch{console.log(-1)}})'
}

# buy <sandbox> <json> [extra curl args...]: prints the body, then the HTTP status on the last line
buy() {
  local sb=$1 body=$2
  shift 2
  openshell sandbox exec -n "$sb" --no-tty -- sh -c \
    'curl -sS -m 20 -w "\n%{http_code}" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $PURCHASING_TOKEN" "$@" --data-binary @- https://host.openshell.internal:8443/purchase-requests' \
    sh "$@" <<<"$body" 2>/dev/null
}
status_of() { tail -n1 <<<"$1"; }
body_of()   { sed '$d' <<<"$1"; }
reason_of() { body_of "$1" | grep -o '"reason_code":"[^"]*"' | cut -d'"' -f4; }
error_of()  { body_of "$1" | grep -o '"error":"[^"]*"' | head -n1 | cut -d'"' -f4; }

# journal_last <sandboxId>: "<decision> <reasonCode> <agentDid>" of the sandbox's latest journaled request
journal_last() {
  cat state/journal/*.jsonl 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=s.split("\n").filter(Boolean).map(JSON.parse).filter(x=>x.kind==="request"&&x.sandboxId===process.argv[1]).at(-1);console.log(r?`${r.decision} ${r.reasonCode??r.osReasonCode??""} ${r.agentDid??""}`:"none")})' "$1"
}
