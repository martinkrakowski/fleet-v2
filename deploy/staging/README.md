# Staging (k3s)

Fleet-v2 staging follows campaign-foundry's deploy recipe: one image built from
`git archive HEAD` on the Docker context below, pushed to the registry below,
applied with kustomize. It does not install Postgres, Kafka or SeaweedFS. Those
belong to campaign-foundry's own namespace.

The target belongs to the installation, so nothing here names a host. Five
variables are required and none has a default:

| Variable | Meaning |
| --- | --- |
| `STAGING_REGISTRY` | Registry and path that holds the image. The image is `$STAGING_REGISTRY/fleet-v2:<commit>`. |
| `STAGING_DOCKER_CONTEXT` | Docker context the image is built and pushed on. |
| `STAGING_SSH` | ssh target of the cluster node the manifests are applied on. |
| `STAGING_HOST` | Ingress hostname, asked about before the build and printed after it. |
| `STAGING_CLUSTER_ISSUER` | cert-manager ClusterIssuer checked before the build. |

Put them in the environment, or copy
[`staging.env.example`](staging.env.example) to `deploy/staging/staging.env` and
fill it in. That file is ignored by git; a value already set in the environment
wins over the file. A value that is missing, empty or holds anything but
letters, digits and `. _ : / -` stops the deploy before any tool is called.

| Piece | How |
| --- | --- |
| Web | `next start` on port 3000, ingress `https://$STAGING_HOST` |
| API | Nitro on port 3001 in the same Pod (`127.0.0.1:3001`). Not on the ingress. |
| TLS | ClusterIssuer `$STAGING_CLUSTER_ISSUER`, installed ahead of the deploy |
| Namespace | `fleet-v2-staging` |

```sh
yarn staging:deploy
yarn staging:deploy --yes
```

The script refuses a dirty tree and refuses to run without a terminal unless
`--yes` is passed. It checks that the ClusterIssuer exists before it builds.
`app.yaml` carries the `STAGING_IMAGE`, `STAGING_HOST` and
`STAGING_CLUSTER_ISSUER` placeholders; the script substitutes them while
rendering, and applies nothing if a placeholder survives.

## API Configuration and Activation

Staging stays 501 until the owner creates a mode-600 token file, mounts it as a Secret, and sets `FLEET_STATE_DIR` and `FLEET_API_TOKEN_FILE`. Do not add or commit any secret value.
