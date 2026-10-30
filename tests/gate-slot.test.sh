#!/bin/sh
# Tests for bin/gate-slot. Real flock(1) on lock files in a temp dir; nothing touches /tmp's
# shared slot files. Skips (exit 0) when flock is not installed, as on stock macOS.
# Run it as `sh`, `dash` or `zsh tests/gate-slot.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/bin/gate-slot
if ! command -v flock >/dev/null 2>&1; then
  echo 'skip gate-slot tests: flock is not installed'
  exit 0
fi
T=$(mktemp -d "${TMPDIR:-/tmp}/gate-slot-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
holder=''
finish() {
  [ -n "$holder" ] && kill "$holder" 2>/dev/null
  rm -rf "$T"
}
trap finish EXIT
run() { env FLEET_V2_GATE_LOCK_DIR="$T" FLEET_V2_GATE_POLL_SECONDS=1 "$@"; }

# Usage and setup errors exit 2 and run nothing.
sh "$SCRIPT" >/dev/null 2>&1; [ $? -eq 2 ] && ok 'no command is a usage error' || bad 'no command is a usage error'
for v in 0 abc 07 -1; do
  rm -f "$T/ran"
  run env FLEET_V2_GATE_SLOTS=$v sh "$SCRIPT" touch "$T/ran" >/dev/null 2>&1
  rc=$?
  if [ $rc -eq 2 ] && [ ! -e "$T/ran" ]; then ok "slots '$v' refused"; else bad "slots '$v' refused (rc $rc)"; fi
done
out=$(run env FLEET_V2_GATE_SLOTS= sh "$SCRIPT" sh -c 'echo "$FLEET_V2_GATE_SLOT"')
[ "$out" = 1 ] && ok 'an empty slot count means the default' || bad "an empty slot count means the default ($out)"
for v in x 0 00 05; do
  env FLEET_V2_GATE_POLL_SECONDS=$v FLEET_V2_GATE_LOCK_DIR="$T" sh "$SCRIPT" true >/dev/null 2>&1
  [ $? -eq 2 ] && ok "poll interval '$v' refused" || bad "poll interval '$v' refused"
done
FLEET_V2_GATE_LOCK_DIR=$T/missing sh "$SCRIPT" true >/dev/null 2>&1
[ $? -eq 2 ] && ok 'a missing lock dir is refused' || bad 'a missing lock dir is refused'

# The command runs with its arguments intact and its exit code is returned unchanged.
out=$(run sh "$SCRIPT" printf '%s|' 'a b' "c'd" 2>&1)
[ "$out" = "a b|c'd|" ] && ok 'arguments pass through intact' || bad "arguments pass through intact ($out)"
run sh "$SCRIPT" sh -c 'exit 7' >/dev/null 2>&1
[ $? -eq 7 ] && ok 'exit code is returned unchanged' || bad 'exit code is returned unchanged'

# The slot number and TMPDIR reach the command.
out=$(run env FLEET_V2_GATE_SLOTS=3 sh "$SCRIPT" sh -c 'echo "$FLEET_V2_GATE_SLOT"')
[ "$out" = 1 ] && ok 'the first free slot is taken' || bad "the first free slot is taken ($out)"
mkdir "$T/tmp"
out=$(run env FLEET_V2_GATE_TMPDIR=$T/tmp sh "$SCRIPT" sh -c 'echo "$TMPDIR"')
[ "$out" = "$T/tmp" ] && ok 'FLEET_V2_GATE_TMPDIR becomes TMPDIR' || bad "FLEET_V2_GATE_TMPDIR becomes TMPDIR ($out)"

# A held slot is skipped; with every slot held the command waits until one is released.
: > "$T/fleet-v2-gate-slot.1"
flock "$T/fleet-v2-gate-slot.1" sleep 3 &
holder=$!
sleep 0.5 2>/dev/null || sleep 1
out=$(run env FLEET_V2_GATE_SLOTS=2 sh "$SCRIPT" sh -c 'echo "$FLEET_V2_GATE_SLOT"')
[ "$out" = 2 ] && ok 'a held slot is skipped' || bad "a held slot is skipped ($out)"
start=$(date +%s)
out=$(run env FLEET_V2_GATE_SLOTS=1 sh "$SCRIPT" sh -c 'echo "$FLEET_V2_GATE_SLOT"')
waited=$(( $(date +%s) - start ))
if [ "$out" = 1 ] && [ "$waited" -ge 1 ]; then ok 'a full host waits for a released slot'; else bad "a full host waits for a released slot ($out after ${waited}s)"; fi
wait "$holder" 2>/dev/null
holder=''

# The slot is held for the command's whole life: a second caller cannot take it meanwhile.
run env FLEET_V2_GATE_SLOTS=1 sh "$SCRIPT" sleep 2 &
holder=$!
sleep 0.5 2>/dev/null || sleep 1
if flock -n "$T/fleet-v2-gate-slot.1" true; then bad 'the slot is held while the command runs'; else ok 'the slot is held while the command runs'; fi
wait "$holder" 2>/dev/null
holder=''

# The wait is bounded: with every slot held past the limit the script exits 75 with the fixed
# line and never runs the command; a slot that frees within the limit still runs it unchanged.
for v in x 0 00 05; do
  run env FLEET_V2_GATE_WAIT_MAX_SECONDS=$v sh "$SCRIPT" true >/dev/null 2>&1
  [ $? -eq 2 ] && ok "wait limit '$v' refused" || bad "wait limit '$v' refused"
done
: > "$T/fleet-v2-gate-slot.1"
flock "$T/fleet-v2-gate-slot.1" sleep 6 &
holder=$!
sleep 0.5 2>/dev/null || sleep 1
rm -f "$T/ran"
run env FLEET_V2_GATE_SLOTS=1 FLEET_V2_GATE_WAIT_MAX_SECONDS=2 sh "$SCRIPT" touch "$T/ran" 2>"$T/err"
rc=$?
if [ $rc -eq 75 ] && [ ! -e "$T/ran" ] && [ "$(cat "$T/err")" = 'gate-slot: no slot within the wait limit' ]; then
  ok 'a full host past the wait limit exits 75 with the fixed line and runs nothing'
else
  bad "a full host past the wait limit exits 75 with the fixed line and runs nothing (rc $rc)"
fi
wait "$holder" 2>/dev/null
holder=''
flock "$T/fleet-v2-gate-slot.1" sleep 2 &
holder=$!
sleep 0.5 2>/dev/null || sleep 1
run env FLEET_V2_GATE_SLOTS=1 FLEET_V2_GATE_WAIT_MAX_SECONDS=10 sh "$SCRIPT" sh -c 'exit 7' >/dev/null 2>&1
[ $? -eq 7 ] && ok 'a slot freed within the wait limit runs the command, exit code unchanged' || bad 'a slot freed within the wait limit runs the command, exit code unchanged'
wait "$holder" 2>/dev/null
holder=''

[ "$fails" -eq 0 ] && echo 'gate-slot: all tests passed' || echo "gate-slot: $fails failure(s)"
[ "$fails" -eq 0 ]
