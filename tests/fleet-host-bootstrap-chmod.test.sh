#!/bin/sh
# Tests that bin/fleet-host-bootstrap calls chmod with "--" BEFORE the mode
# (`chmod -- 700 dir`), the one order every chmod accepts (finding M7). The
# GNU-only order `chmod 700 -- dir` fails on BSD/macOS chmod, where "--" after
# the mode is read as a file operand and the whole bootstrap dies before the
# marker or the descriptor ever appear. A BSD-shaped chmod stub reproduces the
# failure on Linux too, so the regression is not macOS-only.
# Run it as `sh`, `dash` or `zsh tests/fleet-host-bootstrap-chmod.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=${BOOTSTRAP_TEST_SCRIPT:-$here/bin/fleet-host-bootstrap}
RUNSH=${BOOTSTRAP_TEST_SH:-sh}
# A clean environment, as the bootstrap suite's setup does.
unset XDG_CONFIG_HOME FLEET_WORKTREE_ROOT FLEET_TMPDIR FLEET_OPENCODE_CONFIG_DIR OPENCODE_AUTH_FILE
REAL_PATH=$PATH
T=$(mktemp -d "${TMPDIR:-/tmp}/fleet-host-bootstrap-chmod-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
finish() { rm -rf "$T"; }
trap finish EXIT

mkdir -p "$T/home" "$T/bin"

# Stub the tools the bootstrap probes so nothing real runs through them.
cat > "$T/bin/git" <<'EOF'
#!/bin/sh
echo "git version 2.43.0"
EOF
cat > "$T/bin/opencode" <<'EOF'
#!/bin/sh
echo "opencode 1.2.3"
EOF
cat > "$T/bin/agy" <<'EOF'
#!/bin/sh
echo "agy 0.1.0"
EOF
printf '#!/bin/sh\ncat "%s/uname-out"\n' "$T" > "$T/bin/uname"
printf '%s\n' Linux > "$T/uname-out"

# A BSD-shaped chmod: option parsing stops at the first non-option, so a bare
# "--" after the mode is a file operand (and fails), never an option terminator.
cat > "$T/bin/chmod" <<'EOF'
#!/bin/sh
if [ "$1" = "--" ]; then shift; fi
[ "$#" -ge 2 ] || { echo "chmod: missing operand" >&2; exit 1; }
shift
for f in "$@"; do
  [ -e "$f" ] || { echo "chmod: $f: No such file or directory" >&2; exit 1; }
done
exit 0
EOF
chmod +x "$T/bin"/*
HOME=$T/home
PATH="$T/bin:$REAL_PATH"
export HOME PATH

"$RUNSH" "$SCRIPT" >"$T/out" 2>"$T/err"
check "bsd-chmod: exit 0" '[ $? = 0 ]'
check "bsd-chmod: worktree root created" '[ -d "$T/home/fleet/worktrees" ]'
check "bsd-chmod: TMPDIR created" '[ -d "$T/home/.local/state/fleet/tmp" ]'
check "bsd-chmod: opencode config dir created" '[ -d "$T/home/.config/opencode" ]'
check "bsd-chmod: the marker is written" '[ -f "$T/home/fleet/worktrees/.fleet-host-bootstrap.done" ]'
check "bsd-chmod: stdout is still the one-line descriptor" '[ "$(wc -l <"$T/out" | tr -d " ")" = 1 ]'

printf '\n'
if [ "$fails" -eq 0 ]; then printf '0 failed\n'; else printf '%d failed\n' "$fails"; exit 1; fi
