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
printf '/.lane/\n.agents/\n.env\nsecrets/\n/CLAUDE.md\nnode_modules/\n' > .gitignore
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
echo '{}' > turbo.json
echo '{}' > packages/x/turbo.json
run "$R" --base base; check 'a root or workspace turbo.json is a finding (speed plan D27)' '[ "$(rc)" = 1 ] && grep -q "^protected: turbo.json$" "$T/o" && grep -q "^protected: packages/x/turbo.json$" "$T/o"'
rm -f turbo.json packages/x/turbo.json

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

echo '# L1 security remediation (B3, M1, shell minors 9-11, fix-1)'
# B3 + Fix 3: Claude Code and opencode configuration paths are protected at any depth and case-insensitively.
mkdir -p .claude .opencode
echo '{"hooks":{}}' > .claude/settings.json
echo '{"permissions":[]}' > .opencode/opencode.json
echo '{}' > opencode.json
run "$R" --base base
check 'Claude Code and opencode permission files are findings (B3)' '[ "$(rc)" = 1 ] && grep -q "^protected: .claude/settings.json$" "$T/o" && grep -q "^protected: .opencode/opencode.json$" "$T/o" && grep -q "^protected: opencode.json$" "$T/o"'
rm -rf .claude .opencode opencode.json
mkdir -p .Claude packages/app/.claude
echo '{}' > .Claude/settings.json
echo '{}' > packages/app/.claude/settings.json
echo '{}' > opencode.jsonc
run "$R" --base base
check 'case-insensitive and nested Claude/opencode paths are protected (Fix 3)' '[ "$(rc)" = 1 ] && grep -q "^protected: .Claude/settings.json$" "$T/o" && grep -q "^protected: packages/app/.claude/settings.json$" "$T/o" && grep -q "^protected: opencode.jsonc$" "$T/o"'
rm -rf .Claude packages/app opencode.jsonc

# M1 + Fix 2: every ignored, untracked file outside the dependency/build skip list is reviewed.
mkdir -p .agents secrets
echo '{"tools":[]}' > .agents/x.json
printf '%s=%s\n' OPENCODE_SERVER_PASSWORD hunter2hunter2 > .env
printf 'const t = "%s";\n' "$tok" > secrets/token.txt
echo '# rules' > CLAUDE.md
run "$R" --base base
check 'ignored protected and secret-shaped files are findings (M1)' '[ "$(rc)" = 1 ] && grep -q "^protected: .agents/x.json$" "$T/o" && grep -q "(opencode-server-password)" "$T/o"'
check 'ignored secrets/token.txt and ignored root CLAUDE.md are findings (Fix 2)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: secrets/token.txt:1 (github-token)$" "$T/o" && grep -q "^protected: CLAUDE.md$" "$T/o"'
rm -rf .agents .env secrets CLAUDE.md
mkdir -p node_modules/pkg
printf 'const t = "%s";\n' "$tok" > node_modules/pkg/index.js
run "$R" --base base
check 'an ignored file under node_modules/ is skipped (Fix 2)' '[ "$(rc)" = 0 ] && ! grep -q "node_modules" "$T/o"'
rm -rf node_modules

# Fix 4 (D3): a committed .lane/brief.md is protected; an ignored, untracked .lane/brief.md is skipped.
run "$R" --base base
check 'an ignored, untracked .lane/brief.md is not a finding (Fix 4)' '[ -f .lane/brief.md ] && [ "$(rc)" = 0 ] && ! grep -q "\.lane" "$T/o"'
if git add -f .lane/brief.md && git -c commit.gpgsign=false commit -q -m lane-brief; then
  run "$R" --base base
  check 'a committed .lane/brief.md is a protected finding (Fix 4)' '[ "$(rc)" = 1 ] && grep -q "^protected: .lane/brief.md$" "$T/o"'
  git reset -q HEAD~1 && git reset -q -- .lane/brief.md
else
  check 'the committed .lane/brief.md fixture was created (Fix 4)' 'false'
fi

# Shell minor 10 + Fix 5: a NUL-containing file is scanned (grep -a), not skipped as binary.
printf 'const x = 1;\000const t = "%s";\n' "$tok" > packages/x/src/nul.ts
run "$R" --base base
check 'a NUL-containing file is still scanned' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/nul.ts:1 (github-token)$" "$T/o" && ! grep -q "Binary file" "$T/o" && ! grep -q "Binary file" "$T/e"'
rm -f packages/x/src/nul.ts

