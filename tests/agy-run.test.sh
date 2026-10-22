#!/bin/sh
# Tests for bin/agy-run. Nothing here runs the real agy or reaches another host:
#   - a fake `agy` is first on PATH and records its arguments;
#   - every worktree is a throwaway git repository under a temp dir.
# The FIRST checks prove those guards and stop the file if one is missing.
# Run it as `sh`, `dash` or `zsh tests/agy-run.test.sh`. The script under test runs under AGY_TEST_SH (default sh).
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
SCRIPT=${AGY_TEST_SCRIPT:-$here/bin/agy-run}
RUNSH=${AGY_TEST_SH:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/agy-run-test.XXXXXX") || exit 1
T=$(cd "$T" && pwd -P)
mkdir -p "$T/bin"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
finish() {
  for p in $(cat "$T/pids" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  pkill -9 -f "$T/bin/agy" 2>/dev/null
  rm -rf "$T"
}
trap finish EXIT

# The fake agy: records its arguments, then behaves as $T/fake-mode says.
cat > "$T/bin/agy" <<FAKE
#!/bin/sh
printf '%s\n' "\$@" > "$T/args.log"
pwd > "$T/cwd.log"
case "\$(cat "$T/fake-mode" 2>/dev/null)" in
  sleep) sleep 60; exit 0 ;;
  empty) printf '{"conversation_id":"c1","status":"SUCCESS","response":"","duration_seconds":1.0,"num_turns":1,"usage":{"total_tokens":10}}'; exit 0 ;;
  nojson) echo "something went wrong"; exit 0 ;;
  denied) printf '{"conversation_id":"c1","status":"SUCCESS","response":"I could not read the brief.","duration_seconds":2.0,"num_turns":1,"denied_actions":[{"action":"read_file"},{"action":"command"},{"action":"read_file"}],"usage":{"total_tokens":20}}'; exit 0 ;;
  error) echo 'AGY_ERROR: {"status":"UNAVAILABLE","retryable":true}' >&2; printf '{"status":"ERROR","response":"partial"}'; exit 3 ;;
  fail) echo "agy: boom" >&2; exit 1 ;;
  *) printf '{"conversation_id":"c1","status":"SUCCESS","response":"Changed a.ts\\n","duration_seconds":2.5,"num_turns":3,"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}'; exit 0 ;;
esac
FAKE
chmod +x "$T/bin/agy"
PATH="$T/bin:$PATH"
export PATH

# The fake ps: logs its arguments, then answers the three queries the script makes —
# `ps -o lstart= -p <pid>` (start time), `ps -p <pid> -o pid=` (existence) and
# `ps -o comm= -p <pid>` (command name) — according to $T/ps-mode (default: fixed start
# time and "sleep" as the command for a living pid; empty: no start time; locale: German-style
# date unless LC_ALL=C and TZ=UTC; eperm: report the pid as existing even when kill cannot
# signal it, to fake a permission error).
cat > "$T/bin/ps" <<FAKEPS
#!/bin/sh
printf '%s\n' "\$@" >> "$T/ps.log"
prev=''
pid=''
opt=''
for a in "\$@"; do
  case "\$a" in
    -p) prev=-p ;;
    -p=*) pid=\${a#-p=}; prev='' ;;
    -o) prev=-o ;;
    -o=*) opt=\${a#-o=}; opt=\${opt%=}; prev='' ;;
    *)
      if [ "\$prev" = -p ]; then pid=\$a; prev=''
      elif [ "\$prev" = -o ]; then opt=\$a; opt=\${opt%=}; prev=''
      fi
      ;;
  esac
done
case "\$pid" in '' | *[!0-9]*) exit 1 ;; esac
case "\$opt" in
  pid)
    case "\$(cat "$T/ps-mode" 2>/dev/null)" in
      eperm) echo "\$pid"; exit 0 ;;
      *) if kill -0 "\$pid" 2>/dev/null; then echo "\$pid"; exit 0; fi; exit 1 ;;
    esac
    ;;
  comm)
    cat "$T/ps-comm" 2>/dev/null || echo sleep
    exit 0
    ;;
  *)
    if kill -0 "\$pid" 2>/dev/null; then
      case "\$(cat "$T/ps-mode" 2>/dev/null)" in
        empty) exit 0 ;;
        locale)
          if [ "\${LC_ALL:-}" = C ] && [ "\${TZ:-}" = UTC ]; then
            echo 'Thu Jan  1 00:00:00 2026'
          else
            echo "Do 1. Jan 00:00:00 \${LC_ALL:-de} \${TZ:-CET} 2026"
          fi
          exit 0
          ;;
        *) echo 'Thu Jan  1 00:00:00 2026'; exit 0 ;;
      esac
    fi
    exit 1
    ;;
