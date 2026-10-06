#!/usr/bin/env bash
# Deploy this checkout to a host that runs the adapter and the purchasing gateway as systemd services from a plain copy
# of the code (no .git), e.g. /opt/metamynd/openshell-integration with state in /var/lib/metamynd.
#
#   sudo bash tools/deploy-host.sh [--restart-signers] [--allow-dirty] [--dry-run]
#
# What it does, in order (any failure after the copy rolls back to the previous copy and restarts it):
#   1. checks this checkout: the commit it deploys, and no uncommitted changes to tracked files (--allow-dirty to override)
#   2. backs up the deployed copy to <dest>.bak-<UTC timestamp> (keeps the newest $KEEP_BACKUPS)
#   3. copies the code (rsync --delete; never .git, state/, node_modules/ or docs/report/) and runs npm ci there
#   4. gives the adapter its escalations file (ADAPTER_ESCALATIONS, a systemd drop-in) in a directory its user owns
#   5. restarts the signers (only with --restart-signers), then the purchasing gateway, then the adapter, and waits for
#      each to log "listening"
#   6. records what was deployed in <dest>/DEPLOYED
#
# Env (defaults in brackets):
#   DEPLOY_DEST [/opt/metamynd/openshell-integration]  DEPLOY_STATE [/var/lib/metamynd]  DEPLOY_USER [metamynd]  DEPLOY_GROUP [$DEPLOY_USER]
#   ADAPTER_UNIT [metamynd-adapter]  GATEWAY_UNIT [metamynd-purchasing-gateway]
#   SIGNER_UNITS [every loaded metamynd-signer@* unit]  KEEP_BACKUPS [3]  READY_TIMEOUT_S [30]
set -euo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
DEST=${DEPLOY_DEST:-/opt/metamynd/openshell-integration}
STATE=${DEPLOY_STATE:-/var/lib/metamynd}
RUN_USER=${DEPLOY_USER:-metamynd}
RUN_GROUP=${DEPLOY_GROUP:-$RUN_USER}
ADAPTER_UNIT=${ADAPTER_UNIT:-metamynd-adapter}
GATEWAY_UNIT=${GATEWAY_UNIT:-metamynd-purchasing-gateway}
KEEP_BACKUPS=${KEEP_BACKUPS:-3}
READY_TIMEOUT_S=${READY_TIMEOUT_S:-30}
ESCALATIONS_DIR="$STATE/escalations"
DROPIN_DIR="/etc/systemd/system/$ADAPTER_UNIT.service.d"
DROPIN="$DROPIN_DIR/escalations.conf"

RESTART_SIGNERS=0 ALLOW_DIRTY=0 DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --restart-signers) RESTART_SIGNERS=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf 'ok    %s\n' "$1"; }
die()  { printf 'FAIL  %s\n' "$1" >&2; exit 1; }

# --- 1. preflight -------------------------------------------------------------------------------------------------
step "preflight"
[[ $DRY_RUN == 1 || $EUID == 0 ]] || die "run as root (it writes $DEST, $DROPIN and restarts services)"
for cmd in git rsync npm systemctl journalctl; do command -v "$cmd" >/dev/null || die "$cmd is not installed"; done
[[ -d "$DEST" ]] || die "$DEST does not exist (this script updates an existing deployment)"
[[ ! -d "$DEST/.git" ]] || die "$DEST is a git checkout; update it with git instead"
id "$RUN_USER" >/dev/null 2>&1 || die "user $RUN_USER does not exist"
for unit in "$ADAPTER_UNIT" "$GATEWAY_UNIT"; do
  systemctl cat "$unit.service" >/dev/null 2>&1 || die "systemd unit $unit.service not found"
done
if [[ -z "${SIGNER_UNITS+x}" ]]; then
  SIGNER_UNITS=$(systemctl list-units --all --plain --no-legend 'metamynd-signer@*.service' | awk '{print $1}' | tr '\n' ' ')
fi

COMMIT=$(git -C "$SRC" rev-parse --short HEAD)
DIRTY=$(git -C "$SRC" status --porcelain --untracked-files=no)
if [[ -n "$DIRTY" ]]; then
  printf '%s\n' "$DIRTY"
  [[ $ALLOW_DIRTY == 1 ]] || die "$SRC has uncommitted changes to tracked files; commit them, or pass --allow-dirty"
  COMMIT="$COMMIT+dirty"
fi
VERSION=$(sed -n "s/^export const ADAPTER_VERSION = '\(.*\)';/\1/p" "$SRC/packages/adapter/src/adapter.mjs")
[[ -n "$VERSION" ]] || die "could not read ADAPTER_VERSION from $SRC"
OLD=$(cat "$DEST/DEPLOYED" 2>/dev/null | head -n 1 || true)
ok "deploying $COMMIT (adapter $VERSION) from $SRC to $DEST${OLD:+ (currently: $OLD)}"
ok "units: $ADAPTER_UNIT, $GATEWAY_UNIT; signers: ${SIGNER_UNITS:-none}$([[ $RESTART_SIGNERS == 1 ]] || echo ' (not restarted)')"

RSYNC=(rsync -a --delete --exclude /.git --exclude /state --exclude node_modules --exclude /docs/report --exclude /DEPLOYED)
if [[ $DRY_RUN == 1 ]]; then
  step "dry run: files that would change in $DEST"
  "${RSYNC[@]}" -n -i "$SRC/" "$DEST/" | sed -n '1,200p'
  echo; echo "dry run: nothing was changed"
  exit 0
