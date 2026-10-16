#!/bin/sh
# Exits 1 if the two byte-identical model-family fixture copies drift
# apart, 0 otherwise. Run from the repository root or anywhere.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
installation_fixture="$root/packages/installation/src/__tests__/fixtures/model-family-cases.json"
evidence_fixture="$root/packages/evidence-and-acceptance/src/domain/entities/__tests__/fixtures/model-family-cases.json"

if ! cmp -s "$installation_fixture" "$evidence_fixture"; then
  echo "model-family-cases.json fixtures differ between installation and evidence-and-acceptance" >&2
  exit 1
fi