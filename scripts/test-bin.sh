#!/bin/sh
# Runs every tests/*.test.sh via `sh`, in sorted order, stopping at the first
# failure with that test's exit code. Exits 1 when no test file matches.
# Run from the repository root or anywhere.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

count=0
for t in tests/*.test.sh; do
  if [ ! -e "$t" ]; then
    echo "test-bin: no tests/*.test.sh found under $root/tests" >&2
    exit 1
  fi
  echo "== $t"
  status=0
  sh "$t" || status=$?
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
  count=$((count + 1))
done

echo "test-bin: $count test file(s) passed"
