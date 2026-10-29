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
FLEET_V2_GATE_POLL_SECONDS=x FLEET_V2_GATE_LOCK_DIR=$T sh "$SCRIPT" true >/dev/null 2>&1
[ $? -eq 2 ] && ok 'a bad poll interval is refused' || bad 'a bad poll interval is refused'
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

[ "$fails" -eq 0 ] && echo 'gate-slot: all tests passed' || echo "gate-slot: $fails failure(s)"
[ "$fails" -eq 0 ]
