#!/usr/bin/env bash
# Shared helpers for the POC scripts. Source from the repo root:  . tools/lib/poc-env.sh
# Loads .env.poc (MM_USERNAME, MM_PASSWORD, AGENTSAFE_SIGNER_PASSPHRASE) and manages
# agentsafe-signer daemons under state/signers/<name> (socket state/signers/<name>/signer.sock).

if [[ -f .env.poc ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.poc
  set +a
fi
mkdir -p state state/logs state/pids
chmod 700 state

SIGNER_BIN="node_modules/.bin/agentsafe-signer"

require_env() {
  local missing=()
  for v in "$@"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
  if (( ${#missing[@]} )); then
    echo "FAIL  missing in .env.poc: ${missing[*]}"
    return 1
  fi
}

ensure_deps() {
  [[ -x "$SIGNER_BIN" && -d node_modules/@metamynd/agentsafe-http-gateway ]] || npm ci --no-audit --no-fund >/dev/null
}

# wait_for <path> [seconds]
wait_for() {
  local path=$1 secs=${2:-20}
  for _ in $(seq 1 $((secs * 2))); do [[ -e "$path" ]] && return 0; sleep 0.5; done
  return 1
}

# start_signer <name> <agent|service> [identity] [admin]
start_signer() {
  local name=$1 role=$2 identity=${3:-} admin=${4:-}
  local dir="state/signers/$name"
  mkdir -p "$dir" && chmod 700 state/signers "$dir"
  stop_signer "$name"
  rm -f "$dir/signer.sock" "$dir/signer-admin.sock"
  local args=(start --state-dir "$dir" --role "$role" --kek-backend passphrase)
  [[ -n "$identity" ]] && args+=(--identity "$identity")
  [[ -n "$admin" ]] && args+=(--admin-timeout 120000 --admin)
  nohup "$SIGNER_BIN" "${args[@]}" >> "$dir/daemon.log" 2>&1 &
  echo $! > "$dir/daemon.pid"
  local sock="$dir/signer.sock"
  [[ -n "$admin" ]] && sock="$dir/signer-admin.sock"
  if ! wait_for "$sock" 20; then
    echo "FAIL  signer $name did not start; last log lines:"
    tail -n 20 "$dir/daemon.log"
    return 1
  fi
}

stop_signer() {
  local pidfile="state/signers/$1/daemon.pid"
  if [[ -f "$pidfile" ]]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
    sleep 0.3
  fi
}

# enrolment_field <js expression over `e`>, e.g. enrolment_field 'e.agents.A.agentDid'
enrolment_field() {
  node -e "const e=JSON.parse(require('fs').readFileSync('state/enrolment.json','utf8')); const v=($1); if(!v) process.exit(1); console.log(v)"
}

# private_token <file>: create a random token once (0600) and print it
private_token() {
  local f=$1
  [[ -f "$f" ]] || (umask 077 && openssl rand -hex 24 > "$f")
  cat "$f"
}
