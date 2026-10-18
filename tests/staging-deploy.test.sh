#!/bin/sh
# Tests for deploy/staging/deploy.sh. Nothing here can reach a cluster, a registry or a node:
#   - a throwaway git repository holds a copy of deploy/staging and of the .gitignore that keeps
#     staging.env untracked; every change to it is committed, because the script builds from HEAD
#     and refuses a dirty tree;
#   - stub `docker`, `ssh` and `kubectl` come first on PATH and do nothing but append their argv to
#     a log. `kubectl kustomize` prints the copied resources, `ssh` records its stdin and succeeds.
# The FIRST checks prove those guards and stop the file if one is missing.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
RUNSH=${STD_TEST_SH:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/staging-deploy-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# The repository under test: a copy of deploy/staging, committed, plus the repository .gitignore
# so that a real staging.env never shows up as an untracked file.
R=$T/repo
mkdir -p "$R/deploy" || exit 1
cp -R "$here/deploy/staging" "$R/deploy/staging" || exit 1
cp "$here/.gitignore" "$R/.gitignore" || exit 1
rm -f "$R/deploy/staging/staging.env"
SCRIPT=$R/deploy/staging/deploy.sh
( cd "$R" && git init -q . && git config user.email t@example.invalid && git config user.name t &&
  git add . && git -c commit.gpgsign=false commit -q -m init ) || exit 1

cat > "$T/bin/docker" <<'STUB'
#!/bin/sh
printf 'docker %s\n' "$*" >> "$T/calls.log"
exit 0
STUB
cat > "$T/bin/ssh" <<'STUB'
#!/bin/sh
printf 'ssh %s\n' "$*" >> "$T/calls.log"
case "$*" in
  *"apply -f -"*) cat > "$T/applied" ;;
  *) cat > /dev/null ;;
esac
STUB
cat > "$T/bin/kubectl" <<'STUB'
#!/bin/sh
printf 'kubectl %s\n' "$*" >> "$T/calls.log"
case "$*" in
  "kustomize deploy/staging")
    for f in namespace.yaml app.yaml networkpolicy.yaml; do cat "deploy/staging/$f"; done
    ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$T/bin/docker" "$T/bin/ssh" "$T/bin/kubectl"
export T
export PATH="$T/bin:$PATH"

# The values every case starts from. Nothing here is a real host: .example.invalid never resolves.
REG=registry.example.invalid/library
CTX=docker.example.invalid
NODE=node.example.invalid
HOST=fleet-v2.example.invalid
CA=staging-ca

