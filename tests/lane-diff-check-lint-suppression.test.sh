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

# 6. New inline eslint rule disabling forms (the gap this PR closes).
for form in \
  '/* eslint no-console: off */' \
  '/* eslint no-console: 0 */' \
  '/* eslint no-console: "off" */' \
  "/* eslint no-console: 'off' */" \
  '/* eslint no-console: ["off"] */' \
  "/* eslint no-console: ['off'] */"; do
  r=$t/eslint-inline-$(printf '%s' "$form" | tr -cd 'a-z0-9'); base=$(mk "$r")
  printf 'export const a = 1;\n%s\nexport const b = 2;\n' "$form" > "$r/packages/x/src/a.ts"
  ( cd "$r" && git add -A && git commit -q -m lane )
  sh "$script" "$r" --base "$base" 2>&1 | grep -q 'lint-suppression'; check $? "inline eslint rule off form is a finding: $form"
done

# 7. @ts-nocheck disables typechecking for an entire file.
r=$t/tsnocheck; base=$(mk "$r")
printf '// @ts-nocheck\nexport const a: string = 1 as never;\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q 'lint-suppression'; check $? "an added @ts-nocheck is a finding"

# 8. Negative: a comment that merely mentions eslint is NOT a finding.
r=$t/eslint-mention; base=$(mk "$r")
printf 'export const a = 1;\n// eslint is configured in eslint.config.js\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q 'lint-suppression'; [ $? -ne 0 ]; check $? "a bare eslint mention is not a finding"

# 9. Negative: a rule set to error is NOT a finding.
r=$t/eslint-error; base=$(mk "$r")
printf 'export const a = 1;\n/* eslint no-console: error */\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q 'lint-suppression'; [ $? -ne 0 ]; check $? "eslint rule set to error is not a finding"

# 10. The scan does not flag its OWN definition: these files must contain the strings they
# match, so a match in them is a definition, not a suppression. The exemption is deliberately
# narrow, and cases 11 and 12 are what keep it from becoming a blind spot.
r=$t/self-exempt; base=$(mk "$r")
mkdir -p "$r/scripts"
printf '#!/bin/sh\n# documents the forms it matches\n/* eslint no-console: off */\n# @ts-nocheck\n' > "$r/scripts/lane-diff-check.sh"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q '^lint-suppression:'; [ $? -ne 0 ]; check $? "a suppression form in the scan's own script is not a lint-suppression finding"

# 11. The exemption is narrow: the same line in an ordinary source file is still a finding.
r=$t/not-exempt; base=$(mk "$r")
printf 'export const a = 1;\n/* eslint no-console: off */\n' > "$r/packages/x/src/a.ts"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q '^lint-suppression:'; check $? "the same form in an ordinary source file is still a finding"

# 12. The exemption covers lint-suppression ONLY: an exempted file is still scanned for secrets,
# which is what stops the exemption becoming a hole in the rest of the gate.
r=$t/exempt-still-secret; base=$(mk "$r")
mkdir -p "$r/tests"
printf '# fixture\nk="sk-abcdefghijklmnopqrstuvwx"\n/* eslint no-console: off */\n' > "$r/tests/lane-diff-check-lint-suppression.test.sh"
( cd "$r" && git add -A && git commit -q -m lane )
out=$(sh "$script" "$r" --base "$base" 2>&1)
printf '%s' "$out" | grep -q 'secret-pattern.*openai-style-key'; check $? "an exempted file is still scanned for secrets"
# Anchored: the fixture's own file NAME contains "lint-suppression", so an unanchored
# grep matches it inside the secret-pattern line and the assertion never means anything.
printf '%s' "$out" | grep -q '^lint-suppression:'; [ $? -ne 0 ]; check $? "and still not for lint suppressions"

# 13. A SCOPED rule name. The repository's own rules are scoped
# (@typescript-eslint/no-explicit-any), so a rule-name class without @ and / misses exactly the
# rules a lane would want to switch off.
for form in \
  '/* eslint @typescript-eslint/no-explicit-any: off */' \
  '/* eslint @typescript-eslint/no-unused-vars: 0 */' \
  '/* eslint import/no-cycle: ["off"] */'; do
  r=$t/scoped-$(printf '%s' "$form" | tr -cd 'a-z'); base=$(mk "$r")
  printf 'export const a = 1;\n%s\n' "$form" > "$r/packages/x/src/a.ts"
  ( cd "$r" && git add -A && git commit -q -m lane )
  sh "$script" "$r" --base "$base" 2>&1 | grep -q '^lint-suppression:'; check $? "a scoped rule set to off is a finding: $form"
done

# 14. The exemption is by EXACT name: a lane cannot name a new test file into it.
r=$t/sneaky; base=$(mk "$r")
mkdir -p "$r/tests"
printf '# not one of the exempted files\n/* eslint no-console: off */\n' > "$r/tests/lane-diff-check-sneaky.test.sh"
( cd "$r" && git add -A && git commit -q -m lane )
sh "$script" "$r" --base "$base" 2>&1 | grep -q '^lint-suppression:'; check $? "a lane-named test file is NOT exempt"

echo "1..$n"; [ "$fails" = 0 ]
