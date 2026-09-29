#!/usr/bin/env bash
# M0 host checks (build plan step 0.2, spike S1) for running OpenShell v0.1.2 under WSL2 (or a Linux VM).
# Prints one line per check and exits non-zero if any required check fails.
set -uo pipefail

fail=0
pass() { printf 'ok    %s\n' "$1"; }
warn() { printf 'warn  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

if grep -qi microsoft /proc/version 2>/dev/null; then
  pass "running under WSL2"
else
  warn "not WSL2; fine for a Linux VM or cloud host"
fi

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] \
    && pass "Ubuntu 24.04" || warn "distro is ${PRETTY_NAME:-unknown}; the scope assumes Ubuntu 24.04"
fi

[[ "$(ps -p 1 -o comm= 2>/dev/null)" == systemd ]] \
  && pass "systemd is PID 1" || bad "systemd is not PID 1 (set [boot] systemd=true in /etc/wsl.conf)"

kernel="$(uname -r | cut -d- -f1)"
version_ge "$kernel" 6.2 && pass "kernel $kernel >= 6.2" || bad "kernel $kernel < 6.2 (run 'wsl --update')"

if lsm="$(cat /sys/kernel/security/lsm 2>/dev/null)"; then
  [[ ",$lsm," == *,landlock,* ]] && pass "landlock in active LSMs" || bad "landlock not in /sys/kernel/security/lsm ($lsm)"
else
  warn "/sys/kernel/security/lsm unreadable; relying on the ABI probe below"
fi

if command -v python3 >/dev/null; then
  abi="$(python3 - <<'PY'
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
# landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)
print(libc.syscall(444, None, 0, 1))
PY
)"
  [[ "$abi" =~ ^[0-9]+$ ]] && (( abi >= 3 )) \
    && pass "landlock ABI $abi >= 3" || bad "landlock ABI ${abi:-unknown} < 3"
else
  warn "python3 missing; landlock ABI not checked"
fi

seccomp="$(grep -E '^Seccomp:' /proc/self/status 2>/dev/null | awk '{print $2}')"
[[ -n "$seccomp" ]] && [[ -e /proc/sys/kernel/seccomp/actions_avail ]] \
  && pass "seccomp available ($(tr '\n' ' ' </proc/sys/kernel/seccomp/actions_avail))" \
  || bad "seccomp filter support not found"

if command -v docker >/dev/null; then
  dv="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  if [[ -z "$dv" ]]; then
    bad "docker CLI present but the daemon is unreachable"
  else
    version_ge "$dv" 28.0.0 && pass "docker $dv >= 28" || bad "docker $dv < 28"
  fi
else
  bad "docker not installed"
fi

if command -v node >/dev/null; then
  nv="$(node -p 'process.versions.node')"
  version_ge "$nv" 22.0.0 && pass "node $nv >= 22" || bad "node $nv < 22"
else
  bad "node not installed"
fi

command -v openshell >/dev/null \
  && pass "openshell CLI: $(openshell --version 2>/dev/null | head -n1)" \
  || warn "openshell CLI not installed yet (pin v0.1.2)"

exit $fail
