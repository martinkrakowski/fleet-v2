#!/bin/sh
# Tests for scripts/test-bin.sh --shard <i>/<n> (A-R1, CI1): every tests/*.test.sh lands in exactly
# one shard for every n, the split is the deterministic greedy assignment balanced by the recorded
# per-file times (scripts/test-bin-timings.txt, 60-second fallback for a file absent from it), a
# shard that selects nothing fails, and malformed arguments are usage errors (exit 2). It calls the
# script only with --list or with arguments the parser refuses, so it never runs a test file itself
# (and never recurses into this file).
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/scripts/test-bin.sh
RUNSH=${TBS_TEST_SH:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/test-bin-shard-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { label=$1; condition=$2; if eval "$condition"; then ok "$label"; else bad "$label"; fi; }
run() { "$RUNSH" "$SCRIPT" "$@" > "$T/o" 2> "$T/e"; echo $? > "$T/rc"; }
rc() { cat "$T/rc"; }

(cd "$here" && for t in tests/*.test.sh; do printf '%s\n' "$t"; done) | LC_ALL=C sort > "$T/all"
total=$(wc -l < "$T/all" | tr -d ' ')
check 'the repository has test files to shard' '[ "$total" -ge 2 ]'

# The expected split, computed here in awk by mirroring the script's pure assignment step: files in
# descending recorded Linux duration (ties bytewise ascending), each to the shard with the smallest
# total so far, ties to the lowest shard number; a path absent from the timings table counts as 60
# seconds. Prints "<shard> <path>" for the shard passed as -v i_shard.
cat > "$T/expect.awk" <<'AWK'
BEGIN {
  while ((getline line < timings) > 0) {
    sub(/\r$/, "", line)
    if (line ~ /^[ \t]*(#|$)/) continue
    split(line, row, " ")
    if (row[1] != "") linux_sec[row[1]] = row[2] + 0
  }
  close(timings)
}
{ files[++fc] = $0 }
function earlier(a, b) {
  if (ldur[a] != ldur[b]) return ldur[a] > ldur[b]
  return files[a] < files[b]
}
END {
  for (k = 1; k <= fc; k++) {
    ldur[k] = (files[k] in linux_sec) ? linux_sec[files[k]] : 60
    order[k] = k
  }
  for (k = 1; k <= fc; k++) {
    for (j = k + 1; j <= fc; j++) {
      if (earlier(order[j], order[k])) {
        tmp = order[k]; order[k] = order[j]; order[j] = tmp
      }
    }
  }
  for (k = 1; k <= fc; k++) {
    idx = order[k]
    best = 1
    for (s = 2; s <= n; s++) if (load[s] + 0 < load[best] + 0) best = s
    load[best] += ldur[idx]
    assign[files[idx]] = best
  }
  # The script keeps the shard's files in the original bytewise order of the
  # input, so print in that order, not in assignment order.
  for (k = 1; k <= fc; k++) if (assign[files[k]] == i_shard) print files[k]
}
AWK
TIMINGS=$here/scripts/test-bin-timings.txt
expect() { # $1: shard i, $2: shard n, $3: timings file -> expected file list on stdout
  awk -v timings="$3" -v n="$2" -v i_shard="$1" -f "$T/expect.awk" "$T/all"
}

n=1
while [ "$n" -le "$total" ]; do
  : > "$T/union"
  i=1
  shard_ok=1
  while [ "$i" -le "$n" ]; do
    run --shard "$i/$n" --list
    [ "$(rc)" = 0 ] || shard_ok=0
    # The expected members of shard i: the greedy balanced split of the sorted list.
    expect "$i" "$n" "$TIMINGS" > "$T/want"
    cmp -s "$T/o" "$T/want" || shard_ok=0
    cat "$T/o" >> "$T/union"
    i=$((i + 1))
  done
  check "n=$n: every shard lists exactly its greedy balanced files" '[ "$shard_ok" = 1 ]'
  check "n=$n: the shards together list every file exactly once" 'LC_ALL=C sort "$T/union" | cmp -s - "$T/all"'
  n=$((n + 1))
done

run --shard=2/3 --list
check '--shard=<i>/<n> is the same as --shard <i>/<n>' '[ "$(rc)" = 0 ] && expect 2 3 "$TIMINGS" | cmp -s - "$T/o"'

# Fallback: a timings file naming one heavy file and none of the others (the heavy file is a path
# not among the tests, so every real test file is unknown) still yields a deterministic balanced
# split where every unknown file counts as the 60-second default.
HEAVY=tests/agy-run.test.sh
printf '# one known row, everything else falls back to 60s\n%s 999 999\n' "$HEAVY" > "$T/tim"
: > "$T/union"
n=2
i=1
fb_ok=1
FLEET_TEST_BIN_TIMINGS=$T/tim
export FLEET_TEST_BIN_TIMINGS
while [ "$i" -le "$n" ]; do
  run --shard "$i/$n" --list
  [ "$(rc)" = 0 ] || fb_ok=0
  expect "$i" "$n" "$T/tim" > "$T/want"
  cmp -s "$T/o" "$T/want" || fb_ok=0
  cp "$T/o" "$T/shard$i"
  cat "$T/o" >> "$T/union"
  i=$((i + 1))
done
unset FLEET_TEST_BIN_TIMINGS
check 'the 60-second fallback splits unknown files like 60s rows' '[ "$fb_ok" = 1 ]'
check 'the fallback split still covers every file exactly once' 'LC_ALL=C sort "$T/union" | cmp -s - "$T/all"'
check 'the fallback put the one heavy file alone in shard 1' '[ "$(wc -l < "$T/shard1" | tr -d " ")" = 1 ] && grep -qx "$HEAVY" "$T/shard1"'
FLEET_TEST_BIN_TIMINGS=$T/missing-timings
export FLEET_TEST_BIN_TIMINGS
run --shard 1/2 --list
unset FLEET_TEST_BIN_TIMINGS
check 'a missing FLEET_TEST_BIN_TIMINGS file is the fallback, never an error' '[ "$(rc)" = 0 ] && expect 1 2 /dev/null | cmp -s - "$T/o"'

# Comments and blank lines in the timings file are ignored: the same rows stripped of them give the
# identical assignment.
printf '# header\n\n%s 999 999   # trailing comment\n# another\n' "$HEAVY" > "$T/commented"
FLEET_TEST_BIN_TIMINGS=$T/commented
export FLEET_TEST_BIN_TIMINGS
run --shard 1/2 --list
cp "$T/o" "$T/commented-out"
FLEET_TEST_BIN_TIMINGS=$T/tim
run --shard 1/2 --list
unset FLEET_TEST_BIN_TIMINGS
check 'comment lines and blank lines in the timings file are ignored' '[ "$(rc)" = 0 ] && cmp -s "$T/o" "$T/commented-out"'

# The checked-in timings file names every test file in this checkout, so the real CI run never
# exercises the 60-second fallback.
missing=0
while read -r t; do
  grep -q "^$t " "$TIMINGS" || missing=$((missing + 1))
done < "$T/all"
check 'the checked-in timings file names every tests/*.test.sh' '[ "$missing" = 0 ]'

# Determinism: the same inputs print the same shard twice.
run --shard 1/4 --list
cp "$T/o" "$T/first"
run --shard 1/4 --list
check 'two runs of --list 1/4 print identical output' '[ "$(rc)" = 0 ] && cmp -s "$T/o" "$T/first"'

# Unsharded behaviour: the sort (and so the balanced assignment's fixed order) still applies only
# when sharded, per the script's source shape.
sharded_line=$(grep -n 'if \[ "\$sharded" = 1 \]; then' "$SCRIPT" | head -1 | cut -d: -f1)
sort_line=$(grep -n 'LC_ALL=C sort' "$SCRIPT" | head -1 | cut -d: -f1)
check 'the sort block still runs only when sharded' '[ -n "$sharded_line" ] && [ -n "$sort_line" ] && [ "$sharded_line" -lt "$sort_line" ]'

over=$((total + 1))
run --shard "$over/$over" --list
check 'a shard that selects no file exits 1 and says so' '[ "$(rc)" = 1 ] && grep -q "selects no test file" "$T/e"'

for bad_arg in '0/3' '4/3' 'a/3' '1/b' '1/0' '01/3' '1/03' '3' '/3' '1/' '-1/3' '1/3/2' '99999/99999'; do
  run --shard "$bad_arg" --list
  check "--shard $bad_arg is a usage error (exit 2)" '[ "$(rc)" = 2 ] && grep -q "^usage:" "$T/e" && [ ! -s "$T/o" ]'
done
run --shard
check '--shard with no value is a usage error' '[ "$(rc)" = 2 ]'
run --shard 1/3 --shard 2/3 --list
check 'a second --shard is a usage error' '[ "$(rc)" = 2 ]'
run --list
check '--list without --shard is a usage error' '[ "$(rc)" = 2 ]'
run --bogus
check 'an unknown argument is a usage error, and nothing runs' '[ "$(rc)" = 2 ] && [ ! -s "$T/o" ]'

echo
echo "$fails failed"
[ "$fails" = 0 ]