# Shell minor 11 + Fix 1: symlinks are resolved up to 40 hops and never followed when scanning.
mkdir -p "$T/outside" && echo 'nothing secret here' > "$T/outside/thing"
printf 'const t = "%s";\n' "$tok" > "$T/outside/file"
ln -s "$T/outside/thing" packages/x/src/abs-link
ln -s ../../outside/thing packages/rel-link
run "$R" --base base
check 'a symlink leaving the worktree is a finding' '[ "$(rc)" = 1 ] && grep -q "^symlink-escape: packages/x/src/abs-link$" "$T/o" && grep -q "^symlink-escape: packages/rel-link$" "$T/o"'
rm -f packages/x/src/abs-link packages/rel-link
mkdir -p sub
ln -s "$T/outside" sub/out
ln -s sub/out/file link
run "$R" --base base
check 'a symlink to a directory outside is symlink-escape (Fix 1)' '[ "$(rc)" = 1 ] && grep -q "^symlink-escape: sub/out$" "$T/o"'
check 'a chained symlink escape reports symlink-escape and never scans the outside file (Fix 1)' '[ "$(rc)" = 1 ] && grep -q "^symlink-escape: link$" "$T/o" && ! grep -q "secret-pattern" "$T/o" && ! grep -q "abcdefghij" "$T/o"'
rm -rf sub link

# Fix 1 (re-review): a directory symlink ABOVE a tracked file. The leaf is a plain file, so only the
# physical directory shows it lives outside; the scan must never read it.
mkdir -p "$T/outside2" && printf 'const t = "%s";\n' "$tok" > "$T/outside2/secret.ts"
mkdir -p dsub && printf 'const x = 1;\n' > dsub/secret.ts
if git add dsub/secret.ts && git -c commit.gpgsign=false commit -q -m dsub; then
  rm -rf dsub && ln -s "$T/outside2" dsub
  run "$R" --base base
  check 'a directory symlink above a tracked file is symlink-escape and is never scanned (Fix 1)' '[ "$(rc)" = 1 ] && grep -q "^symlink-escape: dsub/secret.ts$" "$T/o" && ! grep -q "^secret-pattern: dsub" "$T/o"'
  rm -f dsub && git reset -q --hard HEAD~1
else
  check 'the dsub fixture was created (Fix 1)' 'false'
fi
ln -s does-not-exist packages/x/src/dangling
run "$R" --base base
check 'a dangling symlink is symlink-unresolved (Fix 1)' '[ "$(rc)" = 1 ] && grep -q "^symlink-unresolved: packages/x/src/dangling$" "$T/o"'
rm -f packages/x/src/dangling

# Shell minor 9 + Fix 6: a bare directory word in a brief does not put the tree in scope.
printf '# brief\n\nFiles: packages, docs/notes.md.\n' > .lane/brief3.md
mkdir -p docs && echo n > docs/notes.md
echo z > packages/x/src/extra.ts
run "$R" --base base --brief .lane/brief3.md --strict-brief
check 'a bare directory word does not put the tree in scope' '[ "$(rc)" = 1 ] && grep -q "^outside-brief: packages/x/src/extra.ts$" "$T/o" && ! grep -q "outside-brief.*docs/notes.md" "$T/o"'
rm -rf docs packages/x/src/extra.ts .lane/brief3.md

# Fix 7: a reviewed file over 5 MiB is not grepped and is reported as unscanned-large-file.
dd if=/dev/zero of=packages/x/src/big.bin bs=1024 count=5121 2>/dev/null
run "$R" --base base
check 'a file over 5 MiB is reported as unscanned-large-file (Fix 7)' '[ "$(rc)" = 1 ] && grep -q "^unscanned-large-file: packages/x/src/big.bin$" "$T/o"'
rm -f packages/x/src/big.bin

# Fable review of L1: a file whose name is not valid UTF-8 is still reviewed. In a UTF-8 locale GNU
# grep treats that line as binary and drops it from the list (3.11 drops the line; older versions
# drop every later line too), so a secret in such a file was never scanned.
bad=$(printf 'packages/x/src/\377.ts')
# APFS (macOS) refuses a name that is not valid UTF-8, so there the case cannot arise: skip it.
if printf 'const t = "%s";\n' "$tok" > "$bad" 2>/dev/null; then
  mkdir -p .claude && printf '{}\n' > .claude/settings.json
  LC_ALL=C.UTF-8 LANG=C.UTF-8 run "$R" --base base
  check 'a file with an invalid-UTF-8 name is still scanned, and later paths still listed (Fable 1)' '[ "$(rc)" = 1 ] && grep -aq "(github-token)" "$T/o" && grep -q "^protected: .claude/settings.json$" "$T/o"'
  rm -rf "$bad" .claude
else
  echo "skip invalid-UTF-8 file name: this filesystem refuses such names"
fi

# Fable review of L1: a secret committed and then removed from the worktree is still scanned, from
# the committed blob, because that is what gets pushed.
printf 'const t = "%s";\n' "$tok" > packages/x/src/gone.ts
if git add packages/x/src/gone.ts && git -c commit.gpgsign=false commit -q -m gone; then
  rm -f packages/x/src/gone.ts
  run "$R" --base base
  check 'a committed secret deleted from the worktree is still found (Fable 2)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/gone.ts (committed):1 (github-token)$" "$T/o"'
  git reset -q --hard HEAD~1
else
  check 'the gone.ts fixture was created (Fable 2)' 'false'
fi

