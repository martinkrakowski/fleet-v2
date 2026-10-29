#!/bin/sh
# Tests for bin/kill-worktree-tree: real processes in a temp worktree, the
# script kills only what runs inside it. Skips when /proc is unavailable
# (non-Linux hosts). Run it as `sh`, `dash` or `zsh tests/kill-worktree-tree.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/bin/kill-worktree-tree
if [ ! -r /proc/self/cwd ]; then
  echo 'ok   skipped: no /proc'
  exit 0
fi
T=$(mktemp -d "${TMPDIR:-/tmp}/kill-worktree-tree-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

tracked=''
track() { tracked="$tracked $1"; }
alive() { kill -0 "$1" 2>/dev/null; }
# Wait until a pid is gone (reaped), bounded.
wait_gone() {
  i=0
  while alive "$1" && [ "$i" -lt 50 ]; do
    sleep 0.1 2>/dev/null || sleep 1
    i=$((i + 1))
  done
  ! alive "$1"
}
# Every pid whose cmdline contains the given text.
scan_pids() {
  for entry in /proc/[0-9]*; do
    [ -r "$entry/cmdline" ] || continue
    if tr '\0' ' ' < "$entry/cmdline" 2>/dev/null | grep -qF -- "$1"; then
      printf '%s ' "${entry#/proc/}"
    fi
  done
}
finish() {
  for pid in $tracked; do
    kill -KILL "$pid" 2>/dev/null
  done
  rm -rf "$T"
}
trap finish EXIT

mkdir "$T/wt" "$T/other" "$T/wt/sub" "$T/wt space"

# (a) The owner's probe: `sh -c 'sleep 1207 & sleep 1208'` with its cwd inside
# wt/, plus a sibling sleep that must survive. The cd-ing subshell execs the
# sh so exactly the sh and its two sleeps sit inside wt.
(cd "$T/wt" && exec sh -c 'sleep 1207 & sleep 1208') &
probe=$!
track "$probe"
(cd "$T/other" && exec sleep 1209) &
sibling=$!
track "$sibling"
i=0
while [ ! -d "/proc/$probe" ] && [ "$i" -lt 50 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done
# Both sleeps must exist before the kill run, or the count is not 3.
i=0
while [ -z "$(scan_pids 'sleep 1207')" ] && [ "$i" -lt 50 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done
out=$(sh "$SCRIPT" "$T/wt" 1)
rc=$?
if [ "$rc" -eq 0 ] && [ "$(printf '%s\n' "$out" | tail -n 1)" = 'killed=3' ]; then
  ok 'the probe run prints killed=3 and exits 0'
else
  bad "the probe run prints killed=3 and exits 0 (rc $rc, out $out)"
fi
wait_gone "$probe" && ok 'the sh is gone' || bad 'the sh is gone'
[ -z "$(scan_pids 'sleep 1207')" ] && ok 'sleep 1207 is gone' || bad 'sleep 1207 is gone'
[ -z "$(scan_pids 'sleep 1208')" ] && ok 'sleep 1208 is gone' || bad 'sleep 1208 is gone'
alive "$sibling" && ok 'the sibling sleep survives' || bad 'the sibling sleep survives'
kill "$sibling" 2>/dev/null
wait_gone "$sibling" || true

# (b) A process that ignores TERM is killed after the grace period.
(cd "$T/wt/sub" && exec sh -c 'trap "" TERM; sleep 1210') &
stubborn=$!
track "$stubborn"
i=0
while [ ! -d "/proc/$stubborn" ] && [ "$i" -lt 50 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done
out=$(sh "$SCRIPT" "$T/wt" 1)
if [ "$?" -eq 0 ] && wait_gone "$stubborn" && [ -z "$(scan_pids 'sleep 1210')" ]; then
  ok 'a TERM-ignoring process is gone after the grace'
else
  bad 'a TERM-ignoring process is gone after the grace'
fi

# (c) A symlink to the worktree still kills: the path is resolved physically.
(cd "$T/wt" && exec sleep 1211) &
sym_sleeper=$!
track "$sym_sleeper"
ln -s "$T/wt" "$T/wt-link"
i=0
while [ ! -d "/proc/$sym_sleeper" ] && [ "$i" -lt 50 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done
out=$(sh "$SCRIPT" "$T/wt-link" 1)
if [ "$?" -eq 0 ] && [ "$(printf '%s\n' "$out" | tail -n 1)" = 'killed=1' ] && wait_gone "$sym_sleeper"; then
  ok 'a symlinked worktree path still kills'
else
  bad 'a symlinked worktree path still kills'
fi

# (d) A worktree path containing a space.
(cd "$T/wt space" && exec sleep 1212) &
spaced_sleeper=$!
track "$spaced_sleeper"
i=0
while [ ! -d "/proc/$spaced_sleeper" ] && [ "$i" -lt 50 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done
out=$(sh "$SCRIPT" "$T/wt space" 1)
if [ "$?" -eq 0 ] && [ "$(printf '%s\n' "$out" | tail -n 1)" = 'killed=1' ] && wait_gone "$spaced_sleeper"; then
  ok 'a worktree path containing a space kills'
else
  bad 'a worktree path containing a space kills'
fi

# (e) A missing directory prints killed=0 and exits 0.
out=$(sh "$SCRIPT" "$T/missing" 2>/dev/null)
if [ "$?" -eq 0 ] && [ "$out" = 'killed=0' ]; then
  ok 'a missing directory prints killed=0 and exits 0'
else
  bad "a missing directory prints killed=0 and exits 0 ($out)"
fi

# (f) With no worktree argument the script exits 2.
sh "$SCRIPT" >/dev/null 2>&1
[ "$?" -eq 2 ] && ok 'no argument is a usage error' || bad 'no argument is a usage error'

[ "$fails" -eq 0 ] && echo 'kill-worktree-tree: all tests passed' || echo "kill-worktree-tree: $fails failure(s)"
[ "$fails" -eq 0 ]
