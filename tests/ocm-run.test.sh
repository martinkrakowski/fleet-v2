#!/bin/sh
# Tests for bin/ocm-run. Nothing here can reach a real host or a real opencode:
#   - a fake opencode server (python3, loopback only) listens on a random port pair;
#   - a fake `opencode` and a fake `ssh` (records every call, never forwards) are first on PATH;
#   - OCM_HOST is an ssh alias that does not exist, so a tunnel attempt fails at once and is recorded.
# The FIRST checks prove those three guards and stop the file if one is missing.
# Run it as `sh`, `dash` or `zsh tests/ocm-run.test.sh`. The script under test runs under OCM_TEST_SH
# (default sh; dash passes too; the script is not meant to be run with zsh).
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh # an unmatched glob must stay a word, as in sh
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=${OCM_TEST_SCRIPT:-$here/bin/ocm-run}
RUNSH=${OCM_TEST_SH:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/ocm-run-test.XXXXXX") || exit 1
mkdir -p "$T/bin" "$T/sessions"
: > "$T/aborts"; : > "$T/args.log"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
finish() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  for p in $(cat "$T/pids" "$T/fakepids" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  rm -rf "$T"
}
trap finish EXIT

# A free port pair: remote R (nothing listens there) and local R+1 (the fake server).
R=''
for try in 1 2 3 4 5 6 7 8; do
  c=$(( ( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 20000 ) + 20000 ))
  nc -z 127.0.0.1 "$c" 2>/dev/null && continue
  nc -z 127.0.0.1 "$((c + 1))" 2>/dev/null && continue
  R=$c; break
done
[ -n "$R" ] || { echo "no free port pair"; exit 1; }
P=$((R + 1))

cat > "$T/server.py" <<'PY'
import base64, http.server, os, sys, urllib.parse
T, port = sys.argv[1], int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json"):
        b = body.encode(); self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def auth_ok(self):
        req = os.path.join(T, "auth-required")
        if not os.path.exists(req): return True
        want = "Basic " + base64.b64encode(open(req).read().strip().encode()).decode()
        return self.headers.get("Authorization", "") == want
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        open(os.path.join(T, "http.log"), "a").write("GET " + u.path + "\n")
        if u.path == "/__who": return self.send(200, "fake-opencode-server", "text/plain")
        if not self.auth_ok(): return self.send(401, '{"error":"unauthorized"}')
        if os.path.exists(os.path.join(T, "html-shell")):
            return self.send(200, "<!doctype html><html><body>v2 web ui</body></html>", "text/html; charset=utf-8")
        if u.path == "/api/info":
            if os.path.exists(os.path.join(T, "v2")):
                if os.path.exists(os.path.join(T, "v2-bad-info")):
                    return self.send(200, "[]", "application/json")
                return self.send(200, '{"version":"2.0.28"}', "application/json")
            return self.send(404, "", "text/plain")
        if u.path == "/api/session/active" and os.path.exists(os.path.join(T, "v2")):
            if os.path.exists(os.path.join(T, "broken")): return self.send(500, "boom", "text/plain")
            if os.path.exists(os.path.join(T, "broken-json")): return self.send(400, '{"error": "bad request"}')
            if os.path.exists(os.path.join(T, "v2-unknown-shape")): return self.send(200, '{"unexpected":123}')
            out = []
            for n in sorted(os.listdir(os.path.join(T, "sessions"))):
                kind, where = open(os.path.join(T, "sessions", n)).read().split("\n")[:2]
                if kind == "idle": continue
                out.append('"%s":{"type":"%s"}' % (n, kind))
            return self.send(200, '{"data":{' + ",".join(out) + '}}')
        if u.path.startswith("/api/session/ses_") and os.path.exists(os.path.join(T, "v2")):
            sid = u.path.split("/")[-1]
            sf = os.path.join(T, "sessions", sid)
            if not os.path.exists(sf): return self.send(404, '{"error":"not found"}')
            kind, where = open(sf).read().split("\n")[:2]
            return self.send(200, '{"data":{"id":"%s","location":{"directory":"%s"}}}' % (sid, where))
        if u.path == "/doc": return self.send(200, "{}")
        if u.path == "/session/status":
            if os.path.exists(os.path.join(T, "broken")): return self.send(500, "boom", "text/plain")
            if os.path.exists(os.path.join(T, "broken-json")): return self.send(400, '{"error": "bad request"}')
            # "$T/seq": one line per coming status request, used up from the top. "empty": answer {} whatever
            # runs; "500": an HTTP error; any other line: the true answer. No line left: the true answer.
            # NOT seen from a real opencode server (2026-10-11: 2 lanes polled for minutes never read
            # empty); it stands for any single answer that is well-formed and wrong.
            seq = os.path.join(T, "seq")
            if os.path.exists(seq):
                lines = open(seq).read().split("\n"); first = lines[0]
                open(seq, "w").write("\n".join(lines[1:]))
                if first == "empty": return self.send(200, "{}")
                if first == "500": return self.send(500, "boom", "text/plain")
            d = q.get("directory", [""])[0]; out = []
            for n in sorted(os.listdir(os.path.join(T, "sessions"))):
                kind, where = open(os.path.join(T, "sessions", n)).read().split("\n")[:2]
                if where != d: continue
                if kind == "retry": out.append('"%s": {"attempt": 2, "message": "rate limited", "action": {"x": 1}, "next": 5, "type": "retry"}' % n)
                else: out.append('"%s": {"type": "%s"}' % (n, kind))
            return self.send(200, "{" + ", ".join(out) + "}")
        self.send(404, "", "text/plain")
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); parts = u.path.strip("/").split("/")
        open(os.path.join(T, "http.log"), "a").write("POST " + u.path + "\n")
        if not self.auth_ok(): return self.send(401, '{"error":"unauthorized"}')
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "session" and parts[3] == "interrupt":
            open(os.path.join(T, "interrupts"), "a").write(parts[2] + "\n")
            try: os.remove(os.path.join(T, "sessions", parts[2]))
            except OSError: pass
            return self.send(200, '{"interrupted":true}')
        if len(parts) == 3 and parts[0] == "session" and parts[2] == "abort":
            open(os.path.join(T, "aborts"), "a").write(parts[1] + " " + urllib.parse.parse_qs(u.query).get("directory", [""])[0] + "\n")
            try: os.remove(os.path.join(T, "sessions", parts[1]))
            except OSError: pass
            return self.send(200, "true")
        self.send(404, "", "text/plain")
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
PY
python3 "$T/server.py" "$T" "$P" &
SRV=$!
i=0; while ! nc -z 127.0.0.1 "$P" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 50 ] && { echo "fake server did not start"; exit 1; }; sleep 0.1; done

