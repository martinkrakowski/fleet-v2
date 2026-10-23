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
import base64, http.server, json, os, sys, urllib.parse
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
                # A created-but-not-yet-started session (POST, kind "created") is not
                # listed: only a session whose client has started ("busy") counts, and an
                # idle one never does. This is the readiness gap that proves D5's poll.
                if kind in ("idle", "created"): continue
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
        if len(parts) == 2 and parts[0] == "api" and parts[1] == "session":
            if os.path.exists(os.path.join(T, "v2-session-fail")):
                return self.send(500, '{"error":"session create failed"}')
            length = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(length).decode()
            try:
                loc = json.loads(data)["location"]["directory"]
            except Exception:
                return self.send(400, '{"error":"bad session body"}')
            n = 1
            while os.path.exists(os.path.join(T, "sessions", "ses_http%d" % n)):
                n += 1
            sid = "ses_http%d" % n
            # The session is only *created* here; it is not listed in /api/session/active
            # until the fake client has started and flipped it to "busy" below. That is the
            # readiness gap D5's poll is built on (the server lists an id only after the
            # client posts its prompt).
            open(os.path.join(T, "sessions", sid), "w").write("created\n" + loc + "\n")
            return self.send(200, '{"data":{"id":"%s","location":{"directory":"%s"}}}' % (sid, loc))
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
d=''; sid=''; prev=''
for a in "$@"; do
  case "$a" in
    --dir=*) d=${a#--dir=} ;;
    -s) ;;
  esac
  [ "$prev" = --dir ] && d=$a
  [ "$prev" = -s ] && sid=$a
  prev=$a
done
id="ses_fake$n"
if [ -n "$sid" ]; then
  id=$sid
  d=$(sed -n '2p' "$T/sessions/$id" 2>/dev/null)
fi
[ -n "$d" ] || d="$(pwd)"
echo "$d" > "$T/client-dir"
# The readiness handshake: the server created this session as "created" (POST); the
# client's start is exactly the moment it flips the session to "busy", which makes it
# visible in /api/session/active. FAKE_START_TICKS delays this flip.
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
# - "$T/lsof-pid": the pid(s) (or raw -Fpn p/n lines) lsof prints when given -iTCP:<port> -sTCP:LISTEN -Fpn (else nothing, exit 1);
# - "$T/ps-cmd" (or "$T/ps-cmd-<pid>"): the command line `ps` prints when given -ww and -p <pid> (else nothing, exit 1).
cat > "$T/bin/lsof" <<'LSOF'
#!/bin/sh
[ -e "$T/lsof-pid" ] || exit 1
want=${LSOF_PORT:-}
if [ -z "$want" ] && [ -n "${OCM_REMOTE_PORT:-}" ]; then
  if [ -n "${OCM_HOST:-}" ]; then
    want=$((OCM_REMOTE_PORT + 1))
  else
    want=$OCM_REMOTE_PORT
  fi
fi
has_i=0
has_s=0
has_f=0
for a in "$@"; do
  [ "$a" = "-iTCP:$want" ] && has_i=1
  [ "$a" = "-sTCP:LISTEN" ] && has_s=1
  [ "$a" = "-Fpn" ] && has_f=1
done
if [ "$has_i" = 1 ] && [ "$has_s" = 1 ] && [ "$has_f" = 1 ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      p* | n* | f*)
        printf '%s\n' "$line"
        ;;
      ?*)
        printf 'p%s\nn127.0.0.1:%s\n' "$line" "$want"
        ;;
    esac
  done < "$T/lsof-pid"
  exit 0
fi
exit 1
LSOF
chmod +x "$T/bin/lsof"
cat > "$T/bin/ps" <<'PS'
#!/bin/sh
has_ww=0
has_comm=0
pid=''
prev=''
for a in "$@"; do
  [ "$a" = "-ww" ] && has_ww=1
  [ "$a" = "comm=" ] && has_comm=1
  [ "$prev" = "-p" ] && pid=$a
  prev=$a
done
# -o comm=: the executable's name. "$T/ps-comm" overrides it; otherwise it is the basename of the
# first word of the faked command line (so an argv that only claims to be ssh can be told apart).
if [ "$has_comm" = 1 ] && [ -n "$pid" ] && { [ -e "$T/ps-cmd-$pid" ] || [ -e "$T/ps-cmd" ]; }; then
  if [ -e "$T/ps-comm" ]; then cat "$T/ps-comm"; exit 0; fi
  f="$T/ps-cmd-$pid"; [ -e "$f" ] || f="$T/ps-cmd"
  w=$(sed -n '1s/ .*//p' "$f"); echo "${w##*/}"; exit 0
