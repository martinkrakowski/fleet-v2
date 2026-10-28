#!/bin/sh
# Tests for scripts/test-bin.sh --shard <i>/<n> (A-R1): every tests/*.test.sh lands in exactly one
# shard for every n, the split is the bytewise-sorted list taken index modulo n, a shard that
# selects nothing fails, and malformed arguments are usage errors (exit 2). It calls the script
# only with --list or with arguments the parser refuses, so it never runs a test file itself
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
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
run() { "$RUNSH" "$SCRIPT" "$@" > "$T/o" 2> "$T/e"; echo $? > "$T/rc"; }
rc() { cat "$T/rc"; }

(cd "$here" && for t in tests/*.test.sh; do printf '%s\n' "$t"; done) | LC_ALL=C sort > "$T/all"
total=$(wc -l < "$T/all" | tr -d ' ')
check 'the repository has test files to shard' '[ "$total" -ge 2 ]'

n=1
while [ "$n" -le "$total" ]; do
  : > "$T/union"
  i=1
  shard_ok=1
  while [ "$i" -le "$n" ]; do
    run --shard "$i/$n" --list
    [ "$(rc)" = 0 ] || shard_ok=0
    # The expected members of shard i: the sorted list's 0-based index k with k mod n = i - 1.
    awk -v n="$n" -v i="$i" '(NR - 1) % n == i - 1' "$T/all" > "$T/want"
    cmp -s "$T/o" "$T/want" || shard_ok=0
    cat "$T/o" >> "$T/union"
    i=$((i + 1))
  done
  check "n=$n: every shard lists exactly its index-modulo-n files" '[ "$shard_ok" = 1 ]'
  check "n=$n: the shards together list every file exactly once" 'LC_ALL=C sort "$T/union" | cmp -s - "$T/all"'
  n=$((n + 1))
done

run --shard=2/3 --list
check '--shard=<i>/<n> is the same as --shard <i>/<n>' '[ "$(rc)" = 0 ] && awk "(NR - 1) % 3 == 1" "$T/all" | cmp -s - "$T/o"'

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