# Fable review of L1: an unreadable file is a finding, never a silent skip.
if [ "$(id -u)" != 0 ]; then
  printf 'x\n' > packages/x/src/locked.ts && chmod 000 packages/x/src/locked.ts
  run "$R" --base base
  check 'an unreadable file is a finding (Fable 2)' '[ "$(rc)" = 1 ] && grep -q "^unreadable: packages/x/src/locked.ts$" "$T/o"'
  chmod 600 packages/x/src/locked.ts; rm -f packages/x/src/locked.ts
fi

# Fable review of L1: a lane-set core.fsmonitor in the shared .git/config never runs in the gate.
git config core.fsmonitor "touch $T/fsmonitor-ran #"
run "$R" --base base
check 'a lane-set core.fsmonitor never runs in the gate (Fable 5)' '[ ! -e "$T/fsmonitor-ran" ]'
git config --unset core.fsmonitor

echo '# L1b item 1: yarn/npm/manifest execution paths at any depth'
mkdir -p packages/app packages/a/b/c
echo 'x' > packages/app/.yarnrc
echo 'y' > packages/app/.yarnrc.yml
echo 'z' > packages/app/.npmrc
mkdir -p .yarn/plugins .yarn/releases .yarn/patches
echo 'p' > .yarn/plugins/plugin.js
echo 'r' > .yarn/releases/yarn.cjs
echo 'a' > .yarn/patches/pkg.patch
echo '{"scripts":{}}' > packages/a/b/c/package.json
run "$R" --base base
check 'a nested .yarnrc is a protected finding (L1b)' '[ "$(rc)" = 1 ] && grep -q "^protected: packages/app/.yarnrc$" "$T/o"'
check 'a nested .yarnrc.yml is a protected finding (L1b)' 'grep -q "^protected: packages/app/.yarnrc.yml$" "$T/o"'
check 'a nested .npmrc is a protected finding (L1b)' 'grep -q "^protected: packages/app/.npmrc$" "$T/o"'
check '.yarn/plugins at the root is a protected finding (L1b)' 'grep -q "^protected: .yarn/plugins/plugin.js$" "$T/o"'
check '.yarn/releases at the root is a protected finding (L1b)' 'grep -q "^protected: .yarn/releases/yarn.cjs$" "$T/o"'
check '.yarn/patches at the root is a protected finding (L1b)' 'grep -q "^protected: .yarn/patches/pkg.patch$" "$T/o"'
check 'a deeply nested package.json is a protected finding (L1b)' 'grep -q "^protected: packages/a/b/c/package.json$" "$T/o"'
rm -rf packages/app/.yarnrc packages/app/.yarnrc.yml packages/app/.npmrc .yarn packages/a
mkdir -p packages/x/node_modules/y
echo '{"scripts":{}}' > packages/x/node_modules/y/package.json
run "$R" --base base
check 'a package.json under node_modules is not a finding (L1b)' '[ "$(rc)" = 0 ] && ! grep -q "node_modules/y/package.json" "$T/o"'
rm -rf packages/x/node_modules
mkdir -p .Yarn/plugins
echo '{"scripts":{}}' > Package.json
echo 'y' > .Yarnrc.yml
echo 'n' > .NPMRC
echo 'p' > .PNP.cjs
echo 'x' > .Yarn/plugins/x
run "$R" --base base
check 'case-variant Package.json is a protected finding (L1b fix-1)' '[ "$(rc)" = 1 ] && grep -q "^protected: Package.json$" "$T/o"'
check 'case-variant .Yarnrc.yml is a protected finding (L1b fix-1)' 'grep -q "^protected: .Yarnrc.yml$" "$T/o"'
check 'case-variant .NPMRC is a protected finding (L1b fix-1)' 'grep -q "^protected: .NPMRC$" "$T/o"'
check 'case-variant .PNP.cjs is a protected finding (L1b fix-1)' 'grep -q "^protected: .PNP.cjs$" "$T/o"'
check 'case-variant .Yarn/plugins/x is a protected finding (L1b fix-1)' 'grep -q "^protected: .Yarn/plugins/x$" "$T/o"'
rm -rf Package.json .Yarnrc.yml .NPMRC .PNP.cjs .Yarn
mkdir -p node_modules/x packages/app/node_modules
echo 'r' > node_modules/AGENTS.md
echo 'r' > packages/app/node_modules/.cursorrules
echo 'x' > node_modules/x/.yarnrc
echo 'x' > node_modules/x/.gitattributes
run "$R" --base base
check 'node_modules/AGENTS.md is a protected finding (L1b fix-1)' '[ "$(rc)" = 1 ] && grep -q "^protected: node_modules/AGENTS.md$" "$T/o"'
check 'packages/app/node_modules/.cursorrules is a protected finding (L1b fix-1)' 'grep -q "^protected: packages/app/node_modules/.cursorrules$" "$T/o"'
check 'node_modules/x/.yarnrc is a protected finding (L1b fix-1)' 'grep -q "^protected: node_modules/x/.yarnrc$" "$T/o"'
check 'node_modules/x/.gitattributes is a protected finding (L1b fix-1)' 'grep -q "^protected: node_modules/x/.gitattributes$" "$T/o"'
rm -rf node_modules packages/app/node_modules

