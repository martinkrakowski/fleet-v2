#!/bin/sh
# Tests for scripts/s1-replay.mjs (S1U5). Each case states its assertion and
# runs the tool over the synthetic fixtures under tests/fixtures/s1-replay/.
# Refusals must exit 2 with nothing on stdout. Skips (exit 0) when node or
# yarn is missing. Builds @fleet/work-execution first when its dist is absent.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/scripts/s1-replay.mjs
FIX=$here/tests/fixtures/s1-replay
DIST=$here/packages/work-execution/dist/index.js

if ! command -v node >/dev/null 2>&1; then
  echo 'skip s1-replay tests: node is not installed'
  exit 0
fi

if [ ! -f "$DIST" ]; then
  echo 'building: yarn turbo run build --filter=@fleet/work-execution'
  yarn turbo run build --filter=@fleet/work-execution || {
    echo 'FAIL could not build @fleet/work-execution'
    exit 1
  }
fi

T=$(mktemp -d "${TMPDIR:-/tmp}/s1-replay-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
finish() { rm -rf "$T"; }
trap finish EXIT

DIGEST=0f1e2d3c4b5a
DAY=2026-03-01

run() { # remaining args = tool args; sets rc, stdout, stderr
  out_file=$T/run.out
  err_file=$T/run.err
  node "$SCRIPT" "$@" >"$out_file" 2>"$err_file"
  rc=$?
  stdout=$(cat "$out_file")
  stderr=$(cat "$err_file")
}

expect_pass() { # $1 label, $2 expected rc, then tool args
  label=$1
  want_rc=$2
  shift 2
  run "$@"
  if [ "$rc" -ne "$want_rc" ]; then
    bad "$label (rc $rc, want $want_rc)"
    return
  fi
  if [ "$want_rc" -eq 2 ]; then
    if [ -n "$stdout" ]; then
      bad "$label (refusal printed stdout)"
      return
    fi
    if [ -z "$stderr" ]; then
      bad "$label (refusal printed nothing on stderr)"
      return
    fi
    ok "$label"
    return
  fi
  case $stdout in
    *'"status":"pass"'*)
      ok "$label"
      ;;
    *)
      bad "$label (stdout did not report pass: $stdout)"
      ;;
  esac
}

expect_fail() { # $1 label, $2 reason substring, then tool args
  label=$1
  reason=$2
  shift 2
  run "$@"
  if [ "$rc" -ne 1 ]; then
    bad "$label (rc $rc, want 1)"
    return
  fi
  case $stdout in
    *'"status":"fail"'*) : ;;
    *) bad "$label (stdout did not report fail: $stdout)"; return ;;
  esac
  case $stdout in
    *"\"reason\":\"$reason\""*) : ;;
    *) bad "$label (stdout did not report reason $reason: $stdout)"; return ;;
  esac
  ok "$label"
}

# (0) --events mode with batch exclusion and synthesis passes; bare events mode fails.
expect_pass 'events mode excludes batch merges and synthesizes would-merge rows' 0 \
  --events "$FIX/events-with-batch.jsonl" --day "$DAY" --repo-digest "$DIGEST" \
  --exclude-batch-merges --synthesize-before-merge 1
run --events "$FIX/events-with-batch.jsonl" --day "$DAY" --repo-digest "$DIGEST" \
  --exclude-batch-merges --synthesize-before-merge 1
case $stdout in
  *'"excludedBatchMerges":2'*) ok 'events mode reports both batch merges excluded' ;;
  *) bad 'events mode reports both batch merges excluded (stdout: '"$stdout"')' ;;
esac
expect_fail 'events mode without exclusion or synthesis fails' merge-set-divergence \
  --events "$FIX/events-with-batch.jsonl" --day "$DAY" --repo-digest "$DIGEST"

# (1) A day with merges but no fleet rows diverges.
expect_fail 'snapshot without fleet rows reports merge-set-divergence' merge-set-divergence \
  --input "$FIX/day-without-fleet-rows.json"

# (2) Synthesis one second before each merge makes it pass.
expect_pass 'snapshot with synthesis 1s before merges passes' 0 \
  --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge 1

# (3) Synthesis at zero offset still records at the merge second: passes.
expect_pass 'snapshot with synthesis 0s before merges passes' 0 \
  --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge 0

# (4) Synthesis after the merge (-1) is a fleet-recorded-after-merge failure.
expect_fail 'snapshot with synthesis -1s fails as recorded after merge' merge-set-divergence \
  --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge -1

