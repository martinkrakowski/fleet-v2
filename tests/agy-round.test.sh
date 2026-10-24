#!/bin/sh
# Tests for bin/agy-round. Nothing here reaches a host: fake `ssh`, `scp` and `sleep` are first
# on PATH, and the "container" is a real mirror tree under the temp dir (AGY_ROUND_ROOT points
# straight at it), so `prepare` and `fetch` run real git against local repos while the fake ssh
# never contacts anything. The fake ssh executes the single-quoted remote command after
# reconstructing its argv (eval), which is also how the quoting checks prove intactness.
# Run it as `sh`, `dash` or `zsh tests/agy-round.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
SCRIPT=${AGY_ROUND_TEST_SCRIPT:-$here/bin/agy-round}
RUNSH=${AGY_ROUND_TEST_SH:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/agy-round-test.XXXXXX") || exit 1
T=$(cd "$T" && pwd -P)
mkdir -p "$T/bin" "$T/container"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
finish() {
  rm -rf "$T"
}
trap finish EXIT

# Write a fake tool from a heredoc: the heredoc is quoted so every $ stays literal, then the
# __T__ placeholder is substituted with the temp dir by awk (POSIX).
fakefrom() { # $1: target name, $2: heredoc source file
  awk -v t="$T" '{ gsub(/__T__/, t); print }' "$2" > "$T/bin/$1"
  chmod +x "$T/bin/$1"
}

run() { # runs the script, keeps stdout/stderr/exit in $T/o $T/e $T/rc
  "$RUNSH" "$SCRIPT" "$@" > "$T/o" 2> "$T/e"
  echo $? > "$T/rc"
}
rc() { cat "$T/rc"; }

# The fake ssh: logs its argv, then simulates the lane host (or the guard host). It evaluates the
# single-quoted remote command string to recover the exact argv (the script's shq quoting is what
# makes this faithful), appends that to $T/ssh-decoded.log and answers from fixture files or env
# knobs. Git transport (`git-receive-pack`/`git-upload-pack`) is served by the real git against
# the mirror tree, so `prepare`/`fetch` run real git end to end.
cat > "$T/ssh.src" <<'FAKESSH'
#!/bin/sh
printf '%s\n' "$@" >> "__T__/ssh.log"
dest=''
skip=0
cmd=''
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -o) skip=1 ;;
    -o=*) ;;
    -*) ;;
    *) if [ -z "$dest" ]; then dest=$a; else cmd="$cmd $a"; fi ;;
  esac
done
cmd=${cmd# }
case "$dest" in
  guard)
    n=$(cat "__T__/guard-count" 2>/dev/null || echo 0)
    n=$((n + 1)); echo "$n" > "__T__/guard-count"
    fail_on=$(cat "__T__/guard-fail-on" 2>/dev/null || echo 0)
    [ -n "$fail_on" ] && [ "$n" = "$fail_on" ] && exit 1
    exit 0
    ;;
esac
eval "set -- $cmd"
printf '%s\n' "$@" >> "__T__/ssh-decoded.log"
case "$1" in
  git)
    shift
    d=''
    if [ "${1:-}" = -C ]; then d=$2; shift 2; fi
    while [ "${1:-}" = -c ] && [ "$#" -ge 2 ]; do shift 2; done
    sub=${1:-}; shift
    case "$sub" in
      init) [ "$1" = -q ] && shift; mkdir -p "$(dirname "$1")"; git init -q "$1" ;;
      checkout) [ "$1" = -q ] && shift; git -C "$d" checkout -q "$1" ;;
      check-ignore) [ ! -f "__T__/ignore-fail" ] ;;
      status) git -C "$d" status --porcelain ;;
      diff)
        if [ "$1" = --stat ]; then git -C "$d" diff --stat
        elif [ "$1" = --cached ] && [ "$2" = --quiet ]; then git -C "$d" diff --cached --quiet
        fi
        ;;
      add) shift; git -C "$d" add -- "$@" ;;
      commit)
        f=''; prev=''
        for a in "$@"; do [ "$prev" = -F ] && f=$a; prev=$a; done
        git -C "$d" -c core.hooksPath=/dev/null commit -q -F "$f"
        ;;
      log) git -C "$d" log --oneline -1 ;;
    esac
    ;;
  agy-run)
    printf '%s\n' "$@" >> "__T__/agyrun.log"
    d=''; prev=''
    for a in "$@"; do [ "$prev" = --dir ] && d=$a; prev=$a; done
    if [ -f "__T__/agy-make-changes" ] && [ -n "$d" ]; then
      if [ -f "$d/a.ts" ]; then echo 'change' >> "$d/a.ts"; else echo 'change' > "$d/new.md"; fi
    fi
    if [ -f "__T__/agy-out" ]; then cat "__T__/agy-out"; fi
    rc=$(cat "__T__/agyrc" 2>/dev/null)
    exit "${rc:-0}"
    ;;
  mkdir) shift; mkdir -p "$@" ;;
  rm) shift; rm -f "$@" ;;
  git-receive-pack)
    shift; mkdir -p "$(dirname "$1")"
    [ -d "$1" ] || git init -q "$1"
    exec git receive-pack "$1"
    ;;
  git-upload-pack) shift; exec git upload-pack "$1" ;;
  test) shift; [ "$1" = -e ] && shift; test -e "$1" ;;