echo '# L1b item 2: agent instruction and tool files at any depth'
mkdir -p packages/app/.cursor packages/app/.vscode packages/app/.github
echo 'r' > packages/app/AGENTS.md
echo 'r' > packages/app/CLAUDE.md
echo 'l' > CLAUDE.local.md
echo 'r' > packages/app/gemini.md
echo '{"mcpServers":{}}' > packages/app/.mcp.json
echo 'r' > .cursorrules
echo 'r' > packages/app/.windsurfrules
echo 'x' > packages/app/.cursor/rules.mdc
echo 'x' > packages/app/.vscode/tasks.json
echo 'x' > packages/app/.github/copilot-instructions.md
run "$R" --base base
check 'a nested AGENTS.md is a protected finding (L1b)' '[ "$(rc)" = 1 ] && grep -q "^protected: packages/app/AGENTS.md$" "$T/o"'
check 'a nested CLAUDE.md is a protected finding (L1b)' 'grep -q "^protected: packages/app/CLAUDE.md$" "$T/o"'
check 'CLAUDE.local.md is a protected finding (L1b)' 'grep -q "^protected: CLAUDE.local.md$" "$T/o"'
check 'a nested case-variant GEMINI.md is a protected finding (L1b)' 'grep -q "^protected: packages/app/gemini.md$" "$T/o"'
check 'a nested .mcp.json is a protected finding (L1b)' 'grep -q "^protected: packages/app/.mcp.json$" "$T/o"'
check '.cursorrules is a protected finding (L1b)' 'grep -q "^protected: .cursorrules$" "$T/o"'
check 'a nested .windsurfrules is a protected finding (L1b)' 'grep -q "^protected: packages/app/.windsurfrules$" "$T/o"'
check 'a nested .cursor/ is a protected finding (L1b)' 'grep -q "^protected: packages/app/.cursor/rules.mdc$" "$T/o"'
check 'a nested .vscode/ is a protected finding (L1b)' 'grep -q "^protected: packages/app/.vscode/tasks.json$" "$T/o"'
check 'a nested .github/copilot-instructions.md is a protected finding (L1b)' 'grep -q "^protected: packages/app/.github/copilot-instructions.md$" "$T/o"'
rm -rf packages/app/AGENTS.md packages/app/CLAUDE.md CLAUDE.local.md packages/app/gemini.md packages/app/.mcp.json .cursorrules packages/app/.windsurfrules packages/app/.cursor packages/app/.vscode packages/app/.github
mkdir -p .husky packages/app/.husky
echo 'x' > .envrc
echo 'x' > .husky/pre-commit
echo 'all:' > Makefile
echo 'all:' > GNUmakefile
echo 'x' > packages/app/.envrc
echo 'x' > packages/app/.husky/pre-commit
echo 'all:' > packages/app/Makefile
run "$R" --base base
check 'a root .envrc is a protected finding (L1b)' '[ "$(rc)" = 1 ] && grep -q "^protected: .envrc$" "$T/o"'
check 'a root .husky/pre-commit is a protected finding (L1b)' 'grep -q "^protected: .husky/pre-commit$" "$T/o"'
check 'a root Makefile is a protected finding (L1b)' 'grep -q "^protected: Makefile$" "$T/o"'
check 'a root GNUmakefile is a protected finding (L1b)' 'grep -q "^protected: GNUmakefile$" "$T/o"'
check 'a nested .envrc is not a finding (root only, L1b)' '! grep -q "^protected: packages/app/.envrc$" "$T/o"'
check 'a nested .husky/ is not a finding (root only, L1b)' '! grep -q "^protected: packages/app/.husky/pre-commit$" "$T/o"'
check 'a nested Makefile is not a finding (root only, L1b)' '! grep -q "^protected: packages/app/Makefile$" "$T/o"'
rm -f Makefile && echo 'all:' > makefile
run "$R" --base base
check 'a root makefile is a protected finding (L1b)' '[ "$(rc)" = 1 ] && grep -q "^protected: makefile$" "$T/o"'
rm -rf .envrc .husky Makefile makefile GNUmakefile packages/app/.envrc packages/app/.husky packages/app/Makefile
echo 'x' > packages/x/.gitattributes
echo 'x' > packages/x/.gitmodules
run "$R" --base base
check 'a nested .gitattributes is a protected finding (L1b)' '[ "$(rc)" = 1 ] && grep -q "^protected: packages/x/.gitattributes$" "$T/o"'
check 'a nested .gitmodules is a protected finding (L1b)' 'grep -q "^protected: packages/x/.gitmodules$" "$T/o"'
rm -f packages/x/.gitattributes packages/x/.gitmodules