fi

# --- 2. backup ----------------------------------------------------------------------------------------------------
step "backup"
BACKUP="$DEST.bak-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$DEST" "$BACKUP"
ok "$BACKUP"
# shellcheck disable=SC2012 # names are ours: <dest>.bak-<timestamp>, sorted oldest first
ls -1d "$DEST".bak-* 2>/dev/null | sort | head -n -"$KEEP_BACKUPS" | while read -r old; do rm -rf -- "$old"; ok "pruned $old"; done

DEPLOY_STARTED=0
rollback() {
  local code=$?
  [[ $DEPLOY_STARTED == 1 ]] || exit "$code"
  printf '\nFAIL  deploy failed; restoring %s from %s\n' "$DEST" "$BACKUP" >&2
  rsync -a --delete "$BACKUP/" "$DEST/" || echo "FAIL  restore failed; restore $BACKUP by hand" >&2
  systemctl daemon-reload || true
  for unit in "$GATEWAY_UNIT" "$ADAPTER_UNIT"; do systemctl restart "$unit.service" || true; done
  systemctl --no-pager --lines=0 status "$GATEWAY_UNIT" "$ADAPTER_UNIT" >&2 || true
  echo "the previous copy is restored; the escalations drop-in ($DROPIN) is left in place (harmless to an older adapter)" >&2
  exit "$code"
}
trap rollback EXIT
DEPLOY_STARTED=1

# --- 3. copy + install --------------------------------------------------------------------------------------------
step "copy"
"${RSYNC[@]}" "$SRC/" "$DEST/"
ok "code copied"
step "npm ci"
(cd "$DEST" && npm ci --no-audit --no-fund)
DEPLOYED_VERSION=$(sed -n "s/^export const ADAPTER_VERSION = '\(.*\)';/\1/p" "$DEST/packages/adapter/src/adapter.mjs")
[[ "$DEPLOYED_VERSION" == "$VERSION" ]] || die "$DEST has adapter $DEPLOYED_VERSION after the copy, expected $VERSION"
ok "adapter $DEPLOYED_VERSION; $(cd "$DEST" && for p in node_modules/@metamynd/agentsafe-*/package.json; do node -p "require('./$p').name.replace('@metamynd/','') + ' ' + require('./$p').version"; done | tr '\n' ',' | sed 's/,$//; s/,/, /g')"

# --- 4. adapter escalations file ----------------------------------------------------------------------------------
step "escalations file"
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0750 "$ESCALATIONS_DIR"
WANT=$(printf '[Service]\nEnvironment=ADAPTER_ESCALATIONS=%s/escalations.json\n' "$ESCALATIONS_DIR")
if [[ "$(cat "$DROPIN" 2>/dev/null || true)" != "$WANT" ]]; then
  mkdir -p "$DROPIN_DIR"
  printf '%s\n' "$WANT" > "$DROPIN"
  ok "wrote $DROPIN"
else
  ok "$DROPIN is current"
fi
systemctl daemon-reload

# --- 5. restart ---------------------------------------------------------------------------------------------------
wait_ready() { # <unit> <since>: active, and logged "listening" since <since>
  local unit=$1 since=$2
  for _ in $(seq 1 "$READY_TIMEOUT_S"); do
    if systemctl is-active --quiet "$unit.service" \
      && journalctl -u "$unit.service" --since "$since" --no-pager -o cat 2>/dev/null | grep -qE 'listening'; then
      ok "$unit is up"
      return 0
    fi
    sleep 1
  done
  journalctl -u "$unit.service" --since "$since" --no-pager -n 30 >&2 || true
  die "$unit did not come up within ${READY_TIMEOUT_S}s"
}

step "restart"
if [[ $RESTART_SIGNERS == 1 && -n "${SIGNER_UNITS// /}" ]]; then
  # shellcheck disable=SC2086 # a space-separated list of unit names
  systemctl restart $SIGNER_UNITS
  sleep 2
  # shellcheck disable=SC2086
  systemctl is-active --quiet $SIGNER_UNITS || die "a signer did not come back: $(systemctl is-active $SIGNER_UNITS | tr '\n' ' ')"
  ok "signers restarted: $SIGNER_UNITS"
fi
for unit in "$GATEWAY_UNIT" "$ADAPTER_UNIT"; do
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl restart "$unit.service"
  wait_ready "$unit" "$since"
done
if journalctl -u "$ADAPTER_UNIT.service" --since "$since" --no-pager -o cat | grep -q 'escalations_'; then
  journalctl -u "$ADAPTER_UNIT.service" --since "$since" --no-pager -o cat | grep 'escalations_' >&2
  die "the adapter cannot read or write $ESCALATIONS_DIR/escalations.json"
fi

# --- 6. record ----------------------------------------------------------------------------------------------------
printf '%s adapter %s deployed %s from %s\n' "$COMMIT" "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SRC" > "$DEST/DEPLOYED"
DEPLOY_STARTED=0
trap - EXIT
step "done"
ok "$(cat "$DEST/DEPLOYED")"
ok "rollback, if needed: rsync -a --delete $BACKUP/ $DEST/ && systemctl restart $GATEWAY_UNIT $ADAPTER_UNIT"
