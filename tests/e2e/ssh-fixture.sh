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
#       exactly four lines:
#           FLEET_E2E_DIR=<dir>
#           FLEET_E2E_HOME=<dir>/home
#           FLEET_E2E_PORT=<port>
#           FLEET_E2E_ALIAS=fleet-e2e
#   sh tests/e2e/ssh-fixture.sh stop <dir>
#       kills the sshd from the pid file (TERM, then KILL) and removes the dir.
#
# `sshd` missing prints `unavailable=no-sshd` and exits 3. The real
# `~/.ssh` is never touched: every key and the client config live under the
# fixture dir.
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

user=$(id -un)

d=$(mktemp -d "${TMPDIR:-/tmp}/fleet-e2e.XXXXXX") || exit 1
chmod 700 "$d"

die() {
  echo "$1" >&2
  rm -rf "$d"
  exit 1
}

ssh-keygen -q -N '' -t ed25519 -f "$d/host_key" || die 'host key generation failed'
ssh-keygen -q -N '' -t ed25519 -f "$d/client_key" || die 'client key generation failed'
cat "$d/client_key.pub" > "$d/authorized_keys"
chmod 600 "$d/authorized_keys"

# Pick a free high port: try 5 random ports in 40000..60000 with sshd until
# one of them stays up (the pid file appears and the daemon is alive).
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
  sleep 0.2
  if [ -f "$d/sshd.pid" ] && kill -0 "$(cat "$d/sshd.pid" 2>/dev/null)" 2>/dev/null; then
    port=$p
    break
  fi
done
[ -n "$port" ] || die 'could not start sshd on a free high port'

# Wait until the port answers (TCP connect), with a sleep fallback when nc is absent.
if command -v nc >/dev/null 2>&1; then
  i=0
  while [ "$i" -lt 40 ]; do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      break
    fi
    sleep 0.25
    i=$((i + 1))
  done
  if [ "$i" -ge 40 ]; then
    die 'sshd did not answer on the chosen port'
  fi
else
  sleep 1
fi

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

printf 'FLEET_E2E_DIR=%s\n' "$d"
printf 'FLEET_E2E_HOME=%s\n' "$home"
printf 'FLEET_E2E_PORT=%s\n' "$port"
printf 'FLEET_E2E_ALIAS=fleet-e2e\n'
exit 0