echo '# L1b item 3: the protected check runs before the ignored-file keep-list'
cp .gitignore "$T/gitignore.bak"
printf '/.claude/\n.agents/\nnode_modules/\ndist/\n' >> .gitignore
mkdir -p .agents/node_modules .claude/dist
echo '{"tools":[]}' > .agents/node_modules/x.json
echo '{"hooks":[]}' > .claude/dist/x.json
run "$R" --base base
check '.agents/node_modules/x is still a protected finding (L1b)' 'git check-ignore -q .agents/node_modules/x.json && [ "$(rc)" = 1 ] && grep -q "^protected: .agents/node_modules/x.json$" "$T/o"'
check '.claude/dist/x is still a protected finding (L1b)' 'git check-ignore -q .claude/dist/x.json && grep -q "^protected: .claude/dist/x.json$" "$T/o"'
rm -rf .agents/node_modules .claude/dist
cp "$T/gitignore.bak" .gitignore

echo '# L1b item 5: git config filter drivers are reported and neutralised'
git config filter.evil.clean "touch $T/evil-ran"
git config filter.evil.smudge "touch $T/evil-ran-smudge"
git config filter.evil.process "touch $T/evil-ran-process"
echo '* filter=evil' > .gitattributes
echo 'export const a = 333;' > packages/x/src/a.ts
run "$R" --base base
check 'a non-lfs git config filter driver is a finding (L1b)' '[ "$(rc)" = 1 ] && grep -q "^git-config-filter: evil$" "$T/o"'
check 'the gate never ran the lane-set filter driver (L1b)' '[ ! -e "$T/evil-ran" ] && [ ! -e "$T/evil-ran-smudge" ] && [ ! -e "$T/evil-ran-process" ]'
git config --unset filter.evil.clean
git config --unset filter.evil.smudge
git config --unset filter.evil.process
git checkout -q -- packages/x/src/a.ts
rm -f .gitattributes
printf '[filter "inc"]\n\tclean = touch %s/inc-ran\n' "$T" > "$T/inc.gitconfig"
git config include.path "$T/inc.gitconfig"
echo '* filter=inc' > .gitattributes
echo 'export const a = 333;' > packages/x/src/a.ts
run "$R" --base base
check 'a filter driver set via include.path is reported and never run (L1b)' '[ "$(rc)" = 1 ] && grep -q "^git-config-filter: inc$" "$T/o" && [ ! -e "$T/inc-ran" ]'
git config --unset include.path
git checkout -q -- packages/x/src/a.ts
rm -f .gitattributes "$T/inc.gitconfig"

# Grok re-review of L1b: a stored value containing a line "EOF" must not cut the driver list short.
printf '* filter=late\n' > .gitattributes
printf '// late\n' >> packages/x/src/a.ts
git config filter.early.clean "$(printf 'true\nEOF\nmore')"
git config filter.late.clean "touch $T/late-ran"
run "$R" --base base
check 'a config value containing EOF cannot hide a later filter driver (L1b re-review)' '[ "$(rc)" = 1 ] && grep -q "^git-config-filter: late$" "$T/o" && [ ! -e "$T/late-ran" ]'
git config --remove-section filter.early; git config --remove-section filter.late
git checkout -q -- packages/x/src/a.ts; rm -f .gitattributes

# A driver name with spaces would be word-split into git's argv as its own -c option, after the
# gate's pins: the gate refuses to run git at all.
git config "filter.x -c core.fsmonitor=touch $T/inj -c x.clean" cat 2>/dev/null || git config --file .git/config "filter.x -c core.fsmonitor=touch $T/inj -c x.clean" cat 2>/dev/null || true
if git config --name-only --get-regexp '^filter\..*\.clean$' 2>/dev/null | grep -q ' '; then
  run "$R" --base base
  check 'an unsafe filter driver name fails closed before any git diff (L1b re-review)' '[ "$(rc)" = 1 ] && grep -q "^git-config-filter-unsafe:" "$T/o" && [ ! -e "$T/inj" ]'
  git config --remove-section "filter.x -c core.fsmonitor=touch $T/inj -c x" 2>/dev/null || true
else
  check 'the unsafe filter driver fixture was created (L1b re-review)' 'false'
fi

# Fable review of #149: the table loader fails closed, and --rules lets a trusted copy run.
good="$(dirname "$SCRIPT")/lane-diff-check.protected"
sed 's/^\(\\\.github\/\)	0	1$/\1 0 1/' "$good" > "$T/rules-space"
run "$R" --base base --rules "$T/rules-space"
check 'a rule row with spaces instead of tabs fails closed (2)' '[ "$(rc)" = 2 ] && grep -q "malformed rule row" "$T/e"'
{ cat "$good"; printf '(unclosed\t1\t1\n'; } > "$T/rules-bad-ere"
run "$R" --base base --rules "$T/rules-bad-ere"
check 'an invalid pattern in the table fails closed (2)' '[ "$(rc)" = 2 ] && grep -q "not a valid pattern" "$T/e"'
grep '^#' "$good" > "$T/rules-empty"; printf '\\.github/\t0\t1\n' >> "$T/rules-empty"
run "$R" --base base --rules "$T/rules-empty"
check 'a table with too few rules fails closed (2)' '[ "$(rc)" = 2 ] && grep -q "expected at least 40" "$T/e"'
mkdir -p .devcontainer && printf '{}\n' > .devcontainer/devcontainer.json
"$RUNSH" -s "$R" --base base --rules "$good" < "$SCRIPT" > "$T/o" 2> "$T/e"; echo $? > "$T/rc"
check 'piped with --rules, the trusted table loads and .devcontainer/ is protected' '[ "$(rc)" = 1 ] && grep -q "^protected: .devcontainer/devcontainer.json$" "$T/o"'
rm -rf .devcontainer

