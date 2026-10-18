#!/bin/sh
# Build, push and roll out fleet-v2 staging.
#
# The image is built from `git archive HEAD` on the Docker context named below
# and pushed to the registry named below. Manifests are rendered here and applied
# on the cluster node. Same shape as campaign-foundry's deploy/staging/deploy.sh,
# without that project's database, queue or object store.
#
# The target belongs to the installation, never to this repository. Five
# variables are required and none has a default: STAGING_REGISTRY (registry and
# path), STAGING_DOCKER_CONTEXT, STAGING_SSH (ssh target of the cluster node),
# STAGING_HOST (ingress hostname) and STAGING_CLUSTER_ISSUER. They come from the
# environment, or from deploy/staging/staging.env when that file exists; a value
# already set in the environment wins over the file. Copy
# deploy/staging/staging.env.example to get started.
#
#   yarn staging:deploy          asks before building
#   yarn staging:deploy --yes    deploys without asking
set -eu

CONFIRMED=no
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=yes ;;
    *)
      echo "usage: yarn staging:deploy [--yes]" >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# The target: the environment first, then deploy/staging/staging.env. Remember what the
# environment carried, read the file, and put back every value that was set and non-empty.
_env_registry=${STAGING_REGISTRY:-}
_env_context=${STAGING_DOCKER_CONTEXT:-}
_env_ssh=${STAGING_SSH:-}
_env_host=${STAGING_HOST:-}
_env_issuer=${STAGING_CLUSTER_ISSUER:-}
if [ -f deploy/staging/staging.env ]; then
  . ./deploy/staging/staging.env
fi
if [ -n "$_env_registry" ]; then STAGING_REGISTRY=$_env_registry; fi
if [ -n "$_env_context" ]; then STAGING_DOCKER_CONTEXT=$_env_context; fi
if [ -n "$_env_ssh" ]; then STAGING_SSH=$_env_ssh; fi
if [ -n "$_env_host" ]; then STAGING_HOST=$_env_host; fi
if [ -n "$_env_issuer" ]; then STAGING_CLUSTER_ISSUER=$_env_issuer; fi
unset _env_registry _env_context _env_ssh _env_host _env_issuer

# Every missing value is named at once, and nothing is called before they are all there.
missing=''
[ -n "${STAGING_REGISTRY:-}" ] || missing="$missing STAGING_REGISTRY"
[ -n "${STAGING_DOCKER_CONTEXT:-}" ] || missing="$missing STAGING_DOCKER_CONTEXT"
[ -n "${STAGING_SSH:-}" ] || missing="$missing STAGING_SSH"
[ -n "${STAGING_HOST:-}" ] || missing="$missing STAGING_HOST"
[ -n "${STAGING_CLUSTER_ISSUER:-}" ] || missing="$missing STAGING_CLUSTER_ISSUER"
if [ -n "$missing" ]; then
  echo "deploy.sh: unset or empty:$missing. Copy deploy/staging/staging.env.example to \
deploy/staging/staging.env and fill it in, or export them." >&2
  exit 2
fi

# The values reach a sed expression and a command line, so they stay plain. A bad value is
# named, never printed.
usable() {
  case "$2" in
    -*)
      echo "deploy.sh: $1 is not usable: it may not start with -." >&2
      exit 2
      ;;
    *[!A-Za-z0-9._:/-]*)
      echo "deploy.sh: $1 is not usable: letters, digits and . _ : / - only." >&2
      exit 2
      ;;
  esac
}
usable STAGING_REGISTRY "$STAGING_REGISTRY"
usable STAGING_DOCKER_CONTEXT "$STAGING_DOCKER_CONTEXT"
usable STAGING_SSH "$STAGING_SSH"
usable STAGING_HOST "$STAGING_HOST"
usable STAGING_CLUSTER_ISSUER "$STAGING_CLUSTER_ISSUER"

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy.sh: the tree has changes; the image is built from HEAD, so commit or stash first." >&2
  exit 1
fi

TAG=$(git rev-parse --short HEAD)
IMAGE="$STAGING_REGISTRY/fleet-v2:$TAG"
CONTEXT=$STAGING_DOCKER_CONTEXT
NODE=$STAGING_SSH
NS=fleet-v2-staging
remote() { ssh "$NODE" "KUBECONFIG=\$HOME/.kube/config $*"; }

if [ "$CONFIRMED" != yes ]; then
  if [ ! -t 0 ]; then
    echo "deploy.sh: no terminal to confirm on; pass --yes to deploy $TAG to staging." >&2
    exit 1
  fi
  printf 'Deploy %s (%s) to staging (https://%s)? [y/N] ' \
    "$TAG" "$(git log -1 --format=%s)" "$STAGING_HOST"
  read -r answer
  case "$answer" in
    y | Y | yes) ;;
    *)
      echo "Not deployed."
      exit 1
      ;;
  esac
fi

echo "==> TLS issuer"
if ! remote "kubectl get clusterissuer $STAGING_CLUSTER_ISSUER -o name" >/dev/null 2>&1; then
  echo "deploy.sh: ClusterIssuer $STAGING_CLUSTER_ISSUER is missing." >&2
  exit 1
fi

echo "==> build $IMAGE on $CONTEXT"
git archive --format=tar HEAD | docker --context "$CONTEXT" build -t "$IMAGE" -
echo "==> push"
docker --context "$CONTEXT" push "$IMAGE"

echo "==> prune local images (keep the 2 newest)"
if ! local_images=$(docker --context "$CONTEXT" image ls \
  --format "{{.CreatedAt}}|{{.Repository}}:{{.Tag}}" "$STAGING_REGISTRY/fleet-v2"); then
  echo "deploy.sh: could not list local images; prune skipped" >&2
else
  printf '%s\n' "$local_images" | sort -r | tail -n +3 | cut -d"|" -f2 |
    while read -r old; do
      [ -n "$old" ] || continue
      docker --context "$CONTEXT" rmi "$old" >/dev/null 2>&1 ||
        echo "deploy.sh: could not remove $old (kept)" >&2
    done
fi

# app.yaml carries the three placeholders; the values are already checked, so they are
# safe here as a sed replacement.
RENDERED=$(kubectl kustomize deploy/staging | sed \
  -e "s#STAGING_IMAGE#$IMAGE#g" \
  -e "s#STAGING_HOST#$STAGING_HOST#g" \
  -e "s#STAGING_CLUSTER_ISSUER#$STAGING_CLUSTER_ISSUER#g")

# A placeholder that survived would reach the cluster as a literal string: apply nothing.
case "$RENDERED" in
  *STAGING_*)
    echo "deploy.sh: the rendered manifest still holds a STAGING_ placeholder; nothing was applied." >&2
    exit 1
    ;;
esac

echo "==> apply"
printf '%s\n' "$RENDERED" | remote kubectl apply -f -
echo "==> wait for rollout"
remote kubectl -n "$NS" rollout status deployment/fleet-v2 --timeout=180s
echo "==> deployed $IMAGE"
echo "    https://$STAGING_HOST"
