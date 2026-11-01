#!/bin/sh
# Tests for scripts/check-duplication.mjs (S4). Each case builds a fresh temp git
# repo with a symlinked node_modules so the script resolves this repository's
# typescript, plants a fixture function well over SonarCloud's block threshold
# (100 tokens / 10 lines) and checks the copies the lane's rules care about.
# Skips (exit 0) when node or node_modules/typescript is missing.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/scripts/check-duplication.mjs
if ! command -v node >/dev/null 2>&1; then
  echo 'skip check-duplication tests: node is not installed'
  exit 0
fi
if [ ! -d "$here/node_modules/typescript" ]; then
  echo 'skip check-duplication tests: node_modules/typescript is missing'
  exit 0
fi
T=$(mktemp -d "${TMPDIR:-/tmp}/check-duplication-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
finish() { rm -rf "$T"; }
trap finish EXIT

new_repo() { # $1 = directory: a fresh repo wired like the worktree
  mkdir -p "$1/packages/a/src" "$1/packages/b/src"
  (
    cd "$1" &&
      git init -q &&
      git config user.name 'Test' &&
      git config user.email 'test@example.invalid' &&
      printf 'node_modules\n' >.gitignore &&
      ln -s "$here/node_modules" node_modules &&
      printf '{}\n' >package.json &&
      printf 'sonar.exclusions=**/dist/**\nsonar.cpd.exclusions=**/spawn-run.ts\n' \
        >.sonarcloud.properties
  )
}

# A ~40-line TypeScript function with distinct short statements (well over 100
# tokens, no line span of 6 anywhere near 100), taking a string-literal argument.
# $1 is spliced into every string literal so a variant can change them all.
fixture() {
  cat <<EOF
export function zebraCounter(seed: string): number {
  const state = { total: 0, seen: 0, label: seed };
  const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const marks = new Map<string, number>();
  const names = new Map<number, string>();
  for (const step of steps) {
    state.total = state.total + step;
    if (step % 2 === 0) {
      state.seen = state.seen + 1;
      marks.set("$1even-" + step, state.total);
      names.set(step, "$1even-name");
    } else {
      state.seen = state.seen - 1;
      marks.set("$1odd-" + step, state.total);
      names.set(step, "$1odd-name");
    }
    if (state.total > 100) {
      state.total = state.total - 100;
      state.label = "$1reset";
    }
  }
  let best = 0;
  let bestName = "$1none";
  for (const key of marks.keys()) {
    const value = marks.get(key) || 0;
    if (value > best) {
      best = value;
      bestName = key;
    }
  }
  if (bestName === "$1none") {
    return 0;
  }
  const chosen = names.get(best) || 0;
  const report = "$1report-" + bestName + "-" + chosen;
  state.label = report;
  if (chosen > 50) {
    return best + chosen;
  }
  if (chosen > 20) {
    return best - chosen;
  }
  return best;
}
EOF
}

# An unrelated small file that shares no block with the fixture.
other() {
  cat <<'EOF'
export const garnet = 3;
export const heliotrope = garnet * 4;
export const indigo = garnet + heliotrope;
export const jasper = indigo - 1;
export const krypton = jasper * 2;
export const lime = krypton + garnet;
export const marble = lime - indigo;
export const nickel = marble * 3;
export const opal = nickel + jasper;
export const pyrite = opal - marble;
export const quartz = pyrite * 2;
export const rutile = quartz + opal;
export const spinel = rutile - quartz;
export const topaz = spinel * 2;
export const uvarovite = topaz + rutile;
EOF
}

# A dense ~12-line function: eight 20-token lines on top of the declaration,
# return and closing brace, so a full copy is one continuous duplicate.
dense() {
  cat <<EOF
export function deltaW(x: number): number {
  const a1 = x + 1; const a2 = a1 * 2; const a3 = a2 - 3;
  const a4 = a3 + 4; const a5 = a4 * 5; const a6 = a5 - 6;
  const a7 = a6 + 7; const a8 = a7 * 8; const a9 = a8 - 9;
  const b1 = a9 + 10; const b2 = b1 * 11; const b3 = b2 - 12;
  const b4 = b3 + 13; const b5 = b4 * 14; const b6 = b5 - 15;
  const b7 = b6 + 16; const b8 = b7 * 17; const b9 = b8 - 18;
  const c1 = b9 + 19; const c2 = c1 * 20; const c3 = c2 - 21;
  const c4 = c3 + 22; const c5 = c4 * 23; const c6 = c5 - 24;
  return c6 + x;
}
EOF
}

# A 9-line function with the same dense body but seven 20-token lines: over the
# 100-token window threshold, under the 10-line block threshold.
nine() { # $1 = variant letter (function name only, so variants never match)
  cat <<EOF
export function nine$1(x: number): number {
  const a1 = x + 1; const a2 = a1 * 2; const a3 = a2 - 3;
  const a4 = a3 + 4; const a5 = a4 * 5; const a6 = a5 - 6;
  const a7 = a6 + 7; const a8 = a7 * 8; const a9 = a8 - 9;
  const b1 = a9 + 10; const b2 = b1 * 11; const b3 = b2 - 12;
  const b4 = b3 + 13; const b5 = b4 * 14; const b6 = b5 - 15;
  const b7 = b6 + 16; const b8 = b7 * 17; const b9 = b8 - 18;
  return a9 + x;
}
EOF
}

# The same dense body carrying one no-substitution template literal; only the
# literal text differs between variants.
templ() { # $1 = text inside the template literal
  cat <<EOF
export function echoT(x: number): number {
  const a1 = x + 1; const a2 = a1 * 2; const a3 = a2 - 3;
  const a4 = a3 + 4; const a5 = a4 * 5; const a6 = a5 - 6;
  const a7 = a6 + 7; const a8 = a7 * 8; const a9 = a8 - 9;
  const b1 = a9 + 10; const b2 = b1 * 11; const b3 = b2 - 12;
  const b4 = b3 + 13; const b5 = b4 * 14; const b6 = b5 - 15;
  const b7 = b6 + 16; const b8 = b7 * 17; const b9 = b8 - 18;
  const note = \`$1\`;
  return b9 + note.length;
}
EOF
}

check() { # $1 = repo, $2 = base; sets rc, stdout, stderr
  out_file=$T/check.out
  err_file=$T/check.err
  node "$SCRIPT" --root "$1" --base "$2" >"$out_file" 2>"$err_file"
  rc=$?
  stdout=$(cat "$out_file")
  stderr=$(cat "$err_file")
}

# Every finding case must show the finding line format on stdout and never a
# crash (TypeError or stack trace) on stderr.
finding_format() { # $1 = stream to inspect
  if printf '%s\n' "$1" |
    grep -Eq '^check-duplication: .+:[0-9]+-[0-9]+ duplicates .+:[0-9]+-[0-9]+ \([0-9]+ lines\)$'; then
    ok 'stdout has the finding line format'
  else
    bad 'stdout has the finding line format'
  fi
}

clean_stderr() { # $1 = stderr stream to inspect
  case $1 in
  *TypeError*) bad 'stderr has no TypeError' ;;
  *'    at '*) bad 'stderr has no stack trace' ;;
  *) ok 'stderr has no TypeError or stack trace' ;;
  esac
}

# The fixture identifier must never appear in stdout in any case.
no_zebra() { # $1 = stream to inspect
  case $1 in
  *zebraCounter*) bad 'no output line names the fixture identifier' ;;
  *) ok 'no output line names the fixture identifier' ;;
  esac
}

# a. an unrelated new 15-line file: clean.
R=$T/a
new_repo "$R"
fixture base >"$R/packages/a/src/one.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_a=$(git -C "$R" rev-parse HEAD)
other >"$R/packages/b/src/new.ts"
check "$R" "$base_a"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-duplication: clean' ]; then
  ok 'an unrelated new file is clean'
else
  bad "an unrelated new file is clean (rc $rc: $stdout)"
fi
no_zebra "$stdout"

# b. the same function copied to packages/b/src/two.ts, uncommitted: exit 1 and
# both file names in the output, but never the fixture's identifier.
R=$T/b
new_repo "$R"
fixture base >"$R/packages/a/src/one.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_b=$(git -C "$R" rev-parse HEAD)
fixture copy >"$R/packages/b/src/two.ts"
check "$R" "$base_b"
if [ $rc -eq 1 ]; then ok 'an uncommitted copy exits 1'; else bad "an uncommitted copy exits 1 (rc $rc: $stdout)"; fi
finding_format "$stdout"
clean_stderr "$stderr"
case $stdout in
*packages/b/src/two.ts:*) ok 'the copy is named in the output' ;;
*) bad 'the copy is named in the output' ;;
esac
case $stdout in
*packages/a/src/one.ts:*) ok 'the original is named in the output' ;;
*) bad 'the original is named in the output' ;;
esac
no_zebra "$stdout"

# c. the same copy committed on top of the base: still exit 1.
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm copy >/dev/null
check "$R" "$base_b"
if [ $rc -eq 1 ]; then ok 'a committed copy also exits 1'; else bad "a committed copy also exits 1 (rc $rc: $stdout)"; fi
finding_format "$stdout"
clean_stderr "$stderr"
no_zebra "$stdout"

# d. only 6 lines of the function copied: clean (under both thresholds).
R=$T/d
new_repo "$R"
fixture base >"$R/packages/a/src/one.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_d=$(git -C "$R" rev-parse HEAD)
fixture base | sed -n '12,17p' >"$R/packages/b/src/six.ts"
check "$R" "$base_d"
if [ $rc -eq 0 ]; then ok 'a 6-line copy is clean'; else bad "a 6-line copy is clean (rc $rc: $stdout)"; fi
no_zebra "$stdout"

# e. the copy written to a cpd-excluded path: clean.
R=$T/e
new_repo "$R"
fixture base >"$R/packages/a/src/one.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_e=$(git -C "$R" rev-parse HEAD)
fixture copy >"$R/packages/b/src/spawn-run.ts"
check "$R" "$base_e"
if [ $rc -eq 0 ]; then ok 'a cpd-excluded copy is clean'; else bad "a cpd-excluded copy is clean (rc $rc: $stdout)"; fi
no_zebra "$stdout"

# f. the copy with every string literal changed: still exit 1 (literals are
# normalised before comparison).
R=$T/f
new_repo "$R"
fixture alpha >"$R/packages/a/src/one.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_f=$(git -C "$R" rev-parse HEAD)
fixture beta >"$R/packages/b/src/two.ts"
check "$R" "$base_f"
if [ $rc -eq 1 ]; then ok 'changed literals still duplicate'; else bad "changed literals still duplicate (rc $rc: $stdout)"; fi
finding_format "$stdout"
clean_stderr "$stderr"
no_zebra "$stdout"

# g. both copies already in the base commit, then an unrelated committed change:
# clean, because only added lines count.
R=$T/g
new_repo "$R"
fixture base >"$R/packages/a/src/one.ts"
fixture copy >"$R/packages/b/src/two.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_g=$(git -C "$R" rev-parse HEAD)
other >"$R/packages/c-extra.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm unrelated >/dev/null
check "$R" "$base_g"
if [ $rc -eq 0 ]; then ok 'pre-existing copies with an unrelated change are clean'; else bad "pre-existing copies with an unrelated change are clean (rc $rc: $stdout)"; fi
no_zebra "$stdout"

# h. two copies inside one new file: exit 1 (same-file duplication, far apart).
R=$T/h
new_repo "$R"
fixture base >"$R/packages/a/src/one.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_h=$(git -C "$R" rev-parse HEAD)
{ fixture first; echo; fixture second; } >"$R/packages/b/src/twin.ts"
check "$R" "$base_h"
if [ $rc -eq 1 ]; then ok 'two copies in one file exit 1'; else bad "two copies in one file exit 1 (rc $rc: $stdout)"; fi
finding_format "$stdout"
clean_stderr "$stderr"
case $stdout in
*packages/b/src/twin.ts:*) ok 'the twin copy is named in the output' ;;
*) bad 'the twin copy is named in the output' ;;
esac
if printf '%s\n' "$stdout" | grep -q 'duplicated block(s)'; then
  ok 'the summary line is present'
else
  bad 'the summary line is present'
fi
no_zebra "$stdout"

# j. usage and setup errors exit 2.
node "$SCRIPT" --root "$R" >/dev/null 2>&1
[ $? -eq 2 ] && ok 'a missing --base exits 2' || bad 'a missing --base exits 2'
node "$SCRIPT" --root "$R" --base "$base_h" --bogus >/dev/null 2>&1
[ $? -eq 2 ] && ok 'an unknown flag exits 2' || bad 'an unknown flag exits 2'
node "$SCRIPT" --root "$R" --base --upload-pack=x >/dev/null 2>&1
[ $? -eq 2 ] && ok 'an option-shaped --base exits 2' || bad 'an option-shaped --base exits 2'
node "$SCRIPT" --root "$R/packages" --base "$base_h" >/dev/null 2>&1
[ $? -eq 2 ] && ok 'a --root below the worktree top exits 2' || bad 'a --root below the worktree top exits 2'
node "$SCRIPT" --root "$R" --base not-a-rev >/dev/null 2>&1
[ $? -eq 2 ] && ok 'an unresolvable base exits 2' || bad 'an unresolvable base exits 2'
node "$SCRIPT" --root "$T/not-a-repo" --base HEAD >/dev/null 2>&1
[ $? -eq 2 ] && ok 'a non-repo --root exits 2' || bad 'a non-repo --root exits 2'
out=$(node "$SCRIPT" --root "$R" --base "$base_h" -h)
rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q 'check-duplication'; then
  ok '-h prints the header and exits 0'
else
  bad "-h prints the header and exits 0 (rc $rc)"
fi
no_zebra "$out"

# i. a changed eligible file that is a broken symlink: the scan cannot read it,
# so exit 2 with the path on stderr, never clean.
R=$T/i
new_repo "$R"
fixture base >"$R/packages/a/src/one.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_i=$(git -C "$R" rev-parse HEAD)
ln -s missing-target.ts "$R/packages/b/src/broken.ts"
check "$R" "$base_i"
if [ $rc -eq 2 ]; then ok 'a broken-symlink eligible file exits 2'; else bad "a broken-symlink eligible file exits 2 (rc $rc: $stdout)"; fi
case $stdout in
*clean*) bad 'a broken-symlink eligible file does not print clean' ;;
*) ok 'a broken-symlink eligible file does not print clean' ;;
esac
case $stderr in
*packages/b/src/broken.ts*) ok 'stderr names the unreadable path' ;;
*) bad 'stderr names the unreadable path' ;;
esac

# k. two adjacent nine-line matches against two different files: clean, because
# neither block reaches the 10-line threshold on its own counterpart.
R=$T/k
new_repo "$R"
nine x >"$R/packages/a/src/x.ts"
nine y >"$R/packages/a/src/y.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_k=$(git -C "$R" rev-parse HEAD)
{ nine x; nine y; } >"$R/packages/b/src/adjacent.ts"
check "$R" "$base_k"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-duplication: clean' ]; then
  ok 'two adjacent nine-line matches to different files are clean'
else
  bad "two adjacent nine-line matches to different files are clean (rc $rc: $stdout)"
fi
no_zebra "$stdout"

# l. a continuous twelve-line match against one file: still a finding, so the
# per-counterpart runs do not split a genuine duplicate.
R=$T/l
new_repo "$R"
dense w >"$R/packages/a/src/w.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_l=$(git -C "$R" rev-parse HEAD)
dense w >"$R/packages/b/src/copy.ts"
check "$R" "$base_l"
if [ $rc -eq 1 ]; then ok 'a continuous ten-line match to one file exits 1'; else bad "a continuous ten-line match to one file exits 1 (rc $rc: $stdout)"; fi
finding_format "$stdout"
clean_stderr "$stderr"
no_zebra "$stdout"

# m. two ten-line blocks that differ only in no-substitution template literal
# text: a finding, because template literal tokens are normalised by kind.
R=$T/m
new_repo "$R"
templ alpha >"$R/packages/a/src/templ-a.ts"
git -C "$R" add -A >/dev/null && git -C "$R" commit -qm base
base_m=$(git -C "$R" rev-parse HEAD)
templ beta >"$R/packages/b/src/templ-b.ts"
check "$R" "$base_m"
if [ $rc -eq 1 ]; then ok 'template literal text is normalised'; else bad "template literal text is normalised (rc $rc: $stdout)"; fi
finding_format "$stdout"
clean_stderr "$stderr"
no_zebra "$stdout"

[ "$fails" -eq 0 ] && echo 'check-duplication: all tests passed' || echo "check-duplication: $fails failure(s)"
[ "$fails" -eq 0 ]