# KF-27: base-line allowance. A credential-shaped line already in the base version of the same path
# is excused (reported as baseline-excused, line numbers only); a new or changed line still fails.
head0=$(git rev-parse HEAD)
fx='const password = "'; fx="${fx}hunter2hunter2\";"
{ echo 'line one'; echo "$fx"; echo 'line three'; } > packages/x/src/fixture.ts
git add packages/x/src/fixture.ts && git -c commit.gpgsign=false commit -q -m fixture
git tag kf27base
echo 'line four' >> packages/x/src/fixture.ts
run "$R" --base "$(git rev-parse kf27base)"
check 'a pre-existing fixture line in a touched file is excused (KF-27)' '[ "$(rc)" = 0 ] && grep -q "^baseline-excused: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o" && ! grep -q "^secret-pattern:" "$T/o"'
check 'the excused value is never printed (KF-27)' '! grep -q "hunter2" "$T/o" && ! grep -q "hunter2" "$T/e"'
git -c commit.gpgsign=false commit -qam 'touch fixture'
run "$R" --base "$(git rev-parse kf27base)"
check 'a committed edit to the file still excuses the base line (KF-27)' '[ "$(rc)" = 0 ] && grep -q "^baseline-excused: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o"'
echo "$fx" >> packages/x/src/fixture.ts
run "$R" --base "$(git rev-parse kf27base)"
check 'a new copy of the same fixture line beyond the base count fails (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/fixture.ts:5 (password-assignment)$" "$T/o" && grep -q "^baseline-excused: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o"'
git checkout -q -- packages/x/src/fixture.ts
sed 's/hunter2hunter2/hunter3hunter3/' packages/x/src/fixture.ts > "$T/fx" && cat "$T/fx" > packages/x/src/fixture.ts
run "$R" --base "$(git rev-parse kf27base)"
check 'a modified fixture line fails (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o"'
check 'the modified value is never printed (KF-27)' '! grep -q "hunter3" "$T/o"'
git checkout -q -- packages/x/src/fixture.ts
{ echo "$fx"; } > packages/x/src/fixture2.ts
run "$R" --base "$(git rev-parse kf27base)"
check 'the same line in a different, new file is not excused (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/fixture2.ts:1 (password-assignment)$" "$T/o"'
rm -f packages/x/src/fixture2.ts
echo 'line five' >> packages/x/src/fixture.ts
run "$R"
check 'with no base nothing is excused (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o"'
git checkout -q -- packages/x/src/fixture.ts
{ printf 'a\000b\n'; echo "$fx"; } > packages/x/src/nulfix.ts
git add packages/x/src/nulfix.ts && git -c commit.gpgsign=false commit -q -m nulfix
git tag kf27nul
echo 'tail' >> packages/x/src/nulfix.ts
run "$R" --base "$(git rev-parse kf27nul)"
check 'a NUL byte in the file excuses nothing (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/nulfix.ts:2 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o"'
git checkout -q -- packages/x/src/nulfix.ts
{ echo 'line one'; echo 'line two'; } > packages/x/src/repl.ts
git add packages/x/src/repl.ts && git -c commit.gpgsign=false commit -q -m repl
git tag kf27repl
realblob=$(git rev-parse kf27repl:packages/x/src/repl.ts)
forged=$({ echo 'line one'; echo "$fx"; echo 'line two'; } | git hash-object -w --stdin)
git replace "$realblob" "$forged"
echo "$fx" >> packages/x/src/repl.ts
run "$R" --base "$(git rev-parse kf27repl)"
check 'a replace ref forging the base blob excuses nothing (KF-27, Luna review)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/repl.ts:3 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o"'
git replace -d "$realblob" > /dev/null
git checkout -q -- packages/x/src/repl.ts
git tag -d kf27repl > /dev/null
# KF-27a (Fable review A1): a ref name is lane-writable, so it enables no allowance and says so once.
echo 'line four' >> packages/x/src/fixture.ts
run "$R" --base kf27base
check 'a ref-name base excuses nothing and warns once (KF-27a A1)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o" && [ "$(grep -c "^lane-diff-check: base is not a commit sha; no base-line allowance$" "$T/e")" = 1 ]'
run "$R" --base "$(git rev-parse kf27base)"
check 'a sha base enables the allowance with no warning (KF-27a A1)' 'grep -q "^baseline-excused: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o" && ! grep -q "no base-line allowance" "$T/e"'
git checkout -q -- packages/x/src/fixture.ts
# A3: a base that is not an ancestor of HEAD excuses nothing (a side commit, then unrelated history).
cur=$(git symbolic-ref --short HEAD)
git checkout -q -b kf27side
echo 'side' >> packages/x/src/fixture.ts
git -c commit.gpgsign=false commit -qam side
side=$(git rev-parse HEAD)
git checkout -q "$cur"
echo 'line four' >> packages/x/src/fixture.ts
run "$R" --base "$side"
check 'a base that is not an ancestor of HEAD excuses nothing (KF-27a A3)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o" && grep -q "^lane-diff-check: base is not an ancestor commit of HEAD; no base-line allowance$" "$T/e"'
git checkout -q -- packages/x/src/fixture.ts
git checkout -q --orphan kf27orphan
git rm -rqf . > /dev/null
mkdir -p packages/x/src
{ echo 'line one'; echo "$fx"; echo 'line three'; } > packages/x/src/fixture.ts
git add packages/x/src/fixture.ts && git -c commit.gpgsign=false commit -q -m orphan
orphan=$(git rev-parse HEAD)
git checkout -q -f "$cur"
echo 'line four' >> packages/x/src/fixture.ts
run "$R" --base "$orphan"
check 'an unrelated-history base excuses nothing (KF-27a A5)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/fixture.ts:2 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o"'
git checkout -q -- packages/x/src/fixture.ts
git branch -q -D kf27side kf27orphan
# A5: the base path is a tree, not a file: nothing is excused for the new file at that path.
mkdir -p packages/x/src/tdir
{ echo "$fx"; } > packages/x/src/tdir/inner.ts
git add packages/x/src/tdir && git -c commit.gpgsign=false commit -q -m tdir
git tag kf27tree
git rm -rq packages/x/src/tdir
{ echo "$fx"; } > packages/x/src/tdir
run "$R" --base "$(git rev-parse kf27tree)"
check 'a path that was a directory at the base excuses nothing (KF-27a A5)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/tdir:1 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused: packages/x/src/tdir:" "$T/o"'
rm -f packages/x/src/tdir
git reset -q --hard kf27tree
# A5: two copies at the base, three in the worktree: the first two are excused, the third fails.
{ echo "$fx"; echo "$fx"; } > packages/x/src/twice.ts
git add packages/x/src/twice.ts && git -c commit.gpgsign=false commit -q -m twice
git tag kf27twice
echo "$fx" >> packages/x/src/twice.ts
run "$R" --base "$(git rev-parse kf27twice)"
check 'base two copies, worktree three: lines 1-2 excused, line 3 fails (KF-27a A5)' '[ "$(rc)" = 1 ] && grep -q "^baseline-excused: packages/x/src/twice.ts:1,2 (password-assignment)$" "$T/o" && grep -q "^secret-pattern: packages/x/src/twice.ts:3 (password-assignment)$" "$T/o"'
git checkout -q -- packages/x/src/twice.ts
# A2: a forged loose object for the base blob (valid zlib, other content) excuses nothing.
{ echo 'line one'; echo 'line two'; } > packages/x/src/forge.ts
git add packages/x/src/forge.ts && git -c commit.gpgsign=false commit -q -m forge
git tag kf27forge
realblob=$(git rev-parse kf27forge:packages/x/src/forge.ts)
forged=$({ echo 'line one'; echo "$fx"; echo 'line two'; } | git hash-object -w --stdin)
od=$(git rev-parse --git-path objects)
realfile=$od/$(printf '%s' "$realblob" | cut -c1-2)/$(printf '%s' "$realblob" | cut -c3-)
forgedfile=$od/$(printf '%s' "$forged" | cut -c1-2)/$(printf '%s' "$forged" | cut -c3-)
cp "$realfile" "$T/realobj"
chmod u+w "$realfile" && cat "$forgedfile" > "$realfile"
# Test setup, not a check: a git that verifies loose objects on read only makes the gate safer.
git cat-file blob "$realblob" 2>/dev/null | grep -q "hunter2" || echo 'note: this git verifies loose object hashes on read'
echo "$fx" >> packages/x/src/forge.ts
run "$R" --base "$(git rev-parse kf27forge)"
check 'a forged loose base blob excuses nothing (KF-27a A2)' '[ "$(rc)" = 1 ] && grep -q "^secret-pattern: packages/x/src/forge.ts:3 (password-assignment)$" "$T/o" && ! grep -q "^baseline-excused:" "$T/o"'
cat "$T/realobj" > "$realfile"
git checkout -q -- packages/x/src/forge.ts
git tag -d kf27tree kf27twice kf27forge > /dev/null
git reset -q --hard "$head0" && git tag -d kf27base kf27nul > /dev/null

