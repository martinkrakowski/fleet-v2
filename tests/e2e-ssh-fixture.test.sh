#!/bin/sh
# Tests for tests/e2e/ssh-fixture.sh. Everything here is skipped unless
# FLEET_E2E_SSH=1; otherwise the whole file prints one skip line and exits 0.
# Run it as `sh tests/e2e-ssh-fixture.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/tests/e2e/ssh-fixture.sh

if [ "${FLEET_E2E_SSH:-0}" != 1 ]; then
  echo 'ok   skipped: FLEET_E2E_SSH is not 1'
  exit 0
fi

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

stopped=''
finish() {
  for d in $stopped; do
    sh "$SCRIPT" stop "$d" >/dev/null 2>&1 || true
  done
}
trap finish EXIT

# Parse the four FLEET_E2E_* lines (from stdin) into d/home/port/alias.
parse_fixture() {
  d=''
  home=''
  port=''
  alias=''
  count=0
  while IFS= read -r line; do
    count=$((count + 1))
    case "$line" in
      FLEET_E2E_DIR=*) d=${line#FLEET_E2E_DIR=} ;;
      FLEET_E2E_HOME=*) home=${line#FLEET_E2E_HOME=} ;;
      FLEET_E2E_PORT=*) port=${line#FLEET_E2E_PORT=} ;;
      FLEET_E2E_ALIAS=*) alias=${line#FLEET_E2E_ALIAS=} ;;
      *) bad "unexpected start line: $line" ;;
    esac
  done
  [ "$count" -eq 4 ] && ok 'start prints exactly four FLEET_E2E_* lines' || bad "start printed $count lines, want 4"
  [ -n "$d" ] && [ -d "$d" ] && ok 'FLEET_E2E_DIR is a directory' || bad 'FLEET_E2E_DIR is missing or not a directory'
  [ -n "$home" ] && [ -f "$home/.ssh/config" ] && ok 'FLEET_E2E_HOME has a client ssh config' || bad 'FLEET_E2E_HOME lacks .ssh/config'
  case "$port" in
    '' | *[!0-9]*) bad "FLEET_E2E_PORT is not a number ($port)" ;;
    *) ok "FLEET_E2E_PORT is a number ($port)" ;;
  esac
  [ "$alias" = fleet-e2e ] && ok 'FLEET_E2E_ALIAS is fleet-e2e' || bad "FLEET_E2E_ALIAS is $alias"
}

out=$(sh "$SCRIPT" start 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ok 'start exits 0' || bad "start exited $rc"
parse_fixture <<EOF
$out
EOF

# The first fixture must have been parsed before the hop and the stop tests.
if [ -z "$d" ] || [ -z "$home" ] || [ -z "$alias" ]; then
  echo "e2e-ssh-fixture: $fails failure(s)"
  [ "$fails" -eq 0 ]
  exit
fi

hop=$(HOME="$home" ssh -o BatchMode=yes "$alias" -- echo e2e-hello 2>&1)
[ "$hop" = e2e-hello ] && ok 'the ssh hop through the alias prints e2e-hello' || bad "the ssh hop printed: $hop"

out2=$(sh "$SCRIPT" start 2>&1)
rc2=$?
[ "$rc2" -eq 0 ] && ok 'a second start exits 0' || bad "second start exited $rc2"
d2=''
port2=''
while IFS= read -r line; do
  case "$line" in
    FLEET_E2E_DIR=*) d2=${line#FLEET_E2E_DIR=} ;;
    FLEET_E2E_PORT=*) port2=${line#FLEET_E2E_PORT=} ;;
  esac
done <<EOF
$out2
EOF
[ -n "$d2" ] && [ "$d2" != "$d" ] && ok 'a second start uses a different dir' || bad 'a second start reused the dir'
[ -n "$port2" ] && [ "$port2" != "$port" ] && ok 'a second start uses a different port' || bad 'a second start reused the port'
stopped="$stopped $d2"

pid=$(cat "$d/sshd.pid" 2>/dev/null || true)
sh "$SCRIPT" stop "$d" >/dev/null 2>&1
rc3=$?
[ "$rc3" -eq 0 ] && ok 'stop exits 0' || bad "stop exited $rc3"
if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
  ok 'stop leaves no sshd running'
else
  bad 'stop left the sshd running'
fi
[ ! -d "$d" ] && ok 'stop removes the fixture dir' || bad 'stop left the fixture dir behind'
stopped=''

# start with sshd hidden from PATH prints unavailable=no-sshd and exits 3.
oldifs=$IFS
IFS=:
set -- $PATH
IFS=$oldifs
clean_path=''
for p in "$@"; do
  [ -n "$p" ] || continue
  [ -x "$p/sshd" ] && continue
  clean_path=$clean_path:$p
done
clean_path=${clean_path#:}
out3=$(env PATH="$clean_path" sh "$SCRIPT" start 2>&1)
rc4=$?
[ "$rc4" -eq 3 ] && ok 'start with sshd hidden exits 3' || bad "start with sshd hidden exited $rc4"
[ "$out3" = 'unavailable=no-sshd' ] && ok 'start with sshd hidden prints unavailable=no-sshd' || bad "start with sshd hidden printed: $out3"

[ "$fails" -eq 0 ] && echo 'e2e-ssh-fixture: all tests passed' || echo "e2e-ssh-fixture: $fails failure(s)"
[ "$fails" -eq 0 ]
