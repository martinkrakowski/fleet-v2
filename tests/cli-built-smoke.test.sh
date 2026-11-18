#!/bin/sh
# Tests for the built CLI (HF1): `node apps/cli/dist/bin.js --help` must run
# under plain Node ESM and answer on stdout. An ERR_MODULE_NOT_FOUND from an
# extensionless relative import crashes at startup with a non-zero exit —
# exactly what this smoke test guards.
#
# The import-extension check (scripts/check-relative-import-extensions.mjs,
# run by tests/check-relative-import-extensions.test.sh) is the CI guard for
# this class of defect; this smoke test runs wherever the build has run (for
# example the gate on sol), so a missing build is a SKIP, not a failure —
# CI's shell shard never builds and must stay green.
#
# Fails (exit 1) when node is missing or the built CLI does not answer.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
BIN=$here/apps/cli/dist/bin.js
if ! command -v node >/dev/null 2>&1; then
  echo 'FAIL cli-built-smoke: node is not installed'
  exit 1
fi
if [ ! -f "$BIN" ]; then
  echo 'SKIP cli-built-smoke: apps/cli/dist/bin.js not built in this job'
  exit 0
fi
out_file=$(mktemp "${TMPDIR:-/tmp}/cli-built-smoke.XXXXXX") || exit 1
node "$BIN" --help >"$out_file" 2>"$out_file.err"
rc=$?
stdout=$(cat "$out_file")
rm -f "$out_file" "$out_file.err"
if [ "$rc" -ne 0 ]; then
  echo "FAIL cli-built-smoke: --help exited $rc"
  exit 1
fi
if [ -z "$stdout" ]; then
  echo 'FAIL cli-built-smoke: --help produced empty stdout'
  exit 1
fi
printf 'ok   cli-built-smoke: built CLI answers --help\n'