# KF-14e follow-up: a symlink that stays inside the worktree is still a finding.
ln -s a.ts packages/x/src/inlink
run "$R" --base base
check 'a symlink inside the worktree is a symlink finding (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^symlink: packages/x/src/inlink$" "$T/o"'
rm -f packages/x/src/inlink

# KF-14e follow-up: git config keys naming a helper in the repository config are findings, the
# subsection masked.
git config core.fsmonitor false
run "$R" --base base
check 'core.fsmonitor in the repository config is git-config-helper (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^git-config-helper: core.fsmonitor$" "$T/o"'
git config --unset core.fsmonitor
git config diff.lanepicked.command true
run "$R" --base base
check 'a diff driver command is git-config-helper with the subsection masked (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^git-config-helper: diff.<sub>.command$" "$T/o" && ! grep -q "lanepicked" "$T/o"'
git config --remove-section diff.lanepicked
git config credential.helper store
run "$R" --base base
check 'a credential helper is git-config-helper (KF-27)' '[ "$(rc)" = 1 ] && grep -q "^git-config-helper: credential.helper$" "$T/o"'
git config --unset credential.helper
# KF-27a (Fable review A4): keys the orchestrator's later git calls would honour.
git config pager.log 'true'
git config url.lanepicked.insteadOf https://example.invalid/
git config include.path /nonexistent-kf27
git config 'includeIf.onbranch:lanepicked.path' /nonexistent-kf27
git config submodule.lanesub.update '!true'
git config submodule.othersub.update checkout
run "$R" --base base
check 'pager.<cmd> is git-config-helper with the command name masked (KF-27a A4, KF-27b Fable)' '[ "$(rc)" = 1 ] && grep -q "^git-config-helper: pager.<cmd>$" "$T/o" && ! grep -q "pager.log" "$T/o"'
check 'url.<base>.insteadOf is git-config-helper, subsection masked (KF-27a A4)' 'grep -q "^git-config-helper: url.<sub>.insteadof$" "$T/o" && ! grep -q "lanepicked" "$T/o"'
check 'include.path and includeIf.<cond>.path are git-config-helper (KF-27a A4)' 'grep -q "^git-config-helper: include.path$" "$T/o" && grep -q "^git-config-helper: includeif.<sub>.path$" "$T/o"'
check 'a submodule update that runs a command is reported, a plain one is not, and no value is printed (KF-27a A4)' '[ "$(grep -c "^git-config-helper: submodule.<sub>.update$" "$T/o")" = 1 ] && ! grep -q "!true" "$T/o" && ! grep -q "lanesub\|othersub" "$T/o"'
git config --unset pager.log
git config --remove-section url.lanepicked
git config --unset include.path
git config --remove-section 'includeIf.onbranch:lanepicked'
git config --remove-section submodule.lanesub
git config --remove-section submodule.othersub
hd=$(git rev-parse --git-common-dir)/hooks
mkdir -p "$hd"
printf '#!/bin/sh\nexit 0\n' > "$hd/pre-commit"
printf '#!/bin/sh\n' > "$hd/pre-push.sample"
run "$R" --base base
check 'a hook file is git-hook by name; a .sample is not (KF-27a A4)' '[ "$(rc)" = 1 ] && grep -q "^git-hook: pre-commit$" "$T/o" && ! grep -q "^git-hook: pre-push.sample$" "$T/o"'
rm -f "$hd/pre-commit"
run "$R" --base base
check 'with the helper keys removed the tree is clean again (KF-27)' '[ "$(rc)" = 0 ]'