# The fake client. Like the real one it only WATCHES: killed, it leaves its session running.
cat > "$T/bin/opencode" <<'OC'
#!/bin/sh
[ "$1" = run ] || exit 9
echo "$$" >> "$T/fakepids"
n=$(( $(cat "$T/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$T/count"
printf '%s\n' "$*" >> "$T/args.log"
if [ -e "$T/locked-once" ]; then rm -f "$T/locked-once"; echo "Error: database is locked" >&2; exit 1; fi
# FAKE_START_TICKS: the client's start-up, during which the server knows no session yet
i=0; while [ "$i" -lt "${FAKE_START_TICKS:-0}" ]; do sleep 0.1; i=$((i + 1)); done
d=''; prev=''
for a in "$@"; do case "$a" in --dir=*) d=${a#--dir=} ;; esac; [ "$prev" = --dir ] && d=$a; prev=$a; done
[ -n "$d" ] || d="${OCM_DIR:-$(pwd)}"
id="ses_fake$n"
printf 'busy\n%s\n' "$d" > "$T/sessions/$id"
if [ -n "${FAKE_DEAF:-}" ]; then trap '' TERM; else trap 'exit 143' TERM; fi
printf '{"type":"step_start","sessionID":"%s"}\n\tline with a tab and  two spaces\n' "$id" | tee "$T/expected"
echo "a line on stderr" >&2
i=0; while [ "$i" -lt "${FAKE_TICKS:-0}" ]; do sleep 0.1; i=$((i + 1)); done
: > "$T/ended-$id"
rm -f "$T/sessions/$id"
exit "${FAKE_RC:-0}"
OC
chmod +x "$T/bin/opencode"

# A fake ssh that records every call and never forwards: the tunnel branch, if it ever ran,
# would fail at once, and $T/ssh.log proves --check (and everything else) never even tried.
cat > "$T/bin/ssh" <<'SSH'
#!/bin/sh
echo "$*" >> "$T/ssh.log"
exit 255
SSH
chmod +x "$T/bin/ssh"
: > "$T/ssh.log"

# Fake lsof and ps, driven by files so tests pick who "holds" the dial port:
# - "$T/lsof-pid": the pid lsof prints (else nothing, exit 0);
# - "$T/ps-cmd": the command line `ps` prints for it (else exit 1).
cat > "$T/bin/lsof" <<'LSOF'
#!/bin/sh
[ -e "$T/lsof-pid" ] && cat "$T/lsof-pid"
exit 0
LSOF
chmod +x "$T/bin/lsof"
cat > "$T/bin/ps" <<'PS'
#!/bin/sh
[ -e "$T/ps-cmd" ] && cat "$T/ps-cmd" && exit 0
exit 1
PS
chmod +x "$T/bin/ps"

# run [VAR=value ...] -- <arguments of ocm-run>: the script under test, in the fake world
run() (
  OPENCODE_AUTH_FILE="$T/no-auth-file"
  OPENCODE_SERVER_PASSWORD=""
  OPENCODE_PASSWORD=""
  export OPENCODE_AUTH_FILE OPENCODE_SERVER_PASSWORD OPENCODE_PASSWORD
  export T PATH="$T/bin:$PATH" OCM_REMOTE_PORT="$R" OCM_HOST=ocm-test-host-that-does-not-exist OCM_RETRY_SLEEP=0
  while [ "$1" != "--" ]; do
    case "$1" in
      OCM_HOST=) unset OCM_HOST ;;
      OCM_REMOTE_PORT=) unset OCM_REMOTE_PORT ;;
      *) export "$1" ;;
    esac
    shift
  done
  shift
  exec "$RUNSH" "$SCRIPT" "$@"
)
D=/srv/wt/one; D2=/srv/wt/two
# runbg: the same in the background. A backgrounded function is wrapped in shells of its own, so
# the script writes its real process id to $T/runpid; signals go there, `wait $!` gets its status.
runbg() {
  (
    OPENCODE_AUTH_FILE="$T/no-auth-file"
    OPENCODE_SERVER_PASSWORD=""
    OPENCODE_PASSWORD=""
    export OPENCODE_AUTH_FILE OPENCODE_SERVER_PASSWORD OPENCODE_PASSWORD
    export T PATH="$T/bin:$PATH" OCM_REMOTE_PORT="$R" OCM_HOST=ocm-test-host-that-does-not-exist OCM_RETRY_SLEEP=0
    while [ "$1" != "--" ]; do
      case "$1" in
        OCM_HOST=) unset OCM_HOST ;;
        OCM_REMOTE_PORT=) unset OCM_REMOTE_PORT ;;
        *) export "$1" ;;
      esac
      shift
    done
    shift
    exec sh -c 'echo "$$" > "$T/runpid"; exec "$@"' sh "$RUNSH" "$SCRIPT" "$@"
  ) &
}
busy() { printf '%s\n%s\n' "${3:-busy}" "$2" > "$T/sessions/$1"; }
clear_all() { rm -f "$T/sessions"/* "$T/broken" "$T/broken-json" "$T/locked-once" "$T/seq" "$T/html-shell" "$T/v2-bad-info" "$T/v2-unknown-shape" "$T/auth-required" "$T/lsof-pid" "$T/ps-cmd"; : > "$T/aborts"; : > "$T/interrupts"; : > "$T/args.log"; : > "$T/http.log"; : > "$T/ssh.log"; }

# --- 0. the guards
check "guard: the server on the test port is the fake" '[ "$(curl -s -m 3 http://127.0.0.1:$P/__who)" = fake-opencode-server ]'
check "guard: opencode on the test PATH is the fake" '[ "$(PATH="$T/bin:$PATH" command -v opencode)" = "$T/bin/opencode" ]'
check "guard: nothing listens on the remote port, and the ssh alias does not resolve" '! nc -z 127.0.0.1 $R 2>/dev/null && ! ssh -G ocm-test-host-that-does-not-exist 2>/dev/null | grep -q "^hostname m$"'
[ "$fails" = 0 ] || { echo "a guard is missing: stopping before any other check"; exit 1; }

# --- 1. unchanged behaviour
out=$(run -- --check 2>&1); rc=$?
check "--check: ok and exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "ocm-run: ok"'
out=$(run -- --help 2>&1); rc=$?
check "--help: ok and exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "^Usage: ocm-run"'
clear_all
run FAKE_RC=7 -- --dir "$D" --agent lane -m some/model --format json "a prompt  with  spaces" > "$T/out" 2> "$T/err"; rc=$?
check "a run: the run's own exit status comes back" '[ "$rc" = 7 ]'
check "a run: arguments reach opencode unchanged, after --attach" 'grep -q "^run --attach http://127.0.0.1:$P --dir $D --agent lane -m some/model --format json a prompt  with  spaces$" "$T/args.log"'
check "a run: stdout is passed through byte for byte" '[ -s "$T/out" ] && cmp -s "$T/out" "$T/expected"'
check "a run: stderr is replayed" 'grep -q "a line on stderr" "$T/err"'
out=$(run -- --dir "$D" --attach http://x "p" 2>&1); rc=$?
check "--attach is refused (2)" '[ "$rc" = 2 ]'
clear_all; : > "$T/locked-once"
run -- --dir "$D" "p" > /dev/null 2> "$T/err"; rc=$?
check "an early 'database is locked' is retried once" '[ "$rc" = 0 ] && [ "$(wc -l < "$T/args.log" | tr -d " ")" = 2 ] && grep -q "retrying once" "$T/err"'

# --- 1b. the dial port: an ssh host is dialled at remote + 1, a local host at the remote port itself
clear_all
out=$(run -- --check 2>&1); rc=$?
check "OCM_HOST set: the dial port is remote + 1 (the ok line names 127.0.0.1:<remote + 1>)" '[ "$rc" = 0 ] && echo "$out" | grep -q "http://127.0.0.1:$P via "'
check "OCM_HOST set: --check ran no ssh while the dial port was listening" '[ ! -s "$T/ssh.log" ]'
out=$(run OCM_HOST=custom-host -- --check 2>&1); rc=$?
check "OCM_HOST: uses environment override when set" '[ "$rc" = 0 ] && echo "$out" | grep -q " via custom-host, remote port "'
out=$(run OCM_HOST= -- --check 2>&1); rc=$?
check "OCM_HOST empty and nothing on the remote port: --check reports it, exit 1, no ssh" '[ "$rc" = 1 ] && echo "$out" | grep -q "nothing is listening on the dial port 127.0.0.1:$R" && [ ! -s "$T/ssh.log" ]'

out=$(run OCM_REMOTE_PORT= -- --check 2>&1); rc=$?
check "no OCM_REMOTE_PORT (unset) is a usage error (2): the 4096 default is gone" '[ "$rc" = 2 ] && echo "$out" | grep -q "OCM_REMOTE_PORT"'
out=$(run OCM_REMOTE_PORT= -- --dir "$D" "p" 2>&1); rc=$?
check "no OCM_REMOTE_PORT: a real dispatch is refused too (2)" '[ "$rc" = 2 ] && [ ! -s "$T/args.log" ]'
out=$(run OCM_REMOTE_PORT=40x96 -- --check 2>&1); rc=$?
check "a non-numeric OCM_REMOTE_PORT is refused (2)" '[ "$rc" = 2 ]'
out=$(run OCM_REMOTE_PORT=70000 -- --check 2>&1); rc=$?
check "an OCM_REMOTE_PORT above 65535 is refused (2)" '[ "$rc" = 2 ]'
out=$(run OCM_REMOTE_PORT=65535 -- --check 2>&1); rc=$?
check "65535 with OCM_HOST set is refused (2): no room for the forward" '[ "$rc" = 2 ] && echo "$out" | grep -q "no room for the forward"'

# A second free pair: nothing listens on Q or Q + 1.
Q=''
for try in 1 2 3 4 5 6 7 8; do
  c=$(( ( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 20000 ) + 41000 ))
  nc -z 127.0.0.1 "$c" 2>/dev/null && continue
  nc -z 127.0.0.1 "$((c + 1))" 2>/dev/null && continue
  Q=$c; break
done
[ -n "$Q" ] || { echo "no second free port pair"; exit 1; }
clear_all
out=$(run OCM_REMOTE_PORT=$Q -- --check 2>&1); rc=$?
check "--check with nothing on the dial port is exit 1, never a forward" '[ "$rc" = 1 ] && echo "$out" | grep -q "nothing is listening on the dial port" && [ ! -s "$T/ssh.log" ]'
out=$(run OCM_REMOTE_PORT=$Q -- --dir "$D" "p" 2>&1); rc=$?
check "a real dispatch with nothing on the dial port opens the forward (and fails: the ssh is fake)" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not open the tunnel"'
check "the forward rule is unchanged: local Q + 1 forwards to the remote Q" 'grep -q -- "-L 127.0.0.1:$((Q + 1)):127.0.0.1:$Q ocm-test-host-that-does-not-exist" "$T/ssh.log"'

# The local host needs its listener on the remote port itself: a second fake server on $R.
clear_all
python3 "$T/server.py" "$T" "$R" &
SRV2=$!
echo "$SRV2" >> "$T/pids"
i=0; while ! nc -z 127.0.0.1 "$R" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 50 ] && { echo "the second fake server did not start"; exit 1; }; sleep 0.1; done
out=$(run OCM_HOST= -- --check 2>&1); rc=$?
check "OCM_HOST empty: --check dials the remote port directly (ok, no via, no ssh)" '[ "$rc" = 0 ] && echo "$out" | grep -q "http://127.0.0.1:$R," && ! echo "$out" | grep -q " via " && [ ! -s "$T/ssh.log" ]'
run OCM_HOST= -- --dir "$D" --agent lane "hello local" > /dev/null 2>&1; rc=$?
check "OCM_HOST empty: a run dispatches to 127.0.0.1:<remote> directly" '[ "$rc" = 0 ] && grep -q "^run --attach http://127.0.0.1:$R --dir $D --agent lane hello local$" "$T/args.log"'
check "OCM_HOST empty: a run never touches ssh" '[ ! -s "$T/ssh.log" ]'
out=$(run OCM_HOST= OCM_REMOTE_PORT=65535 -- --check 2>&1); rc=$?
check "65535 with OCM_HOST empty is a legal dial port (exit 1 only because nothing listens there)" '[ "$rc" = 1 ] && echo "$out" | grep -q "127.0.0.1:65535" && [ ! -s "$T/ssh.log" ]'
kill "$SRV2" 2>/dev/null

# --- 1c. --check names who holds the dial port; a forward to another host fails
clear_all
out=$(run -- --check 2>&1); rc=$?
check "holder: port held, no lsof answer: exit 0 and 'holder is unknown'" '[ "$rc" = 0 ] && echo "$out" | grep -q "holder is unknown"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -f -N -L 127.0.0.1:$P:127.0.0.1:$R ocm-test-host-that-does-not-exist" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder: an ssh forward to OCM_HOST is fine: exit 0 and names the pid" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -f -N -L 127.0.0.1:$P:127.0.0.1:$R m" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder: a forward to another host fails (1) before any probe" '[ "$rc" = 1 ] && echo "$out" | grep -q "goes to '\''m'\'', not OCM_HOST=" && [ ! -s "$T/http.log" ]'
clear_all
echo 4242 > "$T/lsof-pid"
echo "python3 server.py" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder: a non-ssh holder does not fail: exit 0 and names the pid" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242"'
clear_all
python3 "$T/server.py" "$T" "$R" &
SRV3=$!
echo "$SRV3" >> "$T/pids"
i=0; while ! nc -z 127.0.0.1 "$R" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 50 ] && { echo "the local server did not start"; exit 1; }; sleep 0.1; done
echo 4242 > "$T/lsof-pid"
echo "ssh -f -N -L 127.0.0.1:$R:127.0.0.1:$R m" > "$T/ps-cmd"
out=$(run OCM_HOST= -- --check 2>&1); rc=$?
check "holder: local mode (OCM_HOST unset) skips the host comparison: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242" && ! echo "$out" | grep -q "goes to"'
kill "$SRV3" 2>/dev/null

# --- 2. our own flags never reach opencode
clear_all
run -- --detach --dir="$D" --agent lane "p" > /dev/null 2>&1
check "--detach is taken out; --dir=<path> is passed on" 'grep -q "^run --attach http://127.0.0.1:$P --dir=$D --agent lane p$" "$T/args.log"'

# --- 3. --status
clear_all
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "--status: nothing running is exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "nothing is running"'
busy ses_A "$D"; busy ses_B "$D2"; busy ses_I "$D" idle
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "--status: a running session is exit 3 and named; another directory's and an idle one are not" '[ "$rc" = 3 ] && echo "$out" | grep -q "^ses_A$" && ! echo "$out" | grep -q "ses_B\|ses_I"'
check "--status starts no run" '[ ! -s "$T/args.log" ]'
out=$(run -- --status 2>&1); rc=$?
check "--status without --dir is a usage error (2)" '[ "$rc" = 2 ]'
: > "$T/broken"
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "--status: an unreadable answer is exit 1, never 'nothing running'" '[ "$rc" = 1 ] && ! echo "$out" | grep -q "nothing is running"'

# --- 4. the refusal
clear_all; busy ses_A "$D"
out=$(run -- --dir "$D" --agent lane "p" 2>&1); rc=$?
check "a dispatch into a directory with a running session is refused (75)" '[ "$rc" = 75 ] && echo "$out" | grep -q "ses_A"'
check "... and opencode was never started" '[ ! -s "$T/args.log" ]'
run -- --dir "$D2" --agent lane "p" > /dev/null 2>&1; rc=$?
check "another directory is not affected" '[ "$rc" = 0 ] && [ "$(wc -l < "$T/args.log" | tr -d " ")" = 1 ]'
run OCM_ALLOW_BUSY=1 -- --dir "$D" --agent lane "p" > /dev/null 2>&1; rc=$?
check "OCM_ALLOW_BUSY=1 lets it through" '[ "$rc" = 0 ] && [ "$(wc -l < "$T/args.log" | tr -d " ")" = 2 ]'
clear_all; busy ses_I "$D" idle
run -- --dir "$D" "p" > /dev/null 2>&1; rc=$?
check "an idle session does not block a dispatch" '[ "$rc" = 0 ]'
clear_all; : > "$T/broken"
out=$(run -- --dir "$D" "p" 2>&1); rc=$?
check "an unreadable status stops the dispatch (1): never blind" '[ "$rc" = 1 ] && [ ! -s "$T/args.log" ]'

clear_all; : > "$T/broken-json"
out=$(run -- --dir "$D" "p" 2>&1); rc=$?
check "an HTTP error whose body is a JSON object stops the dispatch too (1)" '[ "$rc" = 1 ] && [ ! -s "$T/args.log" ]'
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "... and --status does not call it 'nothing running'" '[ "$rc" = 1 ] && ! echo "$out" | grep -q "nothing is running"'
clear_all; busy ses_R "$D" retry
out=$(run -- --dir "$D" "p" 2>&1); rc=$?
check "a session in a state other than idle (retry, with other keys before its type) blocks a dispatch" '[ "$rc" = 75 ] && echo "$out" | grep -q "ses_R" && [ ! -s "$T/args.log" ]'
clear_all; busy ses_U "$D" Something-New
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "an unknown state counts as running" '[ "$rc" = 3 ] && echo "$out" | grep -q "^ses_U$"'
clear_all
out=$(run -- --agent lane "p" 2>&1); rc=$?
check "a run without --dir is refused (2) and nothing starts" '[ "$rc" = 2 ] && [ ! -s "$T/args.log" ]'
out=$(run -- --dir= --agent lane "p" 2>&1); rc=$?
check "an empty --dir= is refused too" '[ "$rc" = 2 ] && [ ! -s "$T/args.log" ]'

# --- 5. told to stop
started() { j=0; while [ ! -e "$T/sessions/ses_fake$(cat "$T/count")" ] || [ "$(cat "$T/count")" = "$1" ]; do j=$((j + 1)); [ "$j" -gt 60 ] && return 1; sleep 0.1; done; }
clear_all; c0=$(cat "$T/count")
runbg FAKE_TICKS=300 -- --dir "$D" "p" > /dev/null 2> "$T/err"; bg=$!
started "$c0"; id="ses_fake$(cat "$T/count")"; pid=$(cat "$T/runpid"); echo "$pid" >> "$T/pids"
kill -TERM "$pid"; wait "$bg"; rc=$?
check "TERM: exit 143 and the session it started is aborted on the server" '[ "$rc" = 143 ] && grep -q "^$id $D$" "$T/aborts" && [ ! -e "$T/sessions/$id" ]'
check "TERM: it says what it aborted" 'grep -q "asked the server to abort $id" "$T/err"'
clear_all; c0=$(cat "$T/count")
runbg FAKE_TICKS=300 -- --dir "$D" "p" > /dev/null 2>&1; bg=$!
started "$c0"; id="ses_fake$(cat "$T/count")"; pid=$(cat "$T/runpid"); echo "$pid" >> "$T/pids"
kill -HUP "$pid"; wait "$bg"; rc=$?
check "HUP (a closed terminal or ssh): exit 129 and the session is aborted" '[ "$rc" = 129 ] && grep -q "^$id " "$T/aborts"'
clear_all; c0=$(cat "$T/count")
runbg FAKE_TICKS=300 -- --detach --dir "$D" "p" > /dev/null 2> "$T/err"; bg=$!
started "$c0"; id="ses_fake$(cat "$T/count")"; pid=$(cat "$T/runpid"); echo "$pid" >> "$T/pids"
kill -TERM "$pid"; wait "$bg"; rc=$?
check "--detach: stopped, it aborts nothing and the session runs on" '[ "$rc" = 143 ] && [ ! -s "$T/aborts" ] && [ -e "$T/sessions/$id" ] && grep -q "runs on" "$T/err"'
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "... and --status then shows it" '[ "$rc" = 3 ] && echo "$out" | grep -q "^$id$"'
clear_all; busy ses_OLD "$D"; c0=$(cat "$T/count")
runbg FAKE_TICKS=300 OCM_ALLOW_BUSY=1 -- --dir "$D" "p" > /dev/null 2>&1; bg=$!
started "$c0"; id="ses_fake$(cat "$T/count")"; pid=$(cat "$T/runpid"); echo "$pid" >> "$T/pids"
kill -TERM "$pid"; wait "$bg"
check "a session that ran before this dispatch is not aborted with it" 'grep -q "^$id " "$T/aborts" && ! grep -q "ses_OLD" "$T/aborts" && [ -e "$T/sessions/ses_OLD" ]'

clear_all; c0=$(cat "$T/count")
runbg FAKE_TICKS=300 FAKE_DEAF=1 -- --dir "$D" "p" > /dev/null 2>&1; bg=$!
started "$c0"; pid=$(cat "$T/runpid"); echo "$pid" >> "$T/pids"; t0=$(date +%s)
kill -TERM "$pid"; wait "$bg"; rc=$?; took=$(( $(date +%s) - t0 ))
check "a client that ignores TERM does not hang the stop: killed after 10 s, exit 143" '[ "$rc" = 143 ] && [ "$took" -ge 8 ] && [ "$took" -le 20 ]'

# --- 6. --wait and --abort
clear_all; busy ses_A "$D"
( sleep 2; rm -f "$T/sessions/ses_A" ) & echo "$!" >> "$T/pids"
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait returns 0 once nothing runs there" '[ "$rc" = 0 ] && echo "$out" | grep -q "nothing is running"'
clear_all; busy ses_A "$D"
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 OCM_WAIT_MAX=2 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait gives up with 75 and names what still runs" '[ "$rc" = 75 ] && echo "$out" | grep -q "ses_A"'
# What the waves orchestrator met three times on 2026-10-11: the wait gave up after OCM_WAIT_MAX with 75,
# the caller's `; echo` made the command's status 0, and `tail` showed nothing of the message.
check "... and its LAST line says it gave up, with the exit status in words, never 'nothing is running'" 'echo "$out" | tail -1 | grep -q "GAVE UP.*exit 75" && ! echo "$out" | grep -q "nothing is running"'

# One idle answer is not the end. The first read is {} while ses_A runs; the next reads are true.
clear_all; busy ses_A "$D"; echo empty > "$T/seq"
( sleep 3; rm -f "$T/sessions/ses_A" ) & echo "$!" >> "$T/pids"
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait: ONE idle answer while a session runs does not end the wait" '[ "$rc" = 0 ] && [ ! -e "$T/sessions/ses_A" ]'
# ... and in the middle of a wait: true, true, {} , true ...
clear_all; busy ses_A "$D"; printf 'true\nempty\n' > "$T/seq"
( sleep 4; rm -f "$T/sessions/ses_A" ) & echo "$!" >> "$T/pids"
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait: nor does one in the middle of a wait" '[ "$rc" = 0 ] && [ ! -e "$T/sessions/ses_A" ]'
# The idle answer must be confirmed by a READ: {} and then an unreadable status is exit 1, not 0.
clear_all; printf 'empty\n500\n' > "$T/seq"
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait: an idle answer followed by an unreadable one is exit 1, never 'nothing is running'" '[ "$rc" = 1 ] && ! echo "$out" | grep -q "nothing is running"'
clear_all; busy ses_A "$D"; printf 'true\n500\n' > "$T/seq"
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait: a status that becomes unreadable during the wait is exit 1" '[ "$rc" = 1 ] && ! echo "$out" | grep -q "nothing is running"'
# A wait that keeps reading {} and busy in turn still ends at OCM_WAIT_MAX.
clear_all; busy ses_A "$D"; printf 'empty\ntrue\nempty\ntrue\nempty\ntrue\nempty\ntrue\n' > "$T/seq"; t0=$(date +%s)
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 OCM_WAIT_MAX=3 -- --wait --dir "$D" 2>&1); rc=$?; took=$(( $(date +%s) - t0 ))
check "--wait: answers that flap between idle and running end at OCM_WAIT_MAX with 75" '[ "$rc" = 75 ] && [ "$took" -le 12 ]'
# The gap that does exist: a dispatch has been started and its client has not yet made its session.
clear_all; c0=$(cat "$T/count")
runbg FAKE_START_TICKS=30 FAKE_TICKS=80 -- --detach --dir "$D" "p" > /dev/null 2>&1; bg=$!
# Wide margins, for a loaded machine: the client has started (its count moved) and makes its session
# 3 s later; the wait's first read falls inside those 3 s, its second 8 s on, in the session's 8 s of life.
j=0; while [ "$(cat "$T/count")" = "$c0" ]; do j=$((j + 1)); [ "$j" -gt 100 ] && break; sleep 0.1; done
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=8 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait started just after a dispatch, before its session exists, waits for that session to end" '[ "$rc" = 0 ] && [ "$(cat "$T/count")" != "$c0" ] && [ -e "$T/ended-ses_fake$(cat "$T/count")" ]'
# waited >= 9 only when the first read saw nothing (8 s confirm pause) and a later one saw the session
w=$(echo "$out" | sed -n 's/.*waited \([0-9]*\) s.*/\1/p')
check "... and its first read really was the empty one (it waited through a confirm pause and an interval)" '[ "${w:-0}" -ge 9 ]'
wait "$bg"
: > "$T/args.log"
out=$(run OCM_WAIT_CONFIRM=x -- --wait --dir "$D" 2>&1); rc=$?
check "--wait: a setting that is not a number is a usage error (2)" '[ "$rc" = 2 ]'
busy ses_A "$D"
for bad in OCM_WAIT_INTERVAL=0 OCM_WAIT_CONFIRM=0 OCM_WAIT_INTERVAL=08 OCM_WAIT_MAX=18446744073709551615; do
  out=$(run "$bad" OCM_WAIT_MAX_UNUSED=1 -- --wait --dir "$D" 2>&1); rc=$?
  check "--wait: $bad is refused (2): a pause of 0 or a number a shell misreads would never end" '[ "$rc" = 2 ]'
done
out=$(run OCM_WAIT_MAX=0 -- --wait --dir "$D" 2>&1); rc=$?
check "--wait: OCM_WAIT_MAX=0 is one look: 75 at once while a session runs" '[ "$rc" = 75 ]'
clear_all; busy ses_A "$D"
out=$(run -- --abort --dir "$D" 2>&1); rc=$?
check "--abort stops what runs there and returns 0" '[ "$rc" = 0 ] && grep -q "^ses_A $D$" "$T/aborts" && [ ! -e "$T/sessions/ses_A" ]'
out=$(run -- --abort --dir "$D" 2>&1); rc=$?
check "--abort with nothing running is 0 and aborts nothing more" '[ "$rc" = 0 ] && [ "$(wc -l < "$T/aborts" | tr -d " ")" = 1 ]'
check "none of --status, --wait, --abort ever started a run" '[ ! -s "$T/args.log" ]'

# --- 7. v2 HTTP API, basic auth, HTML 200 rejection, and flag rewriting
clear_all; : > "$T/html-shell"
out=$(run -- --check 2>&1); rc=$?
check "HTML 200 on /api/info and /session/status fails --check (1)" '[ "$rc" = 1 ]'
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "HTML 200 on status fails --status (1), never 'nothing is running'" '[ "$rc" = 1 ] && ! echo "$out" | grep -q "nothing is running"'

: > "$T/v2"
clear_all; : > "$T/v2-bad-info"
out=$(run -- --check 2>&1); rc=$?
check "v2: /api/info returning non-object JSON fails --check (1)" '[ "$rc" = 1 ]'

clear_all; printf 'opencode:secret123\n' > "$T/auth-required"
out=$(run -- --check 2>&1); rc=$?
check "v2: missing basic auth fails --check (1)" '[ "$rc" = 1 ]'
out=$(run OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=wrong -- --check 2>&1); rc=$?
check "v2: wrong basic auth fails --check (1)" '[ "$rc" = 1 ]'
out=$(run OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=secret123 -- --check 2>&1); rc=$?
check "v2: matching basic auth passes --check (0) and sends no v1 /session/status call" '[ "$rc" = 0 ] && ! grep -q "/session/status" "$T/http.log"'

clear_all; printf 'opencode:secret123\n' > "$T/auth-required"
out=$(run OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=secret123 -- --status --dir "$D" 2>&1); rc=$?
check "v2 --status: empty /api/session/active is exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "nothing is running"'
busy ses_V2A "$D"; busy ses_V2B "$D2"
out=$(run OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=secret123 -- --status --dir "$D" 2>&1); rc=$?
check "v2 --status: keeps only the session whose location.directory equals --dir (exit 3)" '[ "$rc" = 3 ] && echo "$out" | grep -q "^ses_V2A$" && ! echo "$out" | grep -q "ses_V2B"'
: > "$T/v2-unknown-shape"
out=$(run OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=secret123 -- --status --dir "$D" 2>&1); rc=$?
check "v2 --status: unknown JSON shape stays exit 1" '[ "$rc" = 1 ] && ! echo "$out" | grep -q "nothing is running"'

clear_all; busy ses_V2A "$D"
out=$(run -- --abort --dir "$D" 2>&1); rc=$?
check "v2 --abort: calls POST /api/session/<id>/interrupt and never /session/<id>/abort" '[ "$rc" = 0 ] && grep -q "^ses_V2A$" "$T/interrupts" && [ ! -s "$T/aborts" ] && [ ! -e "$T/sessions/ses_V2A" ]'

clear_all
run -- --dir "$D" --agent lane-glm --variant low -m provider/model --format json "hello v2" > /dev/null 2>&1; rc=$?
check "v2 run: rewrites --server, drops --dir, and folds --variant low into -m provider/model#low" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P --agent lane-glm -m provider/model#low --format json hello v2$" "$T/args.log"'
out=$(run -- --dir "$D" --agent lane-glm --variant low -m provider/model#high "hello" 2>&1); rc=$?
check "v2 run: combining --variant and an already hashed -m is refused (2)" '[ "$rc" = 2 ] && [ "$(wc -l < "$T/args.log" | tr -d " ")" = 1 ]'
out=$(run -- --dir "$D" --server http://x "hello" 2>&1); rc=$?
check "v2 run: passing --server directly is refused (2)" '[ "$rc" = 2 ]'

# NVIDIA rewrite tests
clear_all
run -- --dir "$D" --agent lane-glm --variant low -m nvidia/z-ai/glm-5.3 --format json "hello nvidia" > /dev/null 2>&1; rc=$?
check "v2 run: rewrites nvidia/* with --variant low to variant none (#none)" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P --agent lane-glm -m nvidia/z-ai/glm-5.3#none --format json hello nvidia$" "$T/args.log"'
clear_all
run -- --dir "$D" --variant=low --model=nvidia/z-ai/glm-5.3 --format json "hello nvidia flag" > /dev/null 2>&1; rc=$?
check "v2 run: rewrites nvidia/* with --variant=low and --model=... to #none" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P -m nvidia/z-ai/glm-5.3#none --format json hello nvidia flag$" "$T/args.log"'
clear_all
run -- --dir "$D" --agent lane-glm --variant high -m nvidia/z-ai/glm-5.3 --format json "hello nvidia high" > /dev/null 2>&1; rc=$?
check "v2 run: leaves nvidia/* with --variant high as #high" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P --agent lane-glm -m nvidia/z-ai/glm-5.3#high --format json hello nvidia high$" "$T/args.log"'

printf '%s failed\n' "$fails"
[ "$fails" = 0 ]
