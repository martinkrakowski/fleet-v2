# Staging (k3s on midnight)

Fleet-v2 staging follows campaign-foundry's deploy recipe: one image built from
`git archive HEAD` on the `midnight` Docker context, pushed to Harbor, applied
with kustomize. It does not install Postgres, Kafka or SeaweedFS. Those belong
to campaign-foundry's own namespace.

| Piece | How |
| --- | --- |
| Web | `next start` on port 3000, ingress `https://fleet-v2.midnight.lan` |
| API | Nitro on port 3001 in the same Pod (`127.0.0.1:3001`). Not on the ingress. |
| TLS | ClusterIssuer `midnight-ca`, already installed for the other staging apps |
| Namespace | `fleet-v2-staging` |

```sh
yarn staging:deploy
yarn staging:deploy --yes
```

The script refuses a dirty tree and refuses to run without a terminal unless
`--yes` is passed. It checks that `midnight-ca` exists before it builds.