# (5) The batch-day snapshot excludes exactly the one batch-member merge.
expect_pass 'batch-day snapshot passes and excludes one batch merge' 0 \
  --input "$FIX/day-with-batch.json" --synthesize-before-merge 1
run --input "$FIX/day-with-batch.json" --synthesize-before-merge 1
case $stdout in
  *'"excludedBatchMerges":1'*) ok 'batch-day snapshot reports excludedBatchMerges 1' ;;
  *) bad 'batch-day snapshot reports excludedBatchMerges 1 (stdout: '"$stdout"')' ;;
esac

# (6) The input file checksum is unchanged by a synthesizing run.
before=$(cksum "$FIX/day-without-fleet-rows.json")
run --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge 1
after=$(cksum "$FIX/day-without-fleet-rows.json")
if [ "$before" = "$after" ]; then
  ok 'input file checksum unchanged after synthesis run'
else
  bad 'input file checksum unchanged after synthesis run'
fi

# (7) Every refusal exits 2 with nothing on stdout and a message on stderr.
printf '{"day":"2026-03-01","repoDigest":"0f1e2d3c4b5a"}' >"$T/malformed-snapshot.json"
printf 'not json' >"$T/not-json.json"
printf 'null' >"$T/null.json"
printf '[1,2]' >"$T/array.json"
printf '42' >"$T/primitive.json"
expect_pass 'refusal: no mode flag' 2
expect_pass 'refusal: --input and --events together' 2 \
  --input "$FIX/day-without-fleet-rows.json" --events "$FIX/events-with-batch.jsonl"
expect_pass 'refusal: --events without --day' 2 \
  --events "$FIX/events-with-batch.jsonl" --repo-digest "$DIGEST"
expect_pass 'refusal: --events without --repo-digest' 2 \
  --events "$FIX/events-with-batch.jsonl" --day "$DAY"
expect_pass 'refusal: --input with --day' 2 \
  --input "$FIX/day-without-fleet-rows.json" --day "$DAY"
expect_pass 'refusal: --input with --repo-digest' 2 \
  --input "$FIX/day-without-fleet-rows.json" --repo-digest "$DIGEST"
expect_pass 'refusal: --input with --exclude-batch-merges' 2 \
  --input "$FIX/day-without-fleet-rows.json" --exclude-batch-merges
expect_pass 'refusal: unknown flag' 2 --input "$FIX/day-without-fleet-rows.json" --wat
expect_pass 'refusal: missing flag value' 2 --input
expect_pass 'refusal: non-integer synthesis seconds' 2 \
  --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge abc
expect_pass 'refusal: NaN synthesis seconds' 2 \
  --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge NaN
expect_pass 'refusal: synthesis seconds above range' 2 \
  --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge 3601
expect_pass 'refusal: synthesis seconds below range' 2 \
  --input "$FIX/day-without-fleet-rows.json" --synthesize-before-merge -3601
expect_pass 'refusal: missing input file' 2 --input "$T/does-not-exist.json"
expect_pass 'refusal: invalid JSON' 2 --input "$T/not-json.json"
expect_pass 'refusal: JSON null' 2 --input "$T/null.json"
expect_pass 'refusal: JSON array' 2 --input "$T/array.json"
expect_pass 'refusal: JSON primitive' 2 --input "$T/primitive.json"
expect_pass 'refusal: malformed snapshot' 2 --input "$T/malformed-snapshot.json"
expect_pass 'refusal: malformed snapshot with synthesis' 2 \
  --input "$T/malformed-snapshot.json" --synthesize-before-merge 1
# A events file past the parser's line cap (200,001 lines) is refused.
{ i=0; while [ $i -lt 200001 ]; do printf 'x\n'; i=$((i + 1)); done; } >"$T/too-many-lines.jsonl"
expect_pass 'refusal: events file with too many lines' 2 \
  --events "$T/too-many-lines.jsonl" --day "$DAY" --repo-digest "$DIGEST"

# (8) A file over 8 MiB is refused.
dd if=/dev/zero of="$T/oversized.json" bs=1048576 count=9 2>/dev/null
expect_pass 'refusal: input file over 8 MiB' 2 --input "$T/oversized.json"

if [ "$fails" -eq 0 ]; then
  echo 'all s1-replay tests passed'
fi
exit "$fails"
