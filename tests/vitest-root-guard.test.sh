#!/bin/sh
# Tests for the root vitest config guard (Q6a fix): it exports the projects and
# coverage block only when vitest runs from the repository root; from any other
# directory it exports {} so each workspace keeps its own CLI flags and Vitest's
# defaults. Before the guard, Vitest 4 searched upward from a workspace's cwd and
# loaded the root config, so `yarn workspace @fleet/shared test <file>` collected
# no files (project roots resolved against the workspace cwd) and still exited 0.
# Run it as `sh`, `dash` or `zsh tests/vitest-root-guard.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh # an unmatched glob must stay a word, as in sh
here=$(cd "$(dirname "$0")/.." && pwd)
VITEST=$here/node_modules/.bin/vitest
T=$(mktemp -d "${TMPDIR:-/tmp}/vitest-root-guard-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
finish() {
  rm -rf "$T"
}
trap finish EXIT

# The reported test-file count from a vitest run's summary ("Test Files  N passed").
files_count() {
  printf '%s\n' "$1" | sed -n 's/.*Test Files[[:space:]]*\([0-9][0-9]*\) passed.*/\1/p' | tail -n 1
}

check 'guard: the root vitest binary exists' '[ -x "$VITEST" ]'
check 'guard: the root vitest config exists' '[ -f "$here/vitest.config.ts" ]'
[ "$fails" = 0 ] || { echo "a guard is missing: stopping before any other check"; exit 1; }

# (a) from the repository root, `--project @fleet/shared` really runs host-name.test.ts.
out_a=$(cd "$here" && "$VITEST" run --project @fleet/shared --reporter=verbose 2>&1); rc_a=$?
count_a=$(files_count "$out_a")
check '(a) the root run reports at least one test file (not 0)' '[ "${count_a:-0}" -ge 1 ]'
check '(a) the root run actually runs host-name.test.ts' 'printf "%s\n" "$out_a" | grep -Fq "host-name.test.ts"'
check '(a) the root run exits 0' '[ "$rc_a" = 0 ]'

# (b) from packages/shared, `vitest run src/__tests__/host-name.test.ts` runs exactly that file.
out_b=$(cd "$here/packages/shared" && "$VITEST" run src/__tests__/host-name.test.ts --reporter=verbose 2>&1); rc_b=$?
count_b=$(files_count "$out_b")
check '(b) the workspace run reports exactly that one test file (count 1, not 0)' '[ "${count_b:-0}" = 1 ]'
check '(b) the workspace run runs host-name.test.ts' 'printf "%s\n" "$out_b" | grep -Fq "host-name.test.ts"'
check '(b) the workspace run exits 0' '[ "$rc_b" = 0 ]'

echo
echo "$(grep -o "check '" "$0" | wc -l | tr -d ' ') checks defined, $fails failed"
[ "$fails" = 0 ]