fi
if [ "$has_ww" = 1 ] && [ -n "$pid" ]; then
  if [ -e "$T/ps-cmd-$pid" ]; then
    cat "$T/ps-cmd-$pid"
    exit 0
  fi
  if [ -e "$T/ps-cmd" ] && [ -e "$T/lsof-pid" ]; then
    lpid=$(sed -n 's/^p//p; /^[0-9][0-9]*$/p' "$T/lsof-pid")
    if [ "$pid" = "$lpid" ]; then
      cat "$T/ps-cmd"
      exit 0
    fi
  fi
fi
exit 1
PS
chmod +x "$T/bin/ps"

# run [VAR=value ...] -- <arguments of ocm-run>: the script under test, in the fake world
run() (
  OPENCODE_AUTH_FILE="$T/no-auth-file"
  OPENCODE_SERVER_PASSWORD=""
  OPENCODE_PASSWORD=""
  export OPENCODE_AUTH_FILE OPENCODE_SERVER_PASSWORD OPENCODE_PASSWORD
  export T PATH="$T/bin:$PATH" OCM_REMOTE_PORT="$R" OCM_HOST=ocm-test-host-that-does-not-exist OCM_RETRY_SLEEP=0 OCM_PROC_ROOT="$T/proc"
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
    export T PATH="$T/bin:$PATH" OCM_REMOTE_PORT="$R" OCM_HOST=ocm-test-host-that-does-not-exist OCM_RETRY_SLEEP=0 OCM_PROC_ROOT="$T/proc"
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
clear_all() { rm -rf "$T/proc"; rm -f "$T/sessions"/* "$T/broken" "$T/broken-json" "$T/locked-once" "$T/seq" "$T/html-shell" "$T/v2-bad-info" "$T/v2-unknown-shape" "$T/v2-session-fail" "$T/auth-required" "$T/lsof-pid" "$T/ps-cmd" "$T/ps-cmd"-* "$T/client-dir" "$T/racepid"; : > "$T/aborts"; : > "$T/interrupts"; : > "$T/args.log"; : > "$T/http.log"; : > "$T/ssh.log"; : > "$T/curl.args.log"; : > "$T/curl.stdin"; }

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

clear_all
out=$(run -- --dir "$D" --agent lane --check 2>&1); rc=$?
check "--check is accepted in the middle of the flags (before the prompt): exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "ocm-run: ok"'
out=$(run -- --agent lane -m some/model --check 2>&1); rc=$?
check "--check after -m <model> is still check mode: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "ocm-run: ok"'
out=$(run -- --check --status --dir "$D" 2>&1); rc=$?
check "--check combined with another mode is still refused (2)" '[ "$rc" = 2 ]'

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

clear_all
out=$(run OCM_HOST=-oProxyCommand=evil -- --check 2>&1); rc=$?
check "OCM_HOST starting with '-' is refused (2), never passed to ssh" '[ "$rc" = 2 ] && echo "$out" | grep -q "OCM_HOST" && [ ! -s "$T/ssh.log" ]'
out=$(run OCM_HOST=-W -- --check 2>&1); rc=$?
check "OCM_HOST='-' alone is refused too (2)" '[ "$rc" = 2 ]'

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

# Tunnel race (minor 13): a failed ssh -L whose forward landed anyway (a simultaneous
# dispatch won) must not fail the dispatch: the script re-checks nc -z once.
clear_all
cat > "$T/bin/ssh" <<SSH
#!/bin/sh
echo "\$*" >> "\$T/ssh.log"
python3 "\$T/server.py" "\$T" "$((Q + 1))" > /dev/null 2>&1 &
echo \$! > "\$T/racepid"
echo \$! > "\$T/lsof-pid"
sleep 0.3
exit 255
SSH
chmod +x "$T/bin/ssh"
# The port's holder must be an ssh forward of this port to OCM_HOST (Grok review of L3).
printf 'ssh -f -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:%s:127.0.0.1:%s ocm-test-host-that-does-not-exist\n' "$((Q + 1))" "$Q" > "$T/ps-cmd"
out=$(run OCM_REMOTE_PORT=$Q -- --dir "$D" "p" 2>&1); rc=$?
check "tunnel race: after a failed ssh -L, a port held by our ssh forward still dispatches (0)" '[ "$rc" = 0 ] && grep -qF "run --attach http://127.0.0.1:$((Q + 1))" "$T/args.log" && ! echo "$out" | grep -q "could not open the tunnel"'
[ -s "$T/racepid" ] && kill "$(cat "$T/racepid")" 2>/dev/null
# Any other holder is refused: the session POST and the credentials must not go to it.
clear_all
printf 'python3 server.py\n' > "$T/ps-cmd"
out=$(run OCM_REMOTE_PORT=$Q -- --dir "$D" "p" 2>&1); rc=$?
check "tunnel race: a port held by another process is refused (1), nothing dispatched" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not open the tunnel" && ! grep -qF "run --attach" "$T/args.log" 2>/dev/null'
[ -s "$T/racepid" ] && kill "$(cat "$T/racepid")" 2>/dev/null
clear_all
printf 'ssh -f -N -L 127.0.0.1:%s:127.0.0.1:%s some-other-host\n' "$((Q + 1))" "$Q" > "$T/ps-cmd"
out=$(run OCM_REMOTE_PORT=$Q -- --dir "$D" "p" 2>&1); rc=$?
check "tunnel race: an ssh forward to a different host is refused (1)" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not open the tunnel"'
[ -s "$T/racepid" ] && kill "$(cat "$T/racepid")" 2>/dev/null
rm -f "$T/ps-cmd" "$T/lsof-pid"
rm -f "$T/ps-comm"
# Grok re-review of L3: the holder must be an ssh executable listening on exactly 127.0.0.1:<port>,
# forwarding to 127.0.0.1:<remote>.
clear_all
printf 'p4242\nn[::1]:%s\n' "$((Q + 1))" > "$T/lsof-pid.static"
cat > "$T/bin/ssh" <<SSH
#!/bin/sh
echo "\$*" >> "\$T/ssh.log"
python3 "\$T/server.py" "\$T" "$((Q + 1))" > /dev/null 2>&1 &
echo \$! > "\$T/racepid"
cp "\$T/lsof-pid.static" "\$T/lsof-pid"
sleep 0.3
exit 255
SSH
chmod +x "$T/bin/ssh"
printf 'ssh -f -N -L 127.0.0.1:%s:127.0.0.1:%s ocm-test-host-that-does-not-exist\n' "$((Q + 1))" "$Q" > "$T/ps-cmd-4242"
out=$(run OCM_REMOTE_PORT=$Q -- --dir "$D" "p" 2>&1); rc=$?
check "tunnel race: an ssh forward listening on [::1], not 127.0.0.1, does not vouch (1)" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not open the tunnel"'
[ -s "$T/racepid" ] && kill "$(cat "$T/racepid")" 2>/dev/null
clear_all; rm -f "$T/ps-cmd-4242" "$T/lsof-pid.static"
cat > "$T/bin/ssh" <<SSH
#!/bin/sh
echo "\$*" >> "\$T/ssh.log"
python3 "\$T/server.py" "\$T" "$((Q + 1))" > /dev/null 2>&1 &
echo \$! > "\$T/racepid"
echo \$! > "\$T/lsof-pid"
sleep 0.3
exit 255
SSH
chmod +x "$T/bin/ssh"
printf 'ssh -f -N -L 127.0.0.1:%s:127.0.0.1:%s ocm-test-host-that-does-not-exist\n' "$((Q + 1))" "$Q" > "$T/ps-cmd"
echo python3 > "$T/ps-comm"
out=$(run OCM_REMOTE_PORT=$Q -- --dir "$D" "p" 2>&1); rc=$?
check "tunnel race: a non-ssh executable whose argv claims ssh is refused (1)" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not open the tunnel"'
[ -s "$T/racepid" ] && kill "$(cat "$T/racepid")" 2>/dev/null
clear_all; rm -f "$T/ps-comm"
printf 'ssh -f -N -L 127.0.0.1:%s:10.0.0.9:22 ocm-test-host-that-does-not-exist\n' "$((Q + 1))" > "$T/ps-cmd"
out=$(run OCM_REMOTE_PORT=$Q -- --dir "$D" "p" 2>&1); rc=$?
check "tunnel race: an ssh forward to a different target is refused (1)" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not open the tunnel"'
[ -s "$T/racepid" ] && kill "$(cat "$T/racepid")" 2>/dev/null
rm -f "$T/ps-cmd" "$T/lsof-pid"
cat > "$T/bin/ssh" <<'SSH'
#!/bin/sh
echo "$*" >> "$T/ssh.log"
exit 255
SSH
chmod +x "$T/bin/ssh"
clear_all

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
check "holder (a): port held, no lsof answer: exit 0 and 'holder is unknown'" '[ "$rc" = 0 ] && echo "$out" | grep -q "holder is unknown (lsof found no owner it may read)"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -f -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:$P:127.0.0.1:$R ocm-test-host-that-does-not-exist" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (b): an ssh forward to OCM_HOST is fine: exit 0 and names the pid" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -f -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:$P:127.0.0.1:$R m" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (c): a forward to another host fails (1) before any probe" '[ "$rc" = 1 ] && echo "$out" | grep -q "goes to '\''m'\'', not OCM_HOST=" && [ ! -s "$T/http.log" ]'
clear_all
echo 4242 > "$T/lsof-pid"
echo "/usr/bin/ssh -N -L $P:127.0.0.1:$R m" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (d): /usr/bin/ssh with no bind address in -L to another host fails (1)" '[ "$rc" = 1 ] && echo "$out" | grep -q "goes to '\''m'\''"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -N -L $P:127.0.0.1:$R someone@ocm-test-host-that-does-not-exist" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (e): user@ prefix on destination is stripped: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -L $P:127.0.0.1:$R m sleep 600" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (f): remote command after destination does not mask destination: exit 1" '[ "$rc" = 1 ] && echo "$out" | grep -q "goes to '\''m'\''"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -J jump.example -p 2222 -L $P:127.0.0.1:$R ocm-test-host-that-does-not-exist" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (g): ssh options with arguments (-J, -p) before destination: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "python3 server.py" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (h): a non-ssh holder does not fail: exit 0 and 'held by'" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242"'
clear_all
printf '4242\n4243\n' > "$T/lsof-pid"
echo "ssh -f -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:$P:127.0.0.1:$R ocm-test-host-that-does-not-exist" > "$T/ps-cmd-4242"
echo "ssh -f -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:$P:127.0.0.1:$R m" > "$T/ps-cmd-4243"
out=$(run -- --check 2>&1); rc=$?
check "holder (i): two pids, one good forward and one to 'm': prints both and exits 1" '[ "$rc" = 1 ] && echo "$out" | grep -q "held by pid 4242" && echo "$out" | grep -q "held by pid 4243" && echo "$out" | grep -q "goes to '\''m'\''"'
clear_all
python3 "$T/server.py" "$T" "$R" &
SRV3=$!
echo "$SRV3" >> "$T/pids"
i=0; while ! nc -z 127.0.0.1 "$R" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 50 ] && { echo "the local server did not start"; exit 1; }; sleep 0.1; done
echo 4242 > "$T/lsof-pid"
echo "ssh -f -N -L 127.0.0.1:$R:127.0.0.1:$R m" > "$T/ps-cmd"
out=$(run OCM_HOST= -- --check 2>&1); rc=$?
check "holder (j): local mode (OCM_HOST unset) skips the host comparison: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242" && ! echo "$out" | grep -q "goes to"'
kill "$SRV3" 2>/dev/null
clear_all
printf 'p4241\nn10.0.0.5:%s\np4242\nn127.0.0.1:%s\n' "$P" "$P" > "$T/lsof-pid"
echo "ssh -f -N -L 10.0.0.5:$P:127.0.0.1:$R m" > "$T/ps-cmd-4241"
echo "ssh -f -N -L 127.0.0.1:$P:127.0.0.1:$R ocm-test-host-that-does-not-exist" > "$T/ps-cmd-4242"
out=$(run -- --check 2>&1); rc=$?
check "holder (k): listener on 10.0.0.5:$P to 'm' is ignored while 127.0.0.1:$P to OCM_HOST passes: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242" && ! echo "$out" | grep -q "4241"'
clear_all
echo 4242 > "$T/lsof-pid"
mkdir -p "$T/proc/4242"
printf '%s\0' ssh -o 'ProxyCommand=ssh -W %h:%p jump' -L "$P:127.0.0.1:$R" ocm-test-host-that-does-not-exist > "$T/proc/4242/cmdline"
out=$(run -- --check 2>&1); rc=$?
check "holder (l): Linux /proc/<pid>/cmdline with ProxyCommand spaces parses exact args: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242" && ! echo "$out" | grep -q "could not parse"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -o ProxyCommand=ssh -W %h:%p jump -L $P:127.0.0.1:$R ocm-test-host-that-does-not-exist" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (m): ps fallback with ProxyCommand warns could not parse reliably and exits 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "could not parse pid 4242'\''s ssh arguments reliably ('\''jump'\'' vs OCM_HOST='\''ocm-test-host-that-does-not-exist'\''); check it by hand"'
clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -N -L $P:127.0.0.1:$R m" > "$T/ps-cmd"
out=$(run -- --check 2>&1); rc=$?
check "holder (n): ps fallback with plain mismatch to 'm' still fails (1)" '[ "$rc" = 1 ] && echo "$out" | grep -q "goes to '\''m'\'', not OCM_HOST="'
# Grok review of L3: a line break in a credential would add curl --config directives.
clear_all
out=$(run OPENCODE_SERVER_PASSWORD="$(printf 'pw\noutput="/tmp/x"')" -- --dir "$D" "p" 2>&1); rc=$?
check "a password containing a line break is refused (2) before any request, value never printed" '[ "$rc" = 2 ] && echo "$out" | grep -q "contains a line break" && ! echo "$out" | grep -q "/tmp/x" && [ ! -s "$T/http.log" ]'

clear_all
echo 4242 > "$T/lsof-pid"
echo "ssh -N -L $P:127.0.0.1:$R ocm-test-host-that-does-not-exist" > "$T/ps-cmd"
out=$(run OCM_HOST=ssh://ocm-test-host-that-does-not-exist:2222 -- --check 2>&1); rc=$?
check "holder (o): OCM_HOST=ssh://...:port is normalised like destination: exit 0" '[ "$rc" = 0 ] && echo "$out" | grep -q "held by pid 4242"'

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
check "v2 run: rewrites --server, drops --dir, and folds --variant low into -m provider/model#low, carrying -s <id>" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P -s ses_http1 --agent lane-glm -m provider/model#low --format json hello v2$" "$T/args.log"'
out=$(run -- --dir "$D" --agent lane-glm --variant low -m provider/model#high "hello" 2>&1); rc=$?
check "v2 run: combining --variant and an already hashed -m is refused (2)" '[ "$rc" = 2 ] && [ "$(wc -l < "$T/args.log" | tr -d " ")" = 1 ]'
out=$(run -- --dir "$D" --server http://x "hello" 2>&1); rc=$?
check "v2 run: passing --server directly is refused (2)" '[ "$rc" = 2 ]'

# NVIDIA rewrite tests
clear_all
run -- --dir "$D" --agent lane-glm --variant low -m nvidia/z-ai/glm-5.3 --format json "hello nvidia" > /dev/null 2>&1; rc=$?
check "v2 run: rewrites nvidia/* with --variant low to variant none (#none), carrying -s <id>" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P -s ses_http1 --agent lane-glm -m nvidia/z-ai/glm-5.3#none --format json hello nvidia$" "$T/args.log"'
clear_all
run -- --dir "$D" --variant=low --model=nvidia/z-ai/glm-5.3 --format json "hello nvidia flag" > /dev/null 2>&1; rc=$?
check "v2 run: rewrites nvidia/* with --variant=low and --model=... to #none, carrying -s <id>" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P -s ses_http1 -m nvidia/z-ai/glm-5.3#none --format json hello nvidia flag$" "$T/args.log"'
clear_all
run -- --dir "$D" --agent lane-glm --variant high -m nvidia/z-ai/glm-5.3 --format json "hello nvidia high" > /dev/null 2>&1; rc=$?
check "v2 run: leaves nvidia/* with --variant high as #high, carrying -s <id>" '[ "$rc" = 0 ] && grep -q "^run --server http://127.0.0.1:$P -s ses_http1 --agent lane-glm -m nvidia/z-ai/glm-5.3#high --format json hello nvidia high$" "$T/args.log"'

# --- 7c. M3: a failed POST /api/session is exit 1; a v2 non-local dispatch
# --- carries -s <id>, and the client takes its directory from the session, not OCM_DIR.
clear_all; : > "$T/v2"; : > "$T/v2-session-fail"
out=$(run -- --dir "$D" --agent lane "p" 2>&1); rc=$?
check "M3: a failed POST /api/session exits 1" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not create a session"'
check "M3: ... and opencode is never started" '[ ! -s "$T/args.log" ]'
clear_all; : > "$T/v2"
run OCM_DIR=/bogus -- --dir "$D" --agent lane "p" > /dev/null 2>&1; rc=$?
check "M3: a v2 non-local dispatch creates a session on the server and carries -s <id>" '[ "$rc" = 0 ] && grep -q -- "-s ses_http1" "$T/args.log"'
check "M3: the client takes its directory from the session, not OCM_DIR" '[ "$(cat "$T/client-dir")" = "$D" ]'

# --- M6: the password reaches curl through --config - on stdin, never argv.
REAL_CURL=$(command -v curl)
cat > "$T/bin/curl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "\$T/curl.args.log"
case " \$* " in
  *" --config - "*)
    tee "\$T/curl.stdin" | "$REAL_CURL" "\$@"
    ;;
  *)
    "$REAL_CURL" "\$@" < /dev/null
    ;;
esac
EOF
chmod +x "$T/bin/curl"
clear_all; printf 'opencode:secret123\n' > "$T/auth-required"; : > "$T/curl.args.log"; : > "$T/curl.stdin"
out=$(run OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=secret123 -- --check 2>&1); rc=$?
check "M6: auth still works through --config - (check exits 0)" '[ "$rc" = 0 ] && echo "$out" | grep -q "ocm-run: ok"'
check "M6: curl is called with --config -" 'grep -q -- "--config -" "$T/curl.args.log"'
check "M6: the password never appears in any curl argv" '! grep -q "secret123" "$T/curl.args.log"'
check "M6: the config on curl's stdin carries user = \"opencode:secret123\"" 'grep -q "user = \"opencode:secret123\"" "$T/curl.stdin"'
rm -f "$T/bin/curl"
clear_all

# --- 8. D5 (L5a): --detach on a v2 server returns with the session id.
# The fake server lists a session in /api/session/active only after the fake client has
# started (POST creates a "created" session; the client flips it to "busy"), so these
# tests prove the readiness poll.

# (b): with a start delay, --detach does not print before the id is listed.
clear_all
runbg FAKE_START_TICKS=25 FAKE_TICKS=100 -- --detach --dir "$D" "p" > "$T/out" 2>&1; bg=$!
sleep 1
check "D5(b): no 'session started' before the id is listed" '! grep -q "session started" "$T/out"'
wait "$bg"; rc=$?
check "D5(b): once the id is listed it prints the line and exits 0" '[ "$rc" = 0 ] && grep -q "^session started: ses_http1 (detached)$" "$T/out"'

# (a)+(g): --detach returns within the start budget, prints "session started: ses_…
# (detached)", exits 0, and the session keeps running: --status lists it, --abort stops
# it, --wait returns 0 after. (g) replaces the old "--detach: stopped, it aborts nothing
# and the session runs on" check: --detach returns by itself and the lane survives.
clear_all
run FAKE_TICKS=600 -- --detach --dir "$D" --agent lane "p" > "$T/out" 2> "$T/err"; rc=$?
check "D5(a/g): --detach returns by itself (exit 0) and prints the session line" '[ "$rc" = 0 ] && grep -q "^session started: ses_http1 (detached)$" "$T/out"'
check "D5(g): the session is still running after it returned" '[ -e "$T/sessions/ses_http1" ]'
out=$(run -- --status --dir "$D" 2>&1); rc=$?
check "D5(a): --status exit 3 lists the detached session" '[ "$rc" = 3 ] && echo "$out" | grep -q "^ses_http1$"'
out=$(run -- --abort --dir "$D" 2>&1); rc=$?
check "D5(a): --abort stops it (interrupt recorded, session gone)" '[ "$rc" = 0 ] && grep -q "^ses_http1$" "$T/interrupts" && [ ! -e "$T/sessions/ses_http1" ]'
out=$(run OCM_WAIT_INTERVAL=1 OCM_WAIT_CONFIRM=1 -- --wait --dir "$D" 2>&1); rc=$?
check "D5(a): --wait returns 0 after the abort" '[ "$rc" = 0 ]'

# (c): a failed create exits 1 and starts nothing; a budget overrun exits 1 and aborts
# the created id, leaving no session behind.
clear_all; : > "$T/v2-session-fail"
out=$(run -- --detach --dir "$D" --agent lane "p" 2>&1); rc=$?
check "D5(c): a failed session create exits 1 and starts nothing" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not create a session" && [ ! -s "$T/args.log" ]'
clear_all
out=$(run FAKE_START_TICKS=10000 OCM_START_MAX=2 -- --detach --dir "$D" "p" 2>&1); rc=$?
check "D5(c): a budget overrun exits 1" '[ "$rc" = 1 ] && echo "$out" | grep -q "did not appear within 2 s"'
check "D5(c): the created id was aborted" 'grep -q "^ses_http1$" "$T/interrupts"'
check "D5(c): no session is left behind" '[ ! -e "$T/sessions/ses_http1" ]'

# (d): the detached client's stderr is in the log (a non-local dispatch logs under
# TMPDIR; the local-directory branch logs in <dir>/.lane, checked with D5(f)).
clear_all
run FAKE_TICKS=50 -- --detach --dir "$D" "p" > /dev/null 2>&1; rc=$?
check "D5(d): the detached stderr lands in the tmp log" '[ "$rc" = 0 ] && grep -q "a line on stderr" "${TMPDIR:-/tmp}/ocm-run.ses_http1.log"'

# (e): "database is locked" on the first launch relaunches once, then succeeds. The
# retry reuses the SAME session id: one session created, the first id printed, nothing
# aborted. The second client lives (FAKE_TICKS) so the poll sees its session before it ends.
clear_all; : > "$T/locked-once"
out=$(run FAKE_TICKS=50 -- --detach --dir "$D" --agent lane "p" > "$T/out" 2> "$T/err"); rc=$?
check "D5(e): database locked relaunches once, then success" '[ "$rc" = 0 ] && [ "$(wc -l < "$T/args.log" | tr -d " ")" = 2 ] && grep -q "retrying once" "$T/err" && grep -q "^session started: ses_http1 (detached)$" "$T/out"'
check "D5(e): the retry reused the first id: only one session was created" '[ "$(grep -c "^POST /api/session$" "$T/http.log")" = 1 ]'
check "D5(e): the first id was not aborted by the retry" '[ ! -s "$T/interrupts" ]'

# A failure after the create (here: <dir>/.lane cannot be created) aborts the created id
# and leaves no session behind.
clear_all; L2="$T/localfail"; mkdir -p "$L2"; : > "$L2/.lane"
out=$(run -- --detach --dir "$L2" "p" 2>&1); rc=$?
check "D5: a failed .lane creation exits 1" '[ "$rc" = 1 ] && echo "$out" | grep -q "could not create"'
check "D5: the created id was aborted after the .lane failure" 'grep -q "^ses_http1$" "$T/interrupts"'
check "D5: no session is left behind after the .lane failure" '[ ! -e "$T/sessions/ses_http1" ]'

# (f): the local-directory branch (a real local dir) creates the session the same way
# (POST), passes -s, prints an id too, and logs the detached client's stderr in
# <dir>/.lane/ocm-run.<id>.log.
clear_all; L="$T/localwt"; mkdir -p "$L"
run FAKE_TICKS=50 -- --detach --dir "$L" "p" > "$T/out" 2>&1; rc=$?
check "D5(f): the local-directory branch prints an id too" '[ "$rc" = 0 ] && grep -q "^session started: ses_http1 (detached)$" "$T/out"'
check "D5(f): the client takes the local directory from the session" '[ "$(cat "$T/client-dir")" = "$L" ]'
check "D5(d): the detached stderr is in <dir>/.lane/ocm-run.<id>.log" 'grep -q "a line on stderr" "$L/.lane/ocm-run.ses_http1.log"'

# A resumed session (-s <id> given by the caller) is the id polled and printed: the
# script does not create a new session and returns the resumed one.
clear_all
printf 'created\n%s\n' "$D" > "$T/sessions/ses_http9"
out=$(run FAKE_TICKS=50 -- --detach --dir "$D" -s ses_http9 "p" > "$T/out" 2>&1); rc=$?
check "D5(f): a resumed session (-s) is the one polled and printed" '[ "$rc" = 0 ] && grep -q "^session started: ses_http9 (detached)$" "$T/out"'

printf '%s failed\n' "$fails"
[ "$fails" = 0 ]
