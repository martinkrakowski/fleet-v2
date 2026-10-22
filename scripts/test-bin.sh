#!/bin/sh
# Runs every tests/*.test.sh via `sh`, in sorted order, stopping at the first
# failure with that test's exit code. Exits 1 when no test file matches.
# Run from the repository root or anywhere.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# --- runner script pins (M2): the bundled bin/ocm-run and bin/agy-run must
# --- match the hashes in scripts/*-hash.txt, or an unpinned runner ships and
# --- the onboarding doctor reports hash FAIL on every installation. The shape
# --- is the bootstrap suite's pin check: sha256 of the script compared with the
# --- first field of its hash file, and the hash file names the script.
check_pin() { # $1: script path, $2: hash file path
  [ -f "$root/$2" ] || { echo "test-bin: missing pin file $2" >&2; return 1; }
  sum=$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$root/$1" || shasum -a 256 "$root/$1") | cut -c1-64 )
  read -r want pinjunk < "$root/$2" || true
  if [ -z "$want" ] || [ "$sum" != "$want" ]; then
    echo "test-bin: pin FAIL for $1 (got ${sum:-<none>}, want ${want:-<empty>})" >&2
    return 1
  fi
  # The pin line's path field must be exactly $1, not merely contain it (Grok review of L2).
  awk -v f="$1" '$2 == f { found = 1 } END { exit !found }' "$root/$2" || { echo "test-bin: pin file $2 does not name $1" >&2; return 1; }
  echo "test-bin: pin ok $1"
}
check_pin bin/ocm-run scripts/ocm-run-hash.txt
check_pin bin/agy-run scripts/agy-run-hash.txt

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