esac
FAKEPS
chmod +x "$T/bin/ps"

# The fake rm records every call (the abort tests count how many times the lock is removed),
# then delegates to the real rm.
realrm=$(command -v rm)
cat > "$T/bin/rm" <<FAKERM
#!/bin/sh
printf '%s\n' "\$@" >> "$T/rm.log"
exec $realrm "\$@"
FAKERM
chmod +x "$T/bin/rm"

# A worktree that qualifies: a git repo whose .lane/ is ignored, with a brief inside.
mkrepo() { # $1: dir, $2: gitignore content
  mkdir -p "$1" && cd "$1" || exit 1
  git init -q . && git config user.email t@example.invalid && git config user.name t
  printf '%s\n' "$2" > .gitignore && echo 'export const a = 1;' > a.ts
  git add . && git -c commit.gpgsign=false commit -q -m init
  mkdir -p .lane && echo '# brief' > .lane/brief.md
  cd "$T" || exit 1
}
mkrepo "$T/wt" '/.lane/'
mkrepo "$T/wt-unignored" 'nothing/'
mkdir -p "$T/plain" "$T/wt/sub"
WT=$T/wt

# The lock lives in a per-user state dir, keyed by the physical worktree path, not in the
# worktree. Point XDG_STATE_HOME at the temp dir so no test touches the real HOME.
export XDG_STATE_HOME="$T/state"
LOCKDIR="$T/state/agy-run/locks"
lkhash() { # $1: worktree path
  printf '%s' "$1" | { command -v sha256sum >/dev/null 2>&1 && sha256sum || shasum -a 256; } | awk '{print $1}'
}
LK="$LOCKDIR/$(lkhash "$WT").lock"
mk_lock() { # lock lines: pid, start, model, mode, comm (command defaults to the fake ps's "sleep")
  printf '%s\n' "$1" "$2" "${3:-m}" "${4:-accept-edits}" "${5:-sleep}" > "$LK"
}

run() { # runs the script, keeps stdout/stderr/exit in $T/o $T/e $T/rc
  "$RUNSH" "$SCRIPT" "$@" > "$T/o" 2> "$T/e"
  echo $? > "$T/rc"
}
rc() { cat "$T/rc"; }
# erun VAR=value ... <script args>: run with extra environment. (Assignments before a function call persist in bash's sh mode, so never write VAR=x run.)
erun() { env "$@" > "$T/o" 2> "$T/e"; echo $? > "$T/rc"; }

echo '# guards'
check 'fake agy is first on PATH' '[ "$(command -v agy)" = "$T/bin/agy" ]'
check 'script under test exists' '[ -f "$SCRIPT" ]'
[ "$fails" = 0 ] || exit 1

