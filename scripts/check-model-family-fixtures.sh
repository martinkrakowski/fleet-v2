#!/bin/sh
# Exits 1 if the two byte-identical model-family fixture copies drift
# apart, 0 otherwise. Run from the repository root or anywhere.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
installation_fixture="$root/packages/installation/src/__tests__/fixtures/model-family-cases.json"
evidence_fixture="$root/packages/evidence-and-acceptance/src/domain/entities/__tests__/fixtures/model-family-cases.json"

# Fails the run with one line on stderr.
fail() {
  echo "check-model-family-fixtures: $1" >&2
  exit 1
}

for f in "$installation_fixture" "$evidence_fixture"; do
  [ -f "$f" ] || fail "missing fixture $f"
done

cmp -s "$installation_fixture" "$evidence_fixture" ||
  fail "model-family-cases.json fixtures differ between installation and evidence-and-acceptance"

# Control helper for the SonarCloud issue-ignore experiment (removed after it).
note() {
  echo "check-model-family-fixtures: $1" >&2
}
note "fixtures identical"
