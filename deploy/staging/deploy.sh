#!/bin/sh
# Build, push and roll out fleet-v2 staging.
#
# The image is built from `git archive HEAD` on the midnight Docker context
# and pushed to Harbor. Manifests are rendered here and applied on the node.
# Same shape as campaign-foundry's deploy/staging/deploy.sh, without that
# project's database, queue or object store.
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
if [ -n "$(git status --porcelain)" ]; then
  echo "deploy.sh: the tree has changes; the image is built from HEAD, so commit or stash first." >&2
  exit 1
fi

TAG=$(git rev-parse --short HEAD)
IMAGE="registry.midnight.lan/library/fleet-v2:$TAG"
CONTEXT="${STAGING_DOCKER_CONTEXT:-midnight}"
NODE="${STAGING_SSH:-m}"
NS=fleet-v2-staging
remote() { ssh "$NODE" "KUBECONFIG=\$HOME/.kube/config $*"; }

if [ "$CONFIRMED" != yes ]; then
  if [ ! -t 0 ]; then
    echo "deploy.sh: no terminal to confirm on; pass --yes to deploy $TAG to staging." >&2
    exit 1
  fi
  printf 'Deploy %s (%s) to staging (https://fleet-v2.midnight.lan)? [y/N] ' \
    "$TAG" "$(git log -1 --format=%s)"
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
if ! remote "kubectl get clusterissuer midnight-ca -o name" >/dev/null 2>&1; then
  echo "deploy.sh: ClusterIssuer midnight-ca is missing." >&2
  exit 1
fi

echo "==> build $IMAGE on $CONTEXT"
git archive --format=tar HEAD | docker --context "$CONTEXT" build -t "$IMAGE" -
echo "==> push"
docker --context "$CONTEXT" push "$IMAGE"

echo "==> prune local images (keep the 2 newest)"
if ! local_images=$(docker --context "$CONTEXT" image ls \
  --format "{{.CreatedAt}}|{{.Repository}}:{{.Tag}}" registry.midnight.lan/library/fleet-v2); then
  echo "deploy.sh: could not list local images; prune skipped" >&2
else
  printf '%s\n' "$local_images" | sort -r | tail -n +3 | cut -d"|" -f2 |
    while read -r old; do
      [ -n "$old" ] || continue
      docker --context "$CONTEXT" rmi "$old" >/dev/null 2>&1 ||
        echo "deploy.sh: could not remove $old (kept)" >&2
    done
fi

RENDERED=$(kubectl kustomize deploy/staging | sed "s#registry.midnight.lan/library/fleet-v2:latest#$IMAGE#")

echo "==> apply"
printf '%s\n' "$RENDERED" | remote kubectl apply -f -
echo "==> wait for rollout"
remote kubectl -n "$NS" rollout status deployment/fleet-v2 --timeout=180s
echo "==> deployed $IMAGE"
echo "    https://fleet-v2.midnight.lan"
