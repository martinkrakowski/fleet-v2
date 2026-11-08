#!/bin/sh
# lane-diff-check reports a lint suppression the lane ADDED (2026-11-08).
#
# Why: the gate's authority rests on rules a lane cannot switch off. One lane silenced `no-console` — which IS
# configured as an error in every package's eslint config — with an inline `// eslint-disable-next-line
# no-console` to get debug output past the gate, and it was caught only because a failing test printed that
# output. Suppressions are rare (zero reached main in the preceding week, ten exist in the whole non-test
# tree), so this is preventive: a NEW one is a finding, a pre-existing one is not.
#   sh tests/lane-diff-check-lint-suppression.test.sh    dash tests/...    zsh tests/...
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
script=$here/scripts/lane-diff-check.sh
fails=0; n=0
check() { ck=$1; what=$2; n=$((n+1)); if [ "$ck" = 0 ]; then echo "ok $n - $what"; else echo "not ok $n - $what"; fails=$((fails+1)); fi; }
command -v git >/dev/null 2>&1 || { echo "1..0 # skip: git absent"; exit 0; }

mk() {  # mk <dir>: a real temp repo with one committed source file; prints the base sha
  d=$1; mkdir -p "$d/packages/x/src"
  ( cd "$d" && git init -q . && git config user.email t@e && git config user.name t \
    && printf 'export const a = 1;\n' > packages/x/src/a.ts \
    && git add -A && git commit -q -m base && git rev-parse HEAD )
}

t=$(mktemp -d) || exit 1
trap 'rm -rf "$t"' EXIT HUP INT TERM

# 1. A suppression the lane adds is a finding, named for what it is.
r=$t/a; base=$(mk "$r")
printf 'export const a = 1;\n// eslint-disable-next-line no-console\nconsole.error("x");\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
out=$(sh "$script" "$r" --base "$base" 2>&1)
echo "$out" | grep -q 'lint-suppression: packages/x/src/a.ts:2'; check $? "an added eslint-disable is a finding at its line"
echo "$out" | grep -q 'secret-pattern.*lint-suppression'; [ $? -ne 0 ]; check $? "it is NOT labelled a secret"

# 2. @ts-ignore and @ts-expect-error count too.
for tag in '@ts-ignore' '@ts-expect-error'; do
  r=$t/$(echo "$tag" | tr -d '@-'); base=$(mk "$r")
  printf 'export const a = 1;\n// %s legacy\nexport const b: string = 1 as never;\n' "$tag" > "$r/packages/x/src/a.ts"
  ( cd "$r" && git add -A && git commit -q -m lane )
  sh "$script" "$r" --base "$base" 2>&1 | grep -q 'lint-suppression'; check $? "an added $tag is a finding"
done

# 3. A lane that adds none reports none. This is the check that stops it becoming noise.
r=$t/clean; base=$(mk "$r")
printf 'export const a = 2;\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q 'lint-suppression'; [ $? -ne 0 ]; check $? "a clean lane reports no suppression"

# 4. A suppression the BASE already had, in a file the lane also changes, is excused not reported.
r=$t/legacy; mkdir -p "$r/packages/x/src"
( cd "$r" && git init -q . && git config user.email t@e && git config user.name t \
  && printf '// eslint-disable-next-line no-explicit-any\nexport const old: any = 1;\n' > packages/x/src/a.ts \
  && git add -A && git commit -q -m base ) >/dev/null
base=$( cd "$r" && git rev-parse HEAD )
printf '// eslint-disable-next-line no-explicit-any\nexport const old: any = 2;\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q 'lint-suppression: '; [ $? -ne 0 ]; check $? "a pre-existing suppression in a changed file is excused, not a finding"

# 5. A real credential still reports as a secret, so the shared scan is not broken.
r=$t/sec; base=$(mk "$r")
printf 'export const k = "sk-abcdefghijklmnopqrstuvwx";\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q 'secret-pattern.*openai-style-key'; check $? "a credential still reports as secret-pattern"

echo "1..$n"; [ "$fails" = 0 ]