echo '# usage'
run; check 'no arguments is a usage error (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT"; check 'a run without --model is refused (2)' '[ "$(rc)" = 2 ] && grep -q "needs --model" "$T/e"'
run --dir "$WT" --model m "do this"; check 'a prompt argument is refused (2)' '[ "$(rc)" = 2 ] && grep -q "takes no prompt" "$T/e"'
run --dir "$WT" --model m --dangerously-skip-permissions; check '--dangerously-skip-permissions is refused (2)' '[ "$(rc)" = 2 ] && grep -q "refusing --dangerously-skip-permissions" "$T/e"'
run --dir "$WT" --model m --isolation-declared --dangerously-skip-permissions; check '--isolation-declared alone does not widen permissions (2)' '[ "$(rc)" = 2 ] && grep -q "refusing --dangerously-skip-permissions" "$T/e"'
run --dir "$WT" --model m --mode plan --isolation-declared --dangerously-skip-permissions; check '--dangerously-skip-permissions with a non-full mode is refused (2)' '[ "$(rc)" = 2 ] && grep -q "refusing --dangerously-skip-permissions" "$T/e"'
run --dir "$WT" --model m --mode full; check '--mode full without --isolation-declared is refused (2)' '[ "$(rc)" = 2 ] && grep -q "requires --isolation-declared" "$T/e"'
run --check --dir "$WT" --mode full --isolation-declared --dangerously-skip-permissions; check 'the full pair needs no separate widen flag to be accepted (0)' '[ "$(rc)" = 0 ]'
run --dir "$WT" --model m --isolation-declared; check '--isolation-declared without --mode full is refused (2)' '[ "$(rc)" = 2 ] && grep -q "only accepted with --mode full" "$T/e"'
run --dir "$WT" --model m --mode auto --isolation-declared; check '--isolation-declared does not pair with --mode auto (2)' '[ "$(rc)" = 2 ] && grep -q "only accepted with --mode full" "$T/e"'
run --dir "$WT" --model m --print x; check 'agy print options are refused (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT" --model m --disable-slash-commands; check '--disable-slash-commands is refused (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT" --model m --mode yolo; check 'an unknown --mode is refused (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT" --model m --effort ultra; check 'an unknown --effort is refused (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT" --model m --timeout 5x; check 'a malformed --timeout is refused (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT" --model m --brief ../x.md; check 'a --brief outside the dir is refused (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT" --model m --brief /etc/x.md; check 'an absolute --brief is refused (2)' '[ "$(rc)" = 2 ]'
run --dir "$WT" --model m --brief 'a b'; check 'a --brief value containing whitespace is refused (2)' '[ "$(rc)" = 2 ] && grep -q "whitespace" "$T/e"'
run --dir "$WT" --model --dangerously-skip-permissions; check 'a --model value that is itself a flag is refused (2)' '[ "$(rc)" = 2 ] && grep -q "must not start with" "$T/e"'
run --dir "$WT" --model=-x; check 'a --model= value starting with - is refused (2)' '[ "$(rc)" = 2 ] && grep -q "must not start with" "$T/e"'
run --dir "$WT" --model -x; check 'a --model value starting with - is refused (2)' '[ "$(rc)" = 2 ] && grep -q "must not start with" "$T/e"'
run --dir "$WT" --model 'a b'; check 'a --model value containing whitespace is refused (2)' '[ "$(rc)" = 2 ] && grep -q "contain whitespace" "$T/e"'
run --dir "$WT" --model m --agent --dangerously-skip-permissions; check 'a --agent value that is itself a flag is refused (2)' '[ "$(rc)" = 2 ] && grep -q "must not start with" "$T/e"'
run --dir "$WT" --model m --agent=-x; check 'a --agent= value starting with - is refused (2)' '[ "$(rc)" = 2 ] && grep -q "must not start with" "$T/e"'
run --dir "$WT" --model m --agent -x; check 'a --agent value starting with - is refused (2)' '[ "$(rc)" = 2 ] && grep -q "must not start with" "$T/e"'
run --dir "$WT" --model m --agent 'a b'; check 'a --agent value containing whitespace is refused (2)' '[ "$(rc)" = 2 ] && grep -q "contain whitespace" "$T/e"'
run --status --wait --dir "$WT"; check 'two modes at once is a usage error (2)' '[ "$(rc)" = 2 ]'
check 'no fake agy ran during the usage checks' '[ ! -f "$T/args.log" ]'

echo '# the dir must qualify'
run --dir "$T/missing" --model m; check 'a missing dir is 1' '[ "$(rc)" = 1 ]'
run --dir "$T/plain" --model m; check 'a dir outside git is 1' '[ "$(rc)" = 1 ] && grep -q "not inside a git worktree" "$T/e"'
run --dir "$WT/sub" --model m; check 'a subdirectory of a worktree is 1' '[ "$(rc)" = 1 ] && grep -q "not the root" "$T/e"'
run --dir "$T/wt-unignored" --model m; check 'a worktree where .lane is not ignored is 1' '[ "$(rc)" = 1 ] && grep -q "not gitignored" "$T/e"'
run --dir "$WT" --model m --brief .lane/none.md; check 'a missing brief is 1' '[ "$(rc)" = 1 ] && grep -q "no brief" "$T/e"'
echo '# fix' > "$WT/tracked-brief.md"
run --dir "$WT" --model m --brief tracked-brief.md; check 'a brief that is not ignored is 1' '[ "$(rc)" = 1 ] && grep -q "not gitignored" "$T/e"'
rm -f "$WT/tracked-brief.md"
check 'no fake agy ran during the dir checks' '[ ! -f "$T/args.log" ]'

echo '# --check runs nothing'
run --check; check '--check without a dir is ok (0)' '[ "$(rc)" = 0 ] && grep -q "agy-run: ok" "$T/o"'
run --check --dir "$WT"; check '--check with a qualifying dir says so (0)' '[ "$(rc)" = 0 ] && grep -q "qualifies" "$T/o"'
run --check --dir "$T/plain"; check '--check with a dir outside git is 1' '[ "$(rc)" = 1 ]'
erun PATH="$T/none:/usr/bin:/bin" "$RUNSH" "$SCRIPT" --check; check '--check without agy on PATH is 1' '[ "$(rc)" = 1 ] && grep -q "not on PATH" "$T/e"'
check 'no fake agy ran during --check' '[ ! -f "$T/args.log" ]'

echo '# a run'
rm -f "$T/fake-mode"
run --dir "$WT" --model prov/model-x
check 'a successful run exits 0' '[ "$(rc)" = 0 ]'
check 'stdout is the JSON result' 'grep -q "\"status\":\"SUCCESS\"" "$T/o"'
check 'agy ran in the worktree' '[ "$(cat "$T/cwd.log")" = "$WT" ]'
check 'agy got --print' 'grep -qx -- "--print" "$T/args.log"'
check 'the prompt names the brief and nothing else arrives as prompt' 'grep -q "^Read the file .lane/brief.md in the current directory" "$T/args.log"'
check 'the prompt forbids reading git metadata' 'grep -q "Do not read files under .git" "$T/args.log"'
check 'agy got --output-format json' 'grep -A1 -x -- "--output-format" "$T/args.log" | grep -qx json'
check 'agy got the default --mode accept-edits' 'grep -A1 -x -- "--mode" "$T/args.log" | grep -qx accept-edits'
check 'agy got the model' 'grep -A1 -x -- "--model" "$T/args.log" | grep -qx prov/model-x'
check 'agy got the default --print-timeout 45m' 'grep -A1 -x -- "--print-timeout" "$T/args.log" | grep -qx 45m'
check 'agy did not get --dangerously-skip-permissions' '! grep -q "dangerously" "$T/args.log"'
check 'agy did not get --disable-slash-commands' '! grep -q "disable-slash" "$T/args.log"'
check 'agy did not get --sandbox by default' '! grep -qx -- "--sandbox" "$T/args.log"'
check 'HEAD before dispatch is recorded' '[ "$(cat "$WT/.lane/agy-run.before")" = "$(git -C "$WT" rev-parse HEAD)" ]'
check 'agy-run.last records exit, tokens and no denied actions' 'tail -n1 "$WT/.lane/agy-run.last" | grep -q "exit=0 secs=[0-9]* tokens=6 denied=0 model=prov/model-x mode=accept-edits"'
check 'the lock is gone after the run' '[ ! -f "$LK" ]'
check 'the summary line names the exit and the model' 'grep -q "ended after [0-9]* s with exit 0 (model prov/model-x" "$T/e"'

run --dir "$WT" --model m --effort high --agent lane --mode plan --sandbox --timeout 20m --brief .lane/brief.md
check 'effort, agent, mode, sandbox and timeout pass through' 'grep -A1 -x -- "--effort" "$T/args.log" | grep -qx high && grep -A1 -x -- "--agent" "$T/args.log" | grep -qx lane && grep -A1 -x -- "--mode" "$T/args.log" | grep -qx plan && grep -qx -- "--sandbox" "$T/args.log" && grep -A1 -x -- "--print-timeout" "$T/args.log" | grep -qx 20m'
run --dir "$WT" --model prov/model-x --mode auto
check '--mode auto alone is agy auto and nothing more' '[ "$(rc)" = 0 ] && grep -A1 -x -- "--mode" "$T/args.log" | grep -qx auto && ! grep -q "dangerously" "$T/args.log"'
run --dir "$WT" --model prov/model-x --mode full --isolation-declared
check 'a full run exits 0' '[ "$(rc)" = 0 ]'
check 'a full lane runs agy in --mode auto' 'grep -A1 -x -- "--mode" "$T/args.log" | grep -qx auto'
check 'a full lane is the only one that gets --dangerously-skip-permissions' 'grep -qx -- "--dangerously-skip-permissions" "$T/args.log"'
check 'a full lane still gets the fixed prompt and its model' 'grep -q "^Read the file .lane/brief.md in the current directory" "$T/args.log" && grep -A1 -x -- "--model" "$T/args.log" | grep -qx prov/model-x'
check 'agy-run.last records the full mode and no denied actions' 'tail -n1 "$WT/.lane/agy-run.last" | grep -q "exit=0 secs=[0-9]* tokens=6 denied=0 model=prov/model-x mode=full"'
erun AGY_SANDBOX=1 "$RUNSH" "$SCRIPT" --dir "$WT" --model m
check 'AGY_SANDBOX=1 adds --sandbox' 'grep -qx -- "--sandbox" "$T/args.log"'
echo '# fix 1' > "$WT/.lane/fix-1.md"
run --dir "$WT" --model m --brief .lane/fix-1.md
check 'another ignored brief is named in the prompt' 'grep -q "^Read the file .lane/fix-1.md " "$T/args.log"'
erun AGY_BIN="$T/bin/agy" PATH=/usr/bin:/bin "$RUNSH" "$SCRIPT" --dir "$WT" --model m
check 'AGY_BIN selects the binary' '[ "$(rc)" = 0 ]'

echo '# results that are not clean'
echo empty > "$T/fake-mode"; run --dir "$WT" --model m
check 'an empty response is a failed run (1)' '[ "$(rc)" = 1 ] && grep -q "EMPTY response" "$T/e"'
echo nojson > "$T/fake-mode"; run --dir "$WT" --model m
check 'no JSON result is a failed run (1)' '[ "$(rc)" = 1 ] && grep -q "no JSON result" "$T/e"'
echo denied > "$T/fake-mode"; run --dir "$WT" --model m
check 'denied actions are reported, each once, and the run stays 0' '[ "$(rc)" = 0 ] && grep -q "DENIED itself these actions.*command read_file" "$T/e"'
check 'denied actions are counted in agy-run.last' 'tail -n1 "$WT/.lane/agy-run.last" | grep -q "denied=2"'
mkdir -p "$T/agyhome/conversations"
printf 'blob %s blob %s tail' "denied permission for read_file(/mnt/x/projects/fleet-v2/.git/worktrees/lane/HEAD)" "denied permission for read_file(/mnt/x/projects/fleet-v2/.git/worktrees/lane/HEAD)" > "$T/agyhome/conversations/c1.db"
erun AGY_HOME="$T/agyhome" "$RUNSH" "$SCRIPT" --dir "$WT" --model m
check 'denied targets are named once from agy'"'"'s conversation record' '[ "$(grep -c "read_file(/mnt/x/projects/fleet-v2/.git/worktrees/lane/HEAD)" "$T/e")" = 1 ] && grep -q "denied targets, from agy" "$T/e"'
erun AGY_DENIED_IS_FAILURE=1 "$RUNSH" "$SCRIPT" --dir "$WT" --model m
check 'AGY_DENIED_IS_FAILURE=1 makes denied actions exit 5' '[ "$(rc)" = 5 ]'
echo error > "$T/fake-mode"; run --dir "$WT" --model m
check 'an agy model error (exit 3) becomes exit 4 with AGY_ERROR shown' '[ "$(rc)" = 4 ] && grep -q "AGY_ERROR" "$T/e" && grep -q "model or agent error" "$T/e"'
echo fail > "$T/fake-mode"; run --dir "$WT" --model m
check 'another agy failure passes its exit through (1) with its stderr' '[ "$(rc)" = 1 ] && grep -q "agy: boom" "$T/e"'
check 'the lock is gone after a failed run' '[ ! -f "$LK" ]'

echo '# one lane per worktree'
echo sleep > "$T/fake-mode"
"$RUNSH" "$SCRIPT" --dir "$WT" --model m > "$T/bg.o" 2> "$T/bg.e" &
BG=$!; echo "$BG" >> "$T/pids"
n=0; while [ ! -s "$LK" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
sleep 0.3
run --status --dir "$WT"
check '--status reports a running lane (3) with its pid' '[ "$(rc)" = 3 ] && grep -q "running in $WT (pid [0-9]*, since .*model m)" "$T/o"'
run --dir "$WT" --model m
check 'a second dispatch into a busy worktree is refused (75)' '[ "$(rc)" = 75 ] && grep -q "already running" "$T/e"'
check 'the refused dispatch did not start agy' '[ "$(cat "$T/fake-mode")" = sleep ] && grep -q "already running" "$T/e"'
erun AGY_WAIT_INTERVAL=1 AGY_WAIT_MAX=1 "$RUNSH" "$SCRIPT" --wait --dir "$WT"
check '--wait gives up (75) while the lane runs' '[ "$(rc)" = 75 ] && grep -q "GAVE UP" "$T/e"'
run --abort --dir "$WT"
check '--abort stops the lane (0)' '[ "$(rc)" = 0 ] && grep -q "the lane in .* stopped" "$T/o"'
wait "$BG" 2>/dev/null; bgrc=$?
check 'the dispatcher ended once its lane was aborted' '[ "$bgrc" != 0 ] && [ ! -f "$LK" ]'
run --status --dir "$WT"
check '--status after the abort is 0' '[ "$(rc)" = 0 ]'
run --abort --dir "$WT"
check '--abort with nothing running is 0' '[ "$(rc)" = 0 ]'

echo '# signals'
"$RUNSH" "$SCRIPT" --dir "$WT" --model m > "$T/bg.o" 2> "$T/bg.e" &
BG=$!; echo "$BG" >> "$T/pids"
n=0; while [ ! -s "$LK" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
sleep 0.3
cpid=$(head -n1 "$LK")
kill -TERM "$BG"; wait "$BG" 2>/dev/null; bgrc=$?
sleep 0.5
check 'TERM to the dispatcher exits 143' '[ "$bgrc" = 143 ]'
check 'TERM to the dispatcher stops its lane' '! kill -0 "$cpid" 2>/dev/null'
check 'the stopped run is recorded in agy-run.last' 'tail -n1 "$WT/.lane/agy-run.last" | grep -q "exit=143"'
check 'the lock is released after the stop' '[ ! -f "$LK" ]'

"$RUNSH" "$SCRIPT" --detach --dir "$WT" --model m > "$T/bg.o" 2> "$T/bg.e" &
BG=$!; echo "$BG" >> "$T/pids"
n=0; while [ ! -s "$LK" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
sleep 0.3
cpid=$(head -n1 "$LK")
kill -TERM "$BG"; wait "$BG" 2>/dev/null
sleep 0.3
check 'with --detach the lane survives TERM to the dispatcher' 'kill -0 "$cpid" 2>/dev/null && grep -q "runs on" "$T/bg.e"'
run --status --dir "$WT"
check '--status still sees the detached lane (3)' '[ "$(rc)" = 3 ]'
kill -HUP "$cpid" 2>/dev/null; sleep 0.3
check 'the detached lane ignores HUP' 'kill -0 "$cpid" 2>/dev/null'
run --abort --dir "$WT"
check '--abort stops the detached lane (0)' '[ "$(rc)" = 0 ] && ! kill -0 "$cpid" 2>/dev/null'

echo '# a stale lock'
mk_lock 999999 '2026-01-01T00:00:00Z'
run --status --dir "$WT"
check 'a lock whose pid is gone reads as ended (0) and is removed' '[ "$(rc)" = 0 ] && [ ! -f "$LK" ] && grep -q "ended" "$T/e"'

echo '# the lock lives outside the worktree'
sleep 300 &
OLDPID=$!
echo "$OLDPID" >> "$T/pids"
printf '%s\n' "$OLDPID" 'Thu Jan  1 00:00:00 2026' m accept-edits > "$WT/.lane/agy-run.lock"
run --status --dir "$WT"
check 'a lock planted at the old .lane path is ignored by status (0)' '[ "$(rc)" = 0 ] && grep -q "nothing is running" "$T/o"'
run --abort --dir "$WT"
check 'abort ignores the old .lane lock and never signals its pid' '[ "$(rc)" = 0 ] && kill -0 "$OLDPID" 2>/dev/null'
kill "$OLDPID" 2>/dev/null
rm -f "$WT/.lane/agy-run.lock"
sleep 300 &
CMDPID=$!
echo "$CMDPID" >> "$T/pids"
mk_lock "$CMDPID" 'Thu Jan  1 00:00:00 2026' m accept-edits agy
run --status --dir "$WT"
check 'a state-dir lock whose command name differs reads as ended (0)' '[ "$(rc)" = 0 ] && grep -q "nothing is running" "$T/o"'
run --abort --dir "$WT"
check 'abort never signals a pid whose command name differs (0)' '[ "$(rc)" = 0 ] && kill -0 "$CMDPID" 2>/dev/null'
kill "$CMDPID" 2>/dev/null

echo '# the lock compares pid and process start time'
sleep 300 &
OFDPID=$!
echo "$OFDPID" >> "$T/pids"
mk_lock "$OFDPID" 'Thu Jan  1 00:00:00 1999'
run --status --dir "$WT"
check 'status consults ps for the recorded pid' 'grep -q -x "$OFDPID" "$T/ps.log"'
check 'a live pid whose start time differs reads as nothing (0)' '[ "$(rc)" = 0 ] && grep -q "nothing is running" "$T/o"'
check 'the stale lock is removed after that status' '[ ! -f "$LK" ]'
mk_lock "$OFDPID" 'Thu Jan  1 00:00:00 1999'
run --abort --dir "$WT"
check 'abort never signals a recycled pid (0)' '[ "$(rc)" = 0 ] && grep -q "nothing is running" "$T/o"'
check 'the foreign process is still alive after the abort' 'kill -0 "$OFDPID" 2>/dev/null'
kill "$OFDPID" 2>/dev/null

MATCHPID=$(sh -c 'sleep 300 >/dev/null 2>&1 & echo $!')
echo "$MATCHPID" >> "$T/pids"
mk_lock "$MATCHPID" 'Thu Jan  1 00:00:00 2026'
run --status --dir "$WT"
check 'a live pid with a matching start time reads as running (3) with the pid' '[ "$(rc)" = 3 ] && grep -q "running in $WT (pid $MATCHPID," "$T/o"'
run --abort --dir "$WT"
check 'abort signals a live pid whose start time matches (0) and it is gone afterwards' '[ "$(rc)" = 0 ] && ! kill -0 "$MATCHPID" 2>/dev/null && [ ! -f "$LK" ]'

erun AGY_RUN_ABORT_WAIT=1s "$RUNSH" "$SCRIPT" --abort --dir "$WT"
check 'a non-digit AGY_RUN_ABORT_WAIT is a usage error (2)' '[ "$(rc)" = 2 ]'
erun AGY_RUN_ABORT_WAIT=08 "$RUNSH" "$SCRIPT" --abort --dir "$WT"
check 'a leading-zero AGY_RUN_ABORT_WAIT (dash octal) is a usage error (2)' '[ "$(rc)" = 2 ]'
rm -f "$T/ign.ready"
IGNPID=$(sh -c '( trap "" TERM; : > "$1"; exec sleep 60 ) >/dev/null 2>&1 & echo $!' - "$T/ign.ready")
echo "$IGNPID" >> "$T/pids"
n=0; while [ ! -f "$T/ign.ready" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
mk_lock "$IGNPID" 'Thu Jan  1 00:00:00 2026'
erun AGY_RUN_ABORT_WAIT=1 "$RUNSH" "$SCRIPT" --abort --dir "$WT"
check 'abort escalates to SIGKILL when a matching process ignores TERM (0)' '[ "$(rc)" = 0 ] && ! kill -0 "$IGNPID" 2>/dev/null && grep -q "did not stop in 1 s; killed" "$T/e" && [ ! -f "$LK" ]'

UNRPID=$(sh -c 'sleep 300 >/dev/null 2>&1 & echo $!')
echo "$UNRPID" >> "$T/pids"
echo empty > "$T/ps-mode"
mk_lock "$UNRPID" 'Thu Jan  1 00:00:00 2026'
run --status --dir "$WT"
check 'an empty ps result for a live pid reports start time unreadable (3) and keeps the lock' '[ "$(rc)" = 3 ] && grep -q "running (start time unreadable), pid $UNRPID" "$T/o" && [ -f "$LK" ]'
run --abort --dir "$WT"
check 'abort refuses (1) when start time is unreadable and leaves the process alive' '[ "$(rc)" = 1 ] && kill -0 "$UNRPID" 2>/dev/null && [ -f "$LK" ] && grep -q "check pid $UNRPID by hand" "$T/e"'
kill "$UNRPID" 2>/dev/null
rm -f "$LK" "$T/ps-mode"

echo '# a pid that exists but cannot be signalled is unknown, never gone'
echo eperm > "$T/ps-mode"
mk_lock 999999 'Thu Jan  1 00:00:00 2026'
run --status --dir "$WT"
check 'a pid ps reports but kill cannot signal is unknown (3) and keeps the lock' '[ "$(rc)" = 3 ] && grep -q "cannot be verified" "$T/o" && [ -f "$LK" ]'
run --abort --dir "$WT"
check 'abort refuses (1) an unverifiable pid and keeps the lock' '[ "$(rc)" = 1 ] && [ -f "$LK" ] && grep -q "cannot be verified" "$T/e"'
rm -f "$LK" "$T/ps-mode"

echo empty > "$T/ps-mode"
echo sleep > "$T/fake-mode"
"$RUNSH" "$SCRIPT" --detach --dir "$WT" --model m > "$T/bg.o" 2> "$T/bg.e" &
BG=$!; echo "$BG" >> "$T/pids"
n=0; while [ "$(sed -n 2p "$LK" 2>/dev/null)" != unknown ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
unkpid=$(head -n 1 "$LK" 2>/dev/null)
echo "$unkpid" >> "$T/pids"
rm -f "$T/ps-mode"
check 'a launch whose ps stays empty after retries writes unknown to the lock' '[ "$(sed -n 2p "$LK")" = unknown ]'
run --status --dir "$WT"
check 'a lock with unknown start time is treated as unreadable by status (3)' '[ "$(rc)" = 3 ] && grep -q "running (start time unreadable), pid $unkpid" "$T/o"'
run --abort --dir "$WT"
check 'a lock with unknown start time is refused by abort (1)' '[ "$(rc)" = 1 ] && kill -0 "$unkpid" 2>/dev/null'
kill -9 "$unkpid" "$BG" 2>/dev/null; wait "$BG" 2>/dev/null
rm -f "$LK"

echo locale > "$T/ps-mode"
echo sleep > "$T/fake-mode"
env LC_ALL=de_DE.UTF-8 TZ=Europe/Berlin "$RUNSH" "$SCRIPT" --dir "$WT" --model m > "$T/bg.o" 2> "$T/bg.e" &
BG=$!; echo "$BG" >> "$T/pids"
n=0; while { [ ! -s "$LK" ] || [ "$(head -n 1 "$LK" 2>/dev/null)" = "$BG" ]; } && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
sleep 0.2
erun LC_ALL=de_DE.UTF-8 TZ=Europe/Berlin "$RUNSH" "$SCRIPT" --status --dir "$WT"
check 'a locale-dependent ps writes and reads a matching C/UTC start time (3)' '[ "$(rc)" = 3 ] && [ "$(sed -n 2p "$LK")" = "Thu Jan  1 00:00:00 2026" ]'
erun LC_ALL=de_DE.UTF-8 TZ=Europe/Berlin "$RUNSH" "$SCRIPT" --abort --dir "$WT"
check 'abort through a locale-dependent ps matches and stops the lane (0)' '[ "$(rc)" = 0 ]'
wait "$BG" 2>/dev/null
rm -f "$T/ps-mode"

echo '# abort cleans the lock exactly once (no redundant rm after lane_running)'
sleep 300 &
ABPID=$!
echo "$ABPID" >> "$T/pids"
: > "$T/rm.log"
mk_lock "$ABPID" 'Thu Jan  1 00:00:00 2026'
run --abort --dir "$WT"
check 'abort stops a matching pid (0)' '[ "$(rc)" = 0 ] && grep -q "the lane in .* stopped" "$T/o"'
check 'abort issued exactly one rm of the lock, not a redundant second' '[ "$(grep -c -- "$LK" "$T/rm.log")" = 1 ]'
IGN2PID=$(sh -c '( trap "" TERM; exec sleep 60 ) >/dev/null 2>&1 & echo $!')
echo "$IGN2PID" >> "$T/pids"
: > "$T/rm.log"
mk_lock "$IGN2PID" 'Thu Jan  1 00:00:00 2026'
erun AGY_RUN_ABORT_WAIT=1 "$RUNSH" "$SCRIPT" --abort --dir "$WT"
check 'abort escalates and cleans the lock exactly once' '[ "$(rc)" = 0 ] && grep -q "did not stop in 1 s; killed" "$T/e" && [ "$(grep -c -- "$LK" "$T/rm.log")" = 1 ]'

echo '# agy-run never writes through a symlink in .lane'
mkdir -p "$T/target"
echo keep > "$T/target/marker"
rm -rf "$WT/.lane"
ln -s "$T/target" "$WT/.lane"
run --dir "$WT" --model m
check '.lane as a symlink is refused (2)' '[ "$(rc)" = 2 ] && grep -q "symlink" "$T/e"'
check 'the symlink target is untouched' '[ "$(cat "$T/target/marker")" = keep ] && [ ! -e "$T/target/agy-run.out" ]'
rm -f "$WT/.lane"
mkdir -p "$WT/.lane"
echo '# brief' > "$WT/.lane/brief.md"
ln -s "$T/target/marker" "$WT/.lane/agy-run.out"
run --dir "$WT" --model m
check '.lane/agy-run.out as a symlink is refused (2)' '[ "$(rc)" = 2 ] && grep -q "symlink" "$T/e"'
check 'the agy-run.out symlink target is untouched' '[ "$(cat "$T/target/marker")" = keep ]'
rm -f "$WT/.lane/agy-run.out"

echo
echo "$(grep -o "check '" "$self" | wc -l | tr -d ' ') checks defined, $fails failed"
[ "$fails" = 0 ]