run() { # run [VAR=value ...]: deploy.sh --yes in the fake world, from the root of the copy
  (
    unset STAGING_REGISTRY STAGING_DOCKER_CONTEXT STAGING_SSH STAGING_HOST STAGING_CLUSTER_ISSUER
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do export "$1"; shift; done
    [ $# -gt 0 ] && shift
    cd "$R" || exit 1
    exec "$RUNSH" "$SCRIPT" --yes < /dev/null
  ) > "$T/out" 2> "$T/err"
  echo $? > "$T/rc"
}
rc() { cat "$T/rc"; }
clear_log() { : > "$T/calls.log"; rm -f "$T/applied"; }
write_env() {
  { echo '# the staging target of this test'
    for line in "$@"; do echo "$line"; done
  } > "$R/deploy/staging/staging.env"
}
commit() { ( cd "$R" && git add -A && git -c commit.gpgsign=false commit -q -m "$1" ) || exit 1; }

echo '# the guards'
stub=$(command -v docker) && [ "$stub" = "$T/bin/docker" ] &&
  [ "$(command -v ssh)" = "$T/bin/ssh" ] && [ "$(command -v kubectl)" = "$T/bin/kubectl" ]
check "guard: docker, ssh and kubectl on the test PATH are the stubs" '[ "$stub" = "$T/bin/docker" ]'
check "guard: the script under test sits in a committed git repository of its own" \
  '[ "$(cd "$(git -C "$R" rev-parse --show-toplevel)" && pwd)" = "$R" ] && [ -z "$(git -C "$R" status --porcelain)" ]'
write_env "STAGING_REGISTRY=$REG" "STAGING_DOCKER_CONTEXT=$CTX" "STAGING_SSH=$NODE" \
  "STAGING_HOST=$HOST" "STAGING_CLUSTER_ISSUER=$CA"
ignored=$(cd "$R" && git check-ignore -q deploy/staging/staging.env && echo yes || echo no)
check "guard: the copied .gitignore keeps staging.env untracked (a dirty tree is refused)" \
  '[ "$ignored" = yes ] && [ -z "$(git -C "$R" status --porcelain)" ]'
rm -f "$R/deploy/staging/staging.env"
[ "$fails" = 0 ] || { echo "a guard is missing: stopping before any other check"; exit 1; }

echo '# a. nothing configured'
clear_log
run; rc=$(rc)
check "a: no variables and no staging.env is a usage error (2)" '[ "$rc" = 2 ]'
check "a: ... naming all five, on one line" \
  '[ "$(wc -l < "$T/err" | tr -d " ")" = 1 ] && grep -q "STAGING_REGISTRY" "$T/err" &&
     grep -q "STAGING_DOCKER_CONTEXT" "$T/err" && grep -q "STAGING_SSH" "$T/err" &&
     grep -q "STAGING_HOST" "$T/err" && grep -q "STAGING_CLUSTER_ISSUER" "$T/err"'
check "a: ... pointing at the example" 'grep -q "staging.env.example" "$T/err"'
check "a: ... and no tool was called" '[ ! -s "$T/calls.log" ]'

echo '# b. staging.env supplies all five'
write_env "STAGING_REGISTRY=$REG" "STAGING_DOCKER_CONTEXT=$CTX" "STAGING_SSH=$NODE" \
  "STAGING_HOST=$HOST" "STAGING_CLUSTER_ISSUER=$CA"
clear_log
tag=$(git -C "$R" rev-parse --short HEAD)
run; rc=$(rc)
check "b: a complete staging.env deploys (0)" '[ "$rc" = 0 ]'
check "b: ... the image is built on the given context, from the given registry and this commit" \
  'grep -q -- "docker --context $CTX build -t $REG/fleet-v2:$tag -" "$T/calls.log"'
check "b: ... and pushed there" 'grep -q -- "docker --context $CTX push $REG/fleet-v2:$tag" "$T/calls.log"'
check "b: ... and the prune lists that same repository" \
  'grep -q -- "docker --context $CTX image ls --format {{.CreatedAt}}|{{.Repository}}:{{.Tag}} $REG/fleet-v2" "$T/calls.log"'
check "b: ... the ClusterIssuer check asks the given ssh target for the given issuer" \
  'grep -q -- "ssh $NODE .* get clusterissuer $CA -o name" "$T/calls.log"'
check "b: ... the applied manifest carries the image, the host and the issuer" \
  'grep -q "image: $REG/fleet-v2:$tag" "$T/applied" && grep -q "host: $HOST" "$T/applied" &&
     grep -q "cluster-issuer: $CA" "$T/applied" && grep -q -- "- $HOST" "$T/applied"'
check "b: ... and no STAGING_ token survived the rendering" '! grep -q "STAGING_" "$T/applied"'
check "b: ... and the deploy ends on the ingress URL" 'grep -q "https://$HOST" "$T/out"'

echo '# c. the environment wins over the file'
ENVHOST=env-wins.example.invalid
clear_log
run "STAGING_HOST=$ENVHOST"; rc=$(rc)
check "c: STAGING_HOST from the environment beats the file: still a deploy (0)" '[ "$rc" = 0 ]'
check "c: ... the applied manifest carries the environment host" 'grep -q "host: $ENVHOST" "$T/applied"'
check "c: ... and not the one in staging.env" '! grep -q "$HOST" "$T/applied"'
check "c: ... the other four still come from the file" \
  'grep -q "cluster-issuer: $CA" "$T/applied" && grep -q "image: $REG/fleet-v2:" "$T/applied" &&
     grep -q -- "docker --context $CTX build" "$T/calls.log"'

echo '# d. a value that is not plain'
BAD=stg.example.invalid#tag
clear_log
rm -f "$R/deploy/staging/staging.env"
run "STAGING_REGISTRY=$REG" "STAGING_DOCKER_CONTEXT=$CTX" "STAGING_SSH=$NODE" \
  "STAGING_HOST=$BAD" "STAGING_CLUSTER_ISSUER=$CA"; rc=$(rc)
check "d: a value holding a # is a usage error (2)" '[ "$rc" = 2 ]'
check "d: ... the message names STAGING_HOST" 'grep -q "STAGING_HOST" "$T/err"'
check "d: ... and never the value" '! grep -q "$BAD" "$T/err" && ! grep -q "$BAD" "$T/out"'
check "d: ... no tool was called" '[ ! -s "$T/calls.log" ]'

echo '# d2. one empty value among four good ones'
clear_log
run "STAGING_REGISTRY=$REG" "STAGING_DOCKER_CONTEXT=$CTX" "STAGING_SSH=$NODE" \
  "STAGING_HOST=" "STAGING_CLUSTER_ISSUER=$CA"; rc=$(rc)
check "d2: an empty value is named on its own (2)" '[ "$rc" = 2 ] && grep -q "unset or empty: STAGING_HOST\." "$T/err"'
check "d2: ... and the four that were set are not named" '! grep -q "unset or empty: STAGING_REGISTRY" "$T/err"'
check "d2: ... and no tool was called" '[ ! -s "$T/calls.log" ]'
write_env "STAGING_REGISTRY=$REG" "STAGING_DOCKER_CONTEXT=$CTX" "STAGING_SSH=$NODE" \
  "STAGING_HOST=$HOST" "STAGING_CLUSTER_ISSUER=$CA"

echo '# e. a placeholder that survives the rendering'
APP=$R/deploy/staging/app.yaml
sed 's#^\(    cert-manager.io/cluster-issuer: STAGING_CLUSTER_ISSUER\)$#\1\
    fleet-v2.example.invalid/extra: STAGING_EXTRA#' "$APP" > "$APP.new" && mv "$APP.new" "$APP"
commit extra-placeholder
clear_log
run; rc=$(rc)
check "e: an unsubstituted placeholder is a refusal (1)" '[ "$rc" = 1 ]'
check "e: ... it says a placeholder survived" 'grep -q "STAGING_ placeholder" "$T/err"'
check "e: ... and ssh never received an apply" '! grep -q "kubectl apply" "$T/calls.log"'
check "e: ... while the earlier checks still ran" 'grep -q "kubectl kustomize deploy/staging" "$T/calls.log"'

echo
echo "$(grep -c '^check ' "$self") checks defined, $fails failed"
[ "$fails" = 0 ]