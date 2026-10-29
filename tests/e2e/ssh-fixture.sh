#!/bin/sh
# Lane Q1a: a disposable sshd on a loopback high port for the conductor
# end-to-end fixture.
#
#   sh tests/e2e/ssh-fixture.sh start
#       makes a private dir, generates an ed25519 host key and a throwaway
#       client key, writes authorized_keys, picks a free high port in
#       40000..60000 (trying 5 random ports with sshd until one listens),
#       writes an sshd_config, starts `sshd -f <config> -E <dir>/sshd.log`
#       (non-root; logins only as the current user), waits until the port
#       answers, and writes a client home whose `~/.ssh/config` names the
#       alias `fleet-e2e` with the host key pinned in known_hosts. It prints
#       exactly five lines:
#           FLEET_E2E_DIR=<dir>
#           FLEET_E2E_HOME=<dir>/home
#           FLEET_E2E_BIN=<dir>/bin
#           FLEET_E2E_PORT=<port>
#           FLEET_E2E_ALIAS=fleet-e2e
#
# OpenSSH reads the client config from the passwd home directory
# (getpwuid), never from `$HOME`, so callers prepend `FLEET_E2E_BIN`
# to PATH: the `ssh` wrapper there forces `-F` onto the fixture's
# `~/.ssh/config` (which still lives at `FLEET_E2E_HOME`).
#
#   sh tests/e2e/ssh-fixture.sh stop <dir>
#       kills the sshd from the pid file (TERM, then KILL) and removes the dir.
#
# `sshd` missing prints `unavailable=no-sshd` and exits 3; `ssh` missing
# prints `unavailable=no-ssh` and exits 3. The real `~/.ssh` is never
# touched: every key and the client config live under the fixture dir.
set -u

