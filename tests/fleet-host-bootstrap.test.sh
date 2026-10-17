#!/bin/sh
# Tests for bin/fleet-host-bootstrap. The script is meant to run on a fresh host; here it runs in a
# temp HOME with stub tools first on PATH (a real node is kept aside for the JSON check, a real
# coreutils PATH is kept behind the stubs). No network, no system change, nothing installed.
# Run it as `sh`, `dash` or `zsh tests/fleet-host-bootstrap.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=${BOOTSTRAP_TEST_SCRIPT:-$here/bin/fleet-host-bootstrap}
RUNSH=${BOOTSTRAP_TEST_SH:-sh}
REAL_NODE=$(command -v node || true)
REAL_PATH=$PATH
T=$(mktemp -d "${TMPDIR:-/tmp}/fleet-host-bootstrap-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
finish() { rm -rf "$T"; }
trap finish EXIT

setup() { # a fresh HOME and a stub bin dir; $1 = the word `uname` prints (empty: no uname stub)
  rm -rf "$T/home" "$T/bin"
  mkdir -p "$T/home" "$T/bin"
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
  if [ -n "${1:-}" ]; then
    printf '#!/bin/sh\ncat "%s/uname-out"\n' "$T" > "$T/bin/uname"
    printf '%s\n' "$1" > "$T/uname-out"
  fi
  chmod +x "$T/bin"/*
  HOME=$T/home
  PATH="$T/bin:$REAL_PATH"
  export HOME PATH
}

run() { sh "$SCRIPT" 2>"$T/err"; }
stdout_lines() { wc -l <"$T/out" | tr -d ' '; }

# --- first run creates the dirs, mode 700 ---
setup Linux
run >"$T/out"
check "first run: exit 0" '[ $? = 0 ]'
check "first run: exactly one stdout line (the descriptor)" '[ "$(stdout_lines)" = 1 ]'
check "first run: worktree root created" '[ -d "$T/home/fleet/worktrees" ]'
check "first run: TMPDIR created" '[ -d "$T/home/.local/state/fleet/tmp" ]'
check "first run: opencode config dir created" '[ -d "$T/home/.config/opencode" ]'
check "first run: worktree root mode 700" '[ "$(stat -c %a "$T/home/fleet/worktrees")" = 700 ]'
check "first run: TMPDIR mode 700" '[ "$(stat -c %a "$T/home/.local/state/fleet/tmp")" = 700 ]'
check "first run: config dir mode 700" '[ "$(stat -c %a "$T/home/.config/opencode")" = 700 ]'
check "first run: the marker is written" '[ -f "$T/home/fleet/worktrees/.fleet-host-bootstrap.done" ]'

# --- the descriptor is valid JSON (checked with node) ---
if [ -n "$REAL_NODE" ]; then
  if "$REAL_NODE" -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (typeof d.os !== "object" || d.os.sysname !== "Linux" || typeof d.os.id !== "string") process.exit(1);
    if (typeof d.arch !== "string" || d.arch.length < 1) process.exit(1);
    if (!Array.isArray(d.tools) || d.tools.length !== 4) process.exit(1);
    for (const t of d.tools) if (typeof t.name !== "string" || typeof t.found !== "boolean" || typeof t.version !== "string") process.exit(1);
    if (d.paths.worktreeRoot !== process.env.HOME + "/fleet/worktrees") process.exit(1);
    if (typeof d.uid !== "number" || d.uid !== process.getuid()) process.exit(1);
  ' <"$T/out"; then ok "descriptor: valid JSON with os, arch, tools, paths, uid"; else bad "descriptor: valid JSON with os, arch, tools, paths, uid"; fi
else
  bad "descriptor: valid JSON with os, arch, tools, paths, uid (no real node on this machine)"
fi
check "descriptor: every stubbed tool is found with its version" \
  '"$REAL_NODE" -e "const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const m=Object.fromEntries(d.tools.map(t=>[t.name,t]));process.exit(m.git.version===\"git version 2.43.0\"&&m.opencode.version===\"opencode 1.2.3\"&&m.agy.version===\"agy 0.1.0\"?0:1)" <"$T/out"'

# --- second run is a no-op that says so ---
before=$(cat "$T/out")
run >"$T/out2"
check "second run: exit 0" '[ $? = 0 ]'
check "second run: says nothing changed" 'grep -q "nothing changed" "$T/err"'
check "second run: descriptor unchanged" '[ "$(cat "$T/out2")" = "$before" ]'
check "second run: dirs not re-created (marker intact)" '[ -f "$T/home/fleet/worktrees/.fleet-host-bootstrap.done" ]'

# --- a missing tool is reported, not installed ---
setup Linux
rm "$T/bin/agy"
mkdir -p "$T/fakepkg"
printf '#!/bin/sh\necho "apt-get ran" >> "%s/pkg.log"\nexit 0\n' "$T" > "$T/fakepkg/apt-get"
printf '#!/bin/sh\necho "snap ran" >> "%s/pkg.log"\nexit 0\n' "$T" > "$T/fakepkg/snap"
chmod +x "$T/fakepkg"/*
PATH="$T/bin:$T/fakepkg:$REAL_PATH" sh "$SCRIPT" >"$T/out" 2>"$T/err"
check "missing tool: exit 0 (reported, not fatal here)" '[ $? = 0 ]'
check "missing tool: reported on stderr" 'grep -q "missing agy" "$T/err"'
check "missing tool: nothing was installed" '[ ! -s "$T/pkg.log" ]'
check "missing tool: descriptor says not found" \
  '"$REAL_NODE" -e "const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const a=d.tools.find(t=>t.name===\"agy\");process.exit(a&&!a.found&&a.version===\"\"?0:1)" <"$T/out"'

# --- no stdout line contains a value from a planted credential file ---
setup Linux
SECRET=fleet-topsekrIT-token-9f2a
printf '%s\n' "$SECRET" > "$T/home/opencode.auth"
OPENCODE_AUTH_FILE="$T/home/opencode.auth" sh "$SCRIPT" >"$T/out" 2>"$T/err"
check "credentials: the planted secret never reaches stdout" '! grep -q "$SECRET" "$T/out"'
check "credentials: it never reaches stderr either" '! grep -q "$SECRET" "$T/err"'
check "credentials: the auth file still holds only its original content" '[ "$(cat "$T/home/opencode.auth")" = "$SECRET" ]'
check "credentials: the descriptor records the path and existence, nothing more" \
  '"$REAL_NODE" -e "const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(d.authFile&&d.authFile.exists===true&&Object.keys(d.authFile).length===2?0:1)" <"$T/out"'

# --- Linux and Darwin detection via a stubbed uname ---
setup Darwin
run >"$T/out"
check "darwin: descriptor says Darwin and no Linux id" \
  '"$REAL_NODE" -e "const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(d.os.sysname===\"Darwin\"&&d.os.id===undefined?0:1)" <"$T/out"'

setup Linux
run >"$T/out"
check "linux: descriptor carries the os-release ID" \
  '"$REAL_NODE" -e "const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(d.os.sysname===\"Linux\"&&typeof d.os.id===\"string\"&&d.os.id.length>0?0:1)" <"$T/out"'

# --- refusals ---
setup ''
check "no HOME: refused, nothing on stdout" '! env -u HOME sh "$SCRIPT" >"$T/out" 2>"$T/err"'

# the root refusal needs id to answer 0; use a stubbed id instead of becoming root
rm -rf "$T/home"; mkdir -p "$T/home" "$T/bin"
printf '#!/bin/sh\ncase "$1" in -u) echo 0 ;; *) exit 1 ;; esac\n' > "$T/bin/id"
chmod +x "$T/bin/id"
PATH="$T/bin:$REAL_PATH" HOME="$T/home" sh "$SCRIPT" >"$T/out" 2>"$T/err"
check "as root: refused (exit 1), stderr explains" '[ $? = 1 ] && grep -q "refusing to run as root" "$T/err"'
check "as root: nothing was created" '[ ! -d "$T/home/fleet" ]'

printf '\n'
if [ "$fails" -eq 0 ]; then printf '0 failed\n'; else printf '%d failed\n' "$fails"; exit 1; fi
