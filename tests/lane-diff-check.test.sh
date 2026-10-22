#!/bin/sh
# Tests for scripts/lane-diff-check.sh on throwaway git repositories. The fake credentials used here are
# assembled at run time from harmless parts, so this file itself matches none of the patterns.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
SCRIPT=${LDC_TEST_SCRIPT:-$here/scripts/lane-diff-check.sh}
RUNSH=${LDC_TEST_SH:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/lane-diff-check-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
run() { "$RUNSH" "$SCRIPT" "$@" > "$T/o" 2> "$T/e"; echo $? > "$T/rc"; }
rc() { cat "$T/rc"; }

R=$T/repo
mkdir -p "$R/packages/x/src" "$R/.github/workflows" && cd "$R" || exit 1
git init -q . && git config user.email t@example.invalid && git config user.name t
printf '/.lane/\n.agents/\n.env\n' > .gitignore
echo 'export const a = 1;' > packages/x/src/a.ts
echo 'name: gate' > .github/workflows/gate.yml
git add . && git -c commit.gpgsign=false commit -q -m init
git tag base
mkdir -p .lane && printf '# brief\n\nFiles: packages/x/src/a.ts, docs/notes.md.\n' > .lane/brief.md

echo '# usage'
run; check 'no worktree is a usage error (2)' '[ "$(rc)" = 2 ]'
run "$T"; check 'a dir outside git is 2' '[ "$(rc)" = 2 ]'
run "$R" --base nope; check 'an unknown --base is 2' '[ "$(rc)" = 2 ]'

echo '# clean'
run "$R" --base base; check 'an untouched worktree is clean (0)' '[ "$(rc)" = 0 ] && grep -q "0 file(s) reviewed" "$T/o"'
echo 'export const a = 2;' > packages/x/src/a.ts
run "$R" --base base; check 'an ordinary source change is clean (0)' '[ "$(rc)" = 0 ] && grep -q "1 file(s) reviewed" "$T/o"'
git -c commit.gpgsign=false commit -qam change
run "$R" --base base; check 'a committed change since base is still reviewed' 'grep -q "1 file(s) reviewed" "$T/o"'
run "$R" --base HEAD; check 'with the base at HEAD nothing is reviewed' 'grep -q "0 file(s) reviewed" "$T/o"'

echo '# protected paths'
echo 'name: gate2' > .github/workflows/gate.yml
run "$R" --base base; check 'a changed workflow is a finding (1)' '[ "$(rc)" = 1 ] && grep -q "^protected: .github/workflows/gate.yml" "$T/o"'
run "$R" --base base --allow-protected '^\.github/'; check '--allow-protected lifts it' '[ "$(rc)" = 0 ] && grep -q "^allowed-protected: .github/workflows/gate.yml" "$T/o"'
git checkout -q -- .github/workflows/gate.yml
mkdir -p .gemini && echo '{}' > .gemini/settings.json
run "$R" --base base; check 'a new agy permissions file is a finding' '[ "$(rc)" = 1 ] && grep -q "^protected: .gemini/settings.json" "$T/o"'
rm -rf .gemini
echo '{"scripts":{}}' > package.json
run "$R" --base base; check 'a new package.json is a finding' '[ "$(rc)" = 1 ] && grep -q "^protected: package.json" "$T/o"'
rm -f package.json
echo x > packages/x/package.json
run "$R" --base base; check 'a workspace package.json is a finding' 'grep -q "^protected: packages/x/package.json" "$T/o"'
rm -f packages/x/package.json

echo '# secret patterns'
tok="ghp_"; tok="${tok}abcdefghijklmnopqrstuvwxyz0123456789"
printf 'const t = "%s";\n' "$tok" > packages/x/src/b.ts
run "$R" --base base
check 'a token-shaped string in a new file is a finding (1)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/b.ts:1 (github-token)" "$T/o"'
check 'the matched value is never printed' '! grep -q "abcdefghij" "$T/o" && ! grep -q "abcdefghij" "$T/e"'
rm -f packages/x/src/b.ts
pk="-----BEGIN"; pk="$pk OPENSSH PRIVATE KEY-----"
{ echo 'line one'; echo "$pk"; } > packages/x/src/key.txt
run "$R" --base base; check 'a private key block is a finding with its line' 'grep -q "^secret-pattern: packages/x/src/key.txt:2 (private-key-block)" "$T/o"'
rm -f packages/x/src/key.txt
printf 'see /home/%s/.ssh/id_ed25519 for the key\n' martin > packages/x/src/note.md
run "$R" --base base; check 'a home credential path is a finding' 'grep -q "(home-credential-path)" "$T/o"'
rm -f packages/x/src/note.md
printf 'const password = "%s";\n' hunter2hunter2 > packages/x/src/c.ts
run "$R" --base base; check 'a password assignment is a finding' 'grep -q "(password-assignment)" "$T/o"'
rm -f packages/x/src/c.ts
echo 'const password = process.env.PASSWORD;' > packages/x/src/d.ts
run "$R" --base base; check 'reading a password from the environment is not a finding' '[ "$(rc)" = 0 ]'
rm -f packages/x/src/d.ts

echo '# brief scope'
mkdir -p docs apps/cli && echo n > docs/notes.md && echo o > apps/cli/other.ts
run "$R" --base base --brief .lane/brief.md
check 'a file the brief names is in scope' '! grep -q "outside-brief.*docs/notes.md" "$T/o"'
check 'a file the brief does not name is a warning, not a finding' '[ "$(rc)" = 0 ] && grep -q "^outside-brief (warning): apps/cli/other.ts" "$T/o"'
run "$R" --base base --brief .lane/brief.md --strict-brief
check '--strict-brief makes it a finding (1)' '[ "$(rc)" = 1 ] && grep -q "^outside-brief: apps/cli/other.ts" "$T/o"'
run "$R" --base base --brief .lane/brief.md --quiet
check '--quiet prints nothing' '[ ! -s "$T/o" ]'

rm -rf docs apps/cli

echo '# review fixes'
git mv .github/workflows/gate.yml packages/x/gate.yml
run "$R" --base base; check 'a staged rename away from a protected path is a finding' '[ "$(rc)" = 1 ] && grep -q "^protected: .github/workflows/gate.yml" "$T/o"'
git mv packages/x/gate.yml .github/workflows/gate.yml
odd="packages/x/src/caf\303\251 file.ts"; odd=$(printf "$odd")
printf 'const t = "%s";\n' "$tok" > "$odd"
run "$R" --base base; check 'a non-ASCII file name is scanned as the real file' '[ "$(rc)" = 1 ] && grep -q "(github-token)" "$T/o"'
rm -f "$odd"
printf '# brief\n\nUpdate README.md only.\n' > .lane/brief2.md
echo r > README.md
run "$R" --base base --brief .lane/brief2.md --strict-brief; check 'a root-level file the brief names is in scope' '! grep -q "outside-brief.*README.md" "$T/o"'
rm -f README.md
U=$T/unborn; mkdir -p "$U/.github" && ( cd "$U" && git init -q . && echo x > .github/w.yml && git add .github/w.yml )
run "$U"; check 'a staged protected file before the first commit is a finding' '[ "$(rc)" = 1 ] && grep -q "^protected: .github/w.yml" "$T/o"'

echo '# L1 security remediation (B3, M1, shell minors 9-11)'
# B3: Claude Code and opencode configuration paths are protected.
mkdir -p .claude .opencode
echo '{"hooks":{}}' > .claude/settings.json
echo '{"permissions":[]}' > .opencode/opencode.json
echo '{}' > opencode.json
run "$R" --base base
check 'Claude Code and opencode permission files are findings (B3)' '[ "$(rc)" = 1 ] && grep -q "^protected: .claude/settings.json" "$T/o" && grep -q "^protected: .opencode/opencode.json" "$T/o" && grep -q "^protected: opencode.json" "$T/o"'
rm -rf .claude .opencode opencode.json

# M1: ignored files under protected prefixes and ignored secret-shaped files are reviewed.
mkdir -p .agents
echo '{"tools":[]}' > .agents/x.json
printf '%s=%s\n' OPENCODE_SERVER_PASSWORD hunter2hunter2 > .env
run "$R" --base base
check 'ignored protected and secret-shaped files are findings (M1)' '[ "$(rc)" = 1 ] && grep -q "^protected: .agents/x.json" "$T/o" && grep -q "(opencode-server-password)" "$T/o"'
rm -rf .agents .env

# Shell minor 10: a NUL-containing file is scanned (grep -a), not skipped as binary.
printf 'const x = 1;\000const t = "%s";\n' "$tok" > packages/x/src/nul.ts
run "$R" --base base
check 'a NUL-containing file is still scanned' '[ "$(rc)" = 1 ] && grep -q "(github-token)" "$T/o"'
rm -f packages/x/src/nul.ts

# Shell minor 11: a symlink whose target leaves the worktree is a finding.
mkdir -p "$T/outside" && echo 'nothing secret here' > "$T/outside/thing"
ln -s "$T/outside/thing" packages/x/src/abs-link
ln -s ../../outside/thing packages/rel-link
run "$R" --base base
check 'a symlink leaving the worktree is a finding' '[ "$(rc)" = 1 ] && grep -q "^symlink-outside-worktree: packages/x/src/abs-link" "$T/o" && grep -q "^symlink-outside-worktree: packages/rel-link" "$T/o"'
rm -f packages/x/src/abs-link packages/rel-link

# Shell minor 9: a bare directory word in a brief does not put the tree in scope.
printf '# brief\n\nFiles: packages, docs/notes.md.\n' > .lane/brief3.md
mkdir -p docs && echo n > docs/notes.md
echo z > packages/x/src/extra.ts
run "$R" --base base --brief .lane/brief3.md --strict-brief
check 'a bare directory word does not put the tree in scope' 'grep -q "^outside-brief: packages/x/src/extra.ts" "$T/o"'
rm -rf docs packages/x/src/extra.ts .lane/brief3.md

echo
echo "$(grep -o "check '" "$self" | wc -l | tr -d ' ') checks defined, $fails failed"
[ "$fails" = 0 ]
