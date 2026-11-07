#!/bin/sh
# Tests bin/agy-run --ephemeral-home: the lane gets a throwaway HOME, the host's agy home is never
# written by the lane, and the home is removed when the run ends while the worktree is untouched.
# Nothing here runs the real agy: a fake `agy` records the HOME it was given and writes into it.
# Run it as `sh`, `dash` or `zsh tests/agy-run-ephemeral-home.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=${AGY_TEST_SCRIPT:-$here/bin/agy-run}
RUNSH=${AGY_TEST_SH:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/agy-eph-test.XXXXXX") || exit 1
T=$(cd "$T" && pwd -P)
mkdir -p "$T/bin"
fails=0; n=0
ok() { n=$((n + 1)); printf 'ok %s - %s\n' "$n" "$1"; }
bad() { n=$((n + 1)); printf 'not ok %s - %s\n' "$n" "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
trap 'rm -rf "$T"' EXIT

# The fake agy records the HOME, XDG_CONFIG_HOME and cwd it ran with, and writes a file into its
# HOME so a test can prove which home the lane actually used.
cat > "$T/bin/agy" <<FAKE
#!/bin/sh
printf '%s\n' "\$HOME" > "$T/home.log"
printf '%s\n' "\${XDG_CONFIG_HOME:-unset}" > "$T/xdg.log"
mkdir -p "\$HOME/.gemini/antigravity-cli/bin" 2>/dev/null
echo lane-wrote-this > "\$HOME/.gemini/antigravity-cli/bin/marker" 2>/dev/null
printf '{"conversation_id":"c1","status":"SUCCESS","response":"Changed a.ts","duration_seconds":1.0,"num_turns":1,"usage":{"total_tokens":6}}'
FAKE
chmod +x "$T/bin/agy"
PATH="$T/bin:$PATH"; export PATH

mkrepo() {
  mkdir -p "$1" && cd "$1" || exit 1
  git init -q . && git config user.email t@example.invalid && git config user.name t
  printf '/.lane/\n' > .gitignore && echo 'export const a = 1;' > a.ts
  git add . && git -c commit.gpgsign=false commit -q -m init
  mkdir -p .lane && echo '# brief' > .lane/brief.md
  cd "$T" || exit 1
}
mkrepo "$T/wt"
WT=$T/wt
export XDG_STATE_HOME="$T/state"

# The host's own agy home, with a sign-in to seed and a pinned install dir the lane must not touch.
SEED=$T/seed/.gemini/antigravity-cli
mkdir -p "$SEED/bin"
printf 'oauth-token-contents\n' > "$SEED/antigravity-oauth-token"
printf 'pinned\n' > "$SEED/bin/installed"
seed_before=$(ls -1 "$SEED/bin")

BASE=$T/homes
run() { env AGY_HOME_BASE="$BASE" AGY_SEED_HOME="$SEED" "$RUNSH" "$SCRIPT" "$@" > "$T/o" 2> "$T/e"; echo $? > "$T/rc"; }
rc() { cat "$T/rc"; }

check 'the fake agy is first on PATH' '[ "$(command -v agy)" = "$T/bin/agy" ]'

run --ephemeral-home --detach --dir "$WT" --model m
check '--ephemeral-home with --detach is a usage error' '[ "$(rc)" = 2 ] && grep -q "cannot be combined with --detach" "$T/e"'
check 'the refused combination created no home' '[ ! -d "$BASE" ]'

run --ephemeral-home --dir "$WT" --model m
check 'the run exits 0' '[ "$(rc)" = 0 ]'
check 'the lane ran with a HOME under the base' 'case "$(cat "$T/home.log")" in "$BASE"/*) true ;; *) false ;; esac'
check 'XDG_CONFIG_HOME points inside that home' '[ "$(cat "$T/xdg.log")" = "$(cat "$T/home.log")/.config" ]'
check 'the lane home is removed when the run ends' '[ ! -e "$(cat "$T/home.log")" ]'
check 'the base is left behind for the next run' '[ -d "$BASE" ]'
check 'no lane home is left under the base' '[ -z "$(ls -A "$BASE")" ]'
check "the host's agy install dir is untouched" '[ "$(ls -1 "$SEED/bin")" = "$seed_before" ]'
check "the lane never wrote the host's agy home" '[ ! -e "$SEED/bin/marker" ]'
check 'the worktree still holds its files' '[ -f "$WT/a.ts" ] && [ -f "$WT/.lane/brief.md" ]'

# The sign-in is seeded, readable only by its owner, and byte-identical.
cat > "$T/bin/agy" <<FAKE
#!/bin/sh
cp "\$HOME/.gemini/antigravity-cli/antigravity-oauth-token" "$T/token.copy" 2>/dev/null
ls -l "\$HOME/.gemini/antigravity-cli/antigravity-oauth-token" > "$T/token.mode" 2>/dev/null
printf '{"conversation_id":"c2","status":"SUCCESS","response":"ok","usage":{"total_tokens":1}}'
FAKE
chmod +x "$T/bin/agy"
run --ephemeral-home --dir "$WT" --model m
check "the lane home carries the host's sign-in" '[ "$(cat "$T/token.copy" 2>/dev/null)" = "oauth-token-contents" ]'
check 'the seeded sign-in is owner-only' 'case "$(cat "$T/token.mode" 2>/dev/null)" in -rw-------*) true ;; *) false ;; esac'

# Without the flag the lane keeps the host's HOME, so nothing changes for existing callers.
cat > "$T/bin/agy" <<FAKE
#!/bin/sh
printf '%s\n' "\$HOME" > "$T/home.log"
printf '{"conversation_id":"c3","status":"SUCCESS","response":"ok","usage":{"total_tokens":1}}'
FAKE
chmod +x "$T/bin/agy"
run --dir "$WT" --model m
check 'without the flag the lane keeps the caller HOME' '[ "$(cat "$T/home.log")" = "$HOME" ]'

# The environment variable turns it on, so a caller that cannot add a flag still gets a lane home.
env AGY_EPHEMERAL_HOME=1 AGY_HOME_BASE="$BASE" AGY_SEED_HOME="$SEED" "$RUNSH" "$SCRIPT" --dir "$WT" --model m > "$T/o" 2> "$T/e"; echo $? > "$T/rc"
check 'AGY_EPHEMERAL_HOME=1 gives the lane its own home' '[ "$(rc)" = 0 ] && case "$(cat "$T/home.log")" in "$BASE"/*) true ;; *) false ;; esac'
env AGY_EPHEMERAL_HOME=yes "$RUNSH" "$SCRIPT" --dir "$WT" --model m > "$T/o" 2> "$T/e"; echo $? > "$T/rc"
check 'a bad AGY_EPHEMERAL_HOME is a usage error' '[ "$(rc)" = 2 ] && grep -q "must be 0 or 1" "$T/e"'

# A symlinked base is refused rather than followed.
rm -rf "$BASE"; mkdir -p "$T/elsewhere"; ln -s "$T/elsewhere" "$BASE"
run --ephemeral-home --dir "$WT" --model m
check 'a symlinked base is refused' '[ "$(rc)" = 2 ] && grep -q "is a symlink" "$T/e"'
check 'nothing was written through the symlink' '[ -z "$(ls -A "$T/elsewhere")" ]'
rm -f "$BASE"

# A relative base is refused.
env AGY_HOME_BASE="relative/path" AGY_SEED_HOME="$SEED" "$RUNSH" "$SCRIPT" --ephemeral-home --dir "$WT" --model m > "$T/o" 2> "$T/e"; echo $? > "$T/rc"
check 'a relative base is refused' '[ "$(rc)" = 2 ] && grep -q "absolute path" "$T/e"'

printf '1..%s\n' "$n"
[ "$fails" = 0 ]