esac
FAKESSH
fakefrom ssh "$T/ssh.src"

# The fake scp: copies the local file into the mirror tree under the container root.
cat > "$T/scp.src" <<'FAKESCP'
#!/bin/sh
printf '%s\n' "$@" >> "__T__/scp.log"
local=''; remote=''
for a in "$@"; do
  case "$a" in
    -q) ;;
    *:*) remote=$a ;;
    *) local=$a ;;
  esac
done
rpath=${remote#*:}
mkdir -p "$(dirname "$rpath")"
cp "$local" "$rpath"
FAKESCP
fakefrom scp "$T/scp.src"

# The fake sleep: makes the settle wait instant.
cat > "$T/sleep.src" <<'FAKESLEEP'
#!/bin/sh
printf '%s\n' "$@" >> "__T__/sleep.log"
exit 0
FAKESLEEP
fakefrom sleep "$T/sleep.src"

rm -f "$T/ssh.src" "$T/scp.src" "$T/sleep.src"

PATH="$T/bin:$PATH"
export PATH

export AGY_ROUND_SSH=lane
export AGY_ROUND_ROOT="$T/container"
export AGY_ROUND_GUARD_SSH=guard
export AGY_ROUND_GUARD_CMD='the-guard-cmd'
export AGY_ROUND_SETTLE=0

# A real throwaway repo for `prepare --from` (and a brief/commit message fixture).
mkdir -p "$T/from"
(
  cd "$T/from" || exit 1
  git init -q .
  git config user.email t@example.invalid
  git config user.name t
  printf '%s\n' '/.lane/' > .gitignore
  echo 'export const a = 1;' > a.ts
  git add .
  git -c commit.gpgsign=false commit -q -m init
)
echo 'brief body' > "$T/brief.md"
echo 'commit message' > "$T/msg"

# A mirror container clone with a tracked file, gitignored .lane/ and a commit.
mkcontainer() {
  (
    mkdir -p "$T/container/$1"
    cd "$T/container/$1" || exit 1
    git init -q .
    git config user.email t@example.invalid
    git config user.name t
    printf '%s\n' '/.lane/' > .gitignore
    echo 'export const a = 1;' > a.ts
    git add .
    git -c commit.gpgsign=false commit -q -m init
  )
}

echo '# guards'
check 'script under test exists' '[ -f "$SCRIPT" ]'
check 'fake ssh is first on PATH' '[ "$(command -v ssh)" = "$T/bin/ssh" ]'
[ "$fails" = 0 ] || exit 1

echo '# missing env variables (exit 2 naming the variable)'
for v in AGY_ROUND_SSH AGY_ROUND_ROOT AGY_ROUND_GUARD_SSH AGY_ROUND_GUARD_CMD; do
  env -u "$v" "$RUNSH" "$SCRIPT" run --name n --model m --brief .lane/x.md > "$T/o" 2> "$T/e"; echo $? > "$T/rc"
  check "missing $v is a usage error (2) naming the variable" '[ "$(rc)" = 2 ] && grep -q "'$v'" "$T/e"'
done

echo '# validation'
run prepare --name ../x --branch b --brief "$T/brief.md" --from "$T/from"
check 'a bad --name (../x) is a usage error (2)' '[ "$(rc)" = 2 ]'
run prepare --name A --branch b --brief "$T/brief.md" --from "$T/from"
check 'a bad --name (A) is a usage error (2)' '[ "$(rc)" = 2 ]'
run prepare --name '' --branch b --brief "$T/brief.md" --from "$T/from"
check 'an empty --name is a usage error (2)' '[ "$(rc)" = 2 ]'
run prepare --name n --branch 'weird branch' --brief "$T/brief.md" --from "$T/from"
check 'a bad --branch is a usage error (2)' '[ "$(rc)" = 2 ]'
run run --name n --model m --brief x.md
check 'a run brief outside .lane/ is a usage error (2)' '[ "$(rc)" = 2 ]'
run run --name n --model m --brief .lane/../x
check 'a run brief with .. is a usage error (2)' '[ "$(rc)" = 2 ]'
run run --name n --brief .lane/x.md
check 'run without --model is a usage error (2)' '[ "$(rc)" = 2 ]'
run commit --name n --message-file "$T/msg" -- .lane/x
check 'commit refusing .lane/x is a usage error (2)' '[ "$(rc)" = 2 ]'
run commit --name n --message-file "$T/msg" -- .git/config
check 'commit refusing .git/config is a usage error (2)' '[ "$(rc)" = 2 ]'
run commit --name n --message-file "$T/msg" -- ../x
check 'commit refusing ../x is a usage error (2)' '[ "$(rc)" = 2 ]'
run commit --name n --message-file "$T/msg"
check 'commit with no paths is a usage error (2)' '[ "$(rc)" = 2 ]'
check 'no fake ssh ran during validation' '[ ! -s "$T/ssh.log" ]'

mkcontainer n
echo '# run: guard before'
rm -f "$T/agyrun.log"; : > "$T/guard-count"; echo 1 > "$T/guard-fail-on"
run run --name n --model m --brief .lane/x.md
check 'guard failing before the run is 1' '[ "$(rc)" = 1 ] && grep -q "hash check failed before the run" "$T/e"'
check 'agy-run is never invoked when the guard fails before' '[ ! -f "$T/agyrun.log" ]'

echo '# run: guard after'
rm -f "$T/agyrun.log"; : > "$T/guard-count"; echo 2 > "$T/guard-fail-on"
run run --name n --model m --brief .lane/x.md
check 'guard failing after the run is 1' '[ "$(rc)" = 1 ] && grep -q "hash check failed after the run" "$T/e"'
check 'agy-run ran before the after-guard failed' '[ -f "$T/agyrun.log" ]'

echo '# run: exact flags and results'
rm -f "$T/guard-fail-on" "$T/agy-make-changes"; : > "$T/guard-count"; rm -f "$T/agyrun.log"
run run --name n --model m --brief .lane/x.md
check 'run with no changes is 1 and says no edits' '[ "$(rc)" = 1 ] && grep -q "no edits" "$T/e"'
touch "$T/agy-make-changes"; : > "$T/guard-count"; rm -f "$T/agyrun.log"
run run --name n --model prov/model-x --brief .lane/x.md
check 'a run with edits exits 0' '[ "$(rc)" = 0 ]'
check 'agy-run is passed --mode full' 'grep -A1 -x -- "--mode" "$T/agyrun.log" | grep -qx full'
check 'agy-run is passed --isolation-declared' 'grep -qx -- "--isolation-declared" "$T/agyrun.log"'
check 'agy-run is passed --sandbox' 'grep -qx -- "--sandbox" "$T/agyrun.log"'
check 'agy-run is never passed --dangerously-skip-permissions' '! grep -q "dangerously" "$T/agyrun.log"'
check 'the run prints git status --porcelain' 'grep -q -- "--- git status --porcelain ---" "$T/o"'
check 'the run prints git diff --stat' 'grep -q -- "--- git diff --stat ---" "$T/o"'

echo '# prepare'
mkcontainer c1
run prepare --name c1 --branch b --brief "$T/brief.md" --from "$T/from"
check 'prepare refuses an existing clone (75)' '[ "$(rc)" = 75 ] && grep -q "already exists" "$T/e"'
run prepare --name p --branch feat/x --brief "$T/brief.md" --from "$T/from"
check 'prepare exits 0' '[ "$(rc)" = 0 ]'
check 'prepare prints the clone log' 'grep -q "init" "$T/o"'
check 'prepare prints the brief path for run' 'grep -qx ".lane/brief.md" "$T/o"'
check 'the clone is on the pushed branch' '[ "$(git -C "$T/container/p" rev-parse --abbrev-ref HEAD)" = feat/x ]'
check 'the brief landed in the clone .lane' '[ -f "$T/container/p/.lane/brief.md" ]'

echo '# fetch'
mkcontainer f2
git -C "$T/container/f2" checkout -q -b feat/y
echo 'lane work' >> "$T/container/f2/a.ts"
git -C "$T/container/f2" add .
git -C "$T/container/f2" -c commit.gpgsign=false commit -q -m 'lane work'
mkdir -p "$T/into"; git init -q "$T/into"
git -C "$T/into" config user.email t@example.invalid
git -C "$T/into" config user.name t
run fetch --name f2 --branch feat/y --into "$T/into"
check 'fetch exits 0' '[ "$(rc)" = 0 ]'
check 'fetch creates the forced -argon ref' 'git -C "$T/into" rev-parse --verify -q feat/y-argon >/dev/null'
check 'fetch prints the new ref commit' 'grep -q "lane work" "$T/o"'

echo '# quoting (a path with a single quote survives intact)'
rm -f "$T/guard-fail-on" "$T/agy-make-changes"; : > "$T/guard-count"; rm -f "$T/agyrun.log" "$T/ssh-decoded.log"
qbrief=".lane/ab'm.md"
run run --name n --model m --brief "$qbrief"
check 'a brief path with a single quote reaches the fake ssh as one intact argument' 'grep -Fqx "'"$qbrief"'" "$T/ssh-decoded.log"'
check 'agy-run received the quoted brief intact' 'grep -Fqx "'"$qbrief"'" "$T/agyrun.log"'

echo '# no owner values in the script'
check 'no @ in the script' '! grep -q "@" "$SCRIPT"'
check 'no IPv4 literal in the script' '! grep -Eq "[0-9]{1,3}(\.[0-9]{1,3}){3}" "$SCRIPT"'
check 'no /mnt/ in the script' '! grep -q "/mnt/" "$SCRIPT"'
check 'no /home/ in the script' '! grep -q "/home/" "$SCRIPT"'
check 'no /Users/ in the script' '! grep -q "/Users/" "$SCRIPT"'

echo
echo "$(grep -o "check '" "$self" | wc -l | tr -d ' ') checks defined, $fails failed"
[ "$fails" = 0 ]