# Speed plan S2: the protected rules run once over the whole candidate list. A large ignored tree
# (thousands of dependency files) gives exactly the per-path findings: protected names at any depth,
# matched case-insensitively, package.json exempt only under node_modules/, nothing else.
i=0
while [ "$i" -lt 1500 ]; do
  mkdir -p "node_modules/pkg$i"
  : > "node_modules/pkg$i/index.js"
  : > "node_modules/pkg$i/package.json"
  i=$((i + 1))
done
mkdir -p node_modules/a/.claude "node_modules/sp ace" node_modules/B secrets
: > node_modules/a/.claude/x
: > node_modules/a/.npmrc
: > "node_modules/sp ace/.npmrc"
: > node_modules/B/.NPMRC
: > secrets/package.json
run "$R" --base base
grep '^protected: ' "$T/o" > "$T/prot"
printf '%s\n' 'protected: node_modules/B/.NPMRC' 'protected: node_modules/a/.claude/x' 'protected: node_modules/a/.npmrc' 'protected: node_modules/sp ace/.npmrc' 'protected: secrets/package.json' > "$T/prot-want"
check 'a large ignored tree gives exactly the protected findings, in candidate order (S2)' '[ "$(rc)" = 1 ] && cmp -s "$T/prot" "$T/prot-want" && [ "$(grep -c "^protected: " "$T/o")" = 5 ]'
rm -rf node_modules secrets

echo
echo "$(grep -o "check '" "$self" | wc -l | tr -d ' ') checks defined, $fails failed"
[ "$fails" = 0 ]
