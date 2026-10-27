#!/bin/sh
# Contract test for the pinned hexagen command-line tools (hexagen-integration plan, lane F1).
# It runs the INSTALLED binaries, node_modules/.bin/hexagen (@hexagen-monaco/sync) and
# node_modules/.bin/hexagen-lint (@hexagen-monaco/arch-linter), each at the exact version the root
# package.json pins, on two fixtures under tests/fixtures/hexagen-contract/:
#   compliant/  one bounded context with one pure domain file;
#   violation/  the same, plus a domain file that imports a Node builtin.
# It asserts the contract fleet-v2 relies on, as of 0.14.0, and nothing more:
#   - hexagen arch validate (yarn lint:arch, the CI gate): exit 0 compliant, 1 violation. Only
#     the exit code is read, never the human-readable text;
#   - hexagen-lint --json (the evidence command): exactly one JSON line on stdout holding the keys
#     fresh, baselined, stale, expired, introduced, baselineGrowth and filesScanned; exit 0
#     compliant, 1 violation, 2 could not run (a missing root). Extra keys are ignored on purpose:
#     0.15.0 adds schemaVersion and arch validate --json, and an addition must not fail this test;
#   - hexagen sync --check (yarn sync:check): exit 0 on this repository, which CI keeps converged,
#     and 1 on a tree whose generated files do not exist yet.
# The fixtures are only read by the pinned tools; nothing in them is ever run.
# Run it as `sh`, `dash` or `zsh tests/hexagen-contract.test.sh`, after `yarn install`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
FIX=$here/tests/fixtures/hexagen-contract
HEXAGEN=$here/node_modules/.bin/hexagen
HEXAGEN_LINT=$here/node_modules/.bin/hexagen-lint
# hexagen-lint prefers HEXAGEN_ROOT to its own search for a root, and DEBUG adds lines to stdout.
unset HEXAGEN_ROOT DEBUG
T=$(mktemp -d "${TMPDIR:-/tmp}/hexagen-contract-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
: > "$T/e"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
# On a failure the first 20 lines of the last captured stderr are shown, indented, to say why.
check() { if eval "$2"; then ok "$1"; else bad "$1"; sed -n '1,20p' "$T/e" | sed 's/^/    /'; fi; }
run_in() { # run_in <dir> <command> [args...]: run from <dir>; keep stdout, stderr and exit code
  rdir=$1
  shift
  ( cd "$rdir" && exec "$@" ) > "$T/o" 2> "$T/e"
  echo $? > "$T/rc"
}
rc() { cat "$T/rc"; }
json() { node "$T/contract.cjs" "$1" "$T/o" 2> "$T/e"; } # json compliant|violation
snapshot() { ( cd "$1" && find . -type f -exec cksum {} + | LC_ALL=C sort ); }

echo '# preconditions'
for b in "$HEXAGEN" "$HEXAGEN_LINT"; do
  if [ ! -x "$b" ]; then
    printf 'FAIL %s is missing: run yarn install at the repository root first\n' "$b"
    exit 1
  fi
done
if ! command -v node > /dev/null 2>&1; then
  echo 'FAIL node is not on PATH'
  exit 1
fi

# The JSON checks, in one helper the test writes and runs itself (no fixture code is run).
cat > "$T/contract.cjs" <<'JS'
"use strict";
// node contract.cjs pin <repository root>
// node contract.cjs compliant|violation <file holding hexagen-lint --json stdout>
// Exit 0 when the check holds; otherwise one reason on stderr and exit 1.
const fs = require("fs");
const path = require("path");
const [mode, arg] = process.argv.slice(2);
function fail(reason) {
  process.stderr.write("contract: " + reason + "\n");
  process.exit(1);
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
if (mode === "pin") {
  const pins = readJson(path.join(arg, "package.json")).devDependencies || {};
  for (const name of ["@hexagen-monaco/sync", "@hexagen-monaco/arch-linter"]) {
    const pin = pins[name];
    if (typeof pin !== "string" || !/^\d+\.\d+\.\d+$/.test(pin)) {
      fail(name + " is not pinned to an exact version in package.json devDependencies");
    }
    const installed = readJson(path.join(arg, "node_modules", name, "package.json")).version;
    if (installed !== pin) fail(name + " is installed at " + installed + " but pinned at " + pin);
  }
  process.exit(0);
}
if (mode !== "compliant" && mode !== "violation") fail("unknown mode " + mode);
const lines = fs.readFileSync(arg, "utf8").split("\n").filter((l) => l.trim() !== "");
if (lines.length !== 1) fail("expected exactly one non-empty stdout line, got " + lines.length);
let report;
try {
  report = JSON.parse(lines[0]);
} catch (e) {
  fail("the stdout line is not JSON (" + e.message + ")");
}
if (report === null || typeof report !== "object" || Array.isArray(report)) {
  fail("the JSON line is not an object");
}
// The 0.14.0 keys. Any other key (0.15.0 adds schemaVersion) is ignored on purpose.
for (const key of ["fresh", "baselined", "stale", "expired", "introduced", "baselineGrowth"]) {
  if (!Array.isArray(report[key])) fail("key " + key + " is missing or not an array");
}
if (!Number.isInteger(report.filesScanned) || report.filesScanned < 1) {
  fail("filesScanned is missing or not a positive integer");
}
// Neither fixture has a baseline file and neither run passes --pr-diff, so these stay empty.
for (const key of ["baselined", "stale", "expired", "introduced", "baselineGrowth"]) {
  if (report[key].length !== 0) fail("key " + key + " should be empty, has " + report[key].length);
}
if (mode === "compliant" && report.fresh.length !== 0) {
  fail("the compliant fixture has " + report.fresh.length + " fresh finding(s)");
}
if (mode === "violation") {
  if (report.fresh.length < 1) fail("the violation fixture has no fresh finding");
  for (const f of report.fresh) {
    if (f === null || typeof f.rule !== "string" || typeof f.file !== "string") {
      fail("a fresh finding lacks a string rule or file");
    }
  }
  if (!report.fresh.some((f) => f.file === "packages/orders/src/domain/clock.ts")) {
    fail("no fresh finding names packages/orders/src/domain/clock.ts");
  }
}
process.exit(0);
JS

node "$T/contract.cjs" pin "$here" > "$T/o" 2> "$T/e"; echo $? > "$T/rc"
check 'both tools are installed at exactly the version package.json pins' '[ "$(rc)" = 0 ]'
before=$(snapshot "$FIX")

echo '# hexagen arch validate (yarn lint:arch, the gate CI runs)'
run_in "$FIX/compliant" "$HEXAGEN" arch validate
check 'arch validate exits 0 on the compliant fixture' '[ "$(rc)" = 0 ]'
run_in "$FIX/violation" "$HEXAGEN" arch validate
check 'arch validate exits 1 on the violation fixture' '[ "$(rc)" = 1 ]'

echo '# hexagen-lint --json (the evidence command)'
run_in "$here" "$HEXAGEN_LINT" --json --root "$FIX/compliant"
check 'hexagen-lint --json exits 0 on the compliant fixture' '[ "$(rc)" = 0 ]'
check 'it prints one JSON line with the 0.14.0 keys and no finding' 'json compliant'
run_in "$here" "$HEXAGEN_LINT" --json --root "$FIX/violation"
check 'hexagen-lint --json exits 1 on the violation fixture' '[ "$(rc)" = 1 ]'
check 'it prints one JSON line whose fresh findings name the domain file' 'json violation'
run_in "$here" "$HEXAGEN_LINT" --json --root "$T/no-such-root"
check 'a missing root exits 2 (could not run), neither a pass nor a violation' '[ "$(rc)" = 2 ]'

echo '# hexagen sync --check (yarn sync:check, the drift gate)'
run_in "$here" "$HEXAGEN" sync --check --allow-dirty
check 'sync --check exits 0 on this repository, which CI keeps converged' '[ "$(rc)" = 0 ]'
# A tree outside the repository holding the compliant fixture and none of the generated files.
# It needs its own package.json with workspaces: without one, sync walks up from its own install
# directory, finds this repository's package.json and would check this repository instead.
D=$T/drift
mkdir -p "$D" && cp -R "$FIX/compliant/." "$D/" || exit 1
printf '{ "name": "contract-fixture", "private": true, "workspaces": ["packages/*"] }\n' > "$D/package.json"
drift_before=$(snapshot "$D")
run_in "$D" "$HEXAGEN" sync --check --allow-dirty
check 'sync --check exits 1 on a tree whose generated files do not exist yet' '[ "$(rc)" = 1 ]'
check 'that exit is drift, not a crash, a missing manifest or a failed generator' '! grep -q -e "Fatal sync error" -e "Sync incomplete" -e "Manifest not found" "$T/e"'
check 'sync --check wrote nothing into that tree' '[ "$(snapshot "$D")" = "$drift_before" ]'

echo '# the fixtures'
check 'no tool wrote into tests/fixtures/hexagen-contract' '[ "$(snapshot "$FIX")" = "$before" ]'

echo
echo "$(grep -c "^[[:space:]]*check '" "$self") checks defined, $fails failed"
[ "$fails" = 0 ]