usage() {
  echo "usage: sh tests/e2e/ssh-fixture.sh start|stop <dir>" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
cmd=$1

if [ "$cmd" = stop ]; then
  [ "$#" -ge 2 ] || usage
  d=$2
  pidfile="$d/sshd.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      i=0
      while [ "$i" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 0.1
        i=$((i + 1))
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$d"
  exit 0
fi

[ "$cmd" = start ] || usage

sshd_bin=$(command -v sshd)
if [ -z "$sshd_bin" ] || [ ! -x "$sshd_bin" ]; then
  echo 'unavailable=no-sshd'
  exit 3
fi

# The wrapper needs the real ssh binary: OpenSSH reads the user config from
# getpwuid, never from $HOME, so callers reach the fixture config through the
# wrapper's forced `-F`.
ssh_bin=$(command -v ssh)
if [ -z "$ssh_bin" ] || [ ! -x "$ssh_bin" ]; then
  echo 'unavailable=no-ssh'
  exit 3
fi

user=$(id -un)

d=$(mktemp -d "${TMPDIR:-/tmp}/fleet-e2e.XXXXXX") || exit 1
# Canonicalise once so a TMPDIR with a trailing slash or a symlinked /tmp
# never yields a `//` or unresolved path (WorkspaceAdapter refuses `//`).
d=$(cd "$d" && pwd -P)
chmod 700 "$d"

die() {
  echo "$1" >&2
  pidfile="$d/sshd.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      i=0
      while [ "$i" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 0.1
        i=$((i + 1))
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$d"
  exit 1
}

# A caller that gives up on the start (a timeout) sends TERM: die() then kills
# the daemon of the current attempt (if any) and removes the dir with the keys
# in it, leaving nothing behind. Installed before the first file is written.
trap 'die "ssh-fixture: start interrupted"' INT TERM

ssh-keygen -q -N '' -t ed25519 -f "$d/host_key" || die 'host key generation failed'
ssh-keygen -q -N '' -t ed25519 -f "$d/client_key" || die 'client key generation failed'
cat "$d/client_key.pub" > "$d/authorized_keys"

chmod 600 "$d/authorized_keys"

# Pick a free high port: try 5 random ports in 40000..60000 with sshd until
# one of them stays up AND answers on TCP. The daemon's exit status is
# checked, the pid file is awaited with a bounded loop, and a daemon that
# started but did not answer is killed before trying the next port.
port=''
attempt=0
while [ "$attempt" -lt 5 ]; do
  attempt=$((attempt + 1))
  raw=$(od -An -N2 -tu2 /dev/urandom 2>/dev/null | tr -d ' \n')
  if [ -z "$raw" ]; then
    raw=$(( ($$ * 1009 + attempt * 7919) % 20001 ))
  fi
  p=$(( 40000 + raw % 20001 ))
  cfg="$d/sshd_config"
  {
    echo "Port $p"
    echo 'ListenAddress 127.0.0.1'
    echo "HostKey $d/host_key"
    echo "AuthorizedKeysFile $d/authorized_keys"
    echo 'PasswordAuthentication no'
    echo 'KbdInteractiveAuthentication no'
    echo 'UsePAM no'
    echo 'StrictModes no'
    echo "PidFile $d/sshd.pid"
    echo 'PermitUserEnvironment no'
    echo "AllowUsers $user"
  } > "$cfg"
  rm -f "$d/sshd.pid" "$d/sshd.log"
  "$sshd_bin" -f "$cfg" -E "$d/sshd.log" >/dev/null 2>&1
  rc_sshd=$?
  i=0
  while [ "$i" -lt 20 ] && [ ! -f "$d/sshd.pid" ]; do
    sleep 0.1
    i=$((i + 1))
  done
  pid=''
  if [ -f "$d/sshd.pid" ]; then
    pid=$(cat "$d/sshd.pid" 2>/dev/null || true)
  fi
  if [ "$rc_sshd" -eq 0 ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    answered=false
    if command -v nc >/dev/null 2>&1; then
      j=0
      while [ "$j" -lt 16 ]; do
        if nc -z -w 2 127.0.0.1 "$p" 2>/dev/null; then
          answered=true
          break
        fi
        sleep 0.25
        j=$((j + 1))
      done
    else
      # nc absent: give the daemon a moment and trust its pid/liveness.
      sleep 1
      answered=true
    fi
    if [ "$answered" = true ]; then
      port=$p
      break
    fi
  fi
  # This attempt failed: kill the daemon (TERM, then KILL) before the
  # next port, so nothing leaks between attempts.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    k=0
    while [ "$k" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 0.1
      k=$((k + 1))
    done
    kill -KILL "$pid" 2>/dev/null || true
  fi
done
[ -n "$port" ] || die 'could not start sshd on a free high port'

# The client home: config and known_hosts only under the fixture dir.
home="$d/home"
mkdir -p "$home/.ssh"
chmod 700 "$home/.ssh"
set -- $(cat "$d/host_key.pub")
htype=$1
hkey=$2
printf '[127.0.0.1]:%s %s %s\n' "$port" "$htype" "$hkey" > "$home/.ssh/known_hosts"
chmod 600 "$home/.ssh/known_hosts"
{
  echo 'Host fleet-e2e'
  echo 'HostName 127.0.0.1'
  echo "Port $port"
  echo "User $user"
  echo "IdentityFile $d/client_key"
  echo 'IdentitiesOnly yes'
  echo "UserKnownHostsFile $home/.ssh/known_hosts"
  echo 'StrictHostKeyChecking yes'
  echo 'BatchMode yes'
} > "$home/.ssh/config"
chmod 600 "$home/.ssh/config"

# The ssh wrapper: OpenSSH reads the client config from the passwd home
# directory, never from $HOME, so callers prepend THIS dir to PATH and the
# wrapper forces `-F` onto the fixture config.
mkdir -p "$d/bin"
chmod 700 "$d/bin"
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
{
  echo '#!/bin/sh'
  printf 'exec %s -F %s "$@"\n' "$(sq "$ssh_bin")" "$(sq "$home/.ssh/config")"
} > "$d/bin/ssh"
chmod 700 "$d/bin/ssh"

printf 'FLEET_E2E_DIR=%s\n' "$d"
printf 'FLEET_E2E_HOME=%s\n' "$home"
printf 'FLEET_E2E_BIN=%s\n' "$d/bin"
printf 'FLEET_E2E_PORT=%s\n' "$port"
printf 'FLEET_E2E_ALIAS=fleet-e2e\n'
exit 0
