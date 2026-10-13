# Fleet

An open-source assembly line for agentic work, with Waves as its observation and decision service.

Approved work becomes a frozen brief, a disposable lane, a commit, verification, an independent review, fixes, and an authorised merge. The process persists. Workers are disposable. Memory travels in the next brief only when an orchestrator selects it.

This repository is the distribution of that system. It is configured by [Hexagen](https://github.com/hexagen-monaco/hexagen-monaco) from `.architecture/manifest.yaml`. The working Fleet scripts and the Waves service are the behaviour being ported here. Nothing from those projects has been migrated yet, and this scaffold does not dispatch work, talk to a live Waves service, or hold installation data.

## What belongs here

**Fleet** is the operator's assembly line. One CLI composes four business contexts. They stay in-process, and their dependencies stay acyclic.

| Package | Owns |
|---|---|
| `packages/work-execution` | Work orders, attempts, frozen briefs, capacity, dispatch, and reconciliation |
| `packages/evidence-and-acceptance` | Verification, independent review, and acceptance bound to an exact commit |
| `packages/brief-knowledge` | Candidate notes, checked lessons, and bounded retrieval |
| `packages/operator-coordination` | Scoped decisions, relays, and the Waves anti-corruption boundary |

`apps/cli` is the operator entry point and the composition root. `apps/api` (Nitro) and `apps/web` (Next.js) are the operator surfaces. They call application ports. They do not own domain rules.

**Waves** stays an independently usable product: projects publish versioned observations, and signed decisions bind a particular proposal and revision. Fleet consumes those contracts through an adapter. A Waves outage must not corrupt an attempt. Silence is not approval.

Domain code is pure. Application code depends on ports. Filesystem, subprocess, network, database, and vendor code live in infrastructure. Existing Fleet scripts move behind those adapters one workflow at a time, after the typed contract is in place and the behaviour is proved.

## Status

This is the initial Hexagen scaffold (0.14.0).

- Generated ports and use cases are placeholders. Use cases refuse execution until a station is implemented.
- The four contexts, the CLI, the API, and the web app build, typecheck, and lint. That is a chassis, not a working assembly line.
- A license has not been chosen. Pick one before a public release.

The dependency direction, trust rules, and migration order are in [docs/architecture.md](docs/architecture.md). How this tree was generated is in [docs/scaffold-verification.md](docs/scaffold-verification.md).

## Develop

```sh
corepack enable
yarn install --immutable
yarn build
yarn typecheck
yarn lint
yarn lint:arch
yarn test
yarn sync:check
```

Frontend and API, in separate terminals:

```sh
yarn workspace @fleet/web dev    # http://localhost:3000
yarn workspace @fleet/api dev    # http://localhost:3001
```

`yarn test` is allowed to pass with no test files. Add tests when a station is implemented. Regenerate from the manifest with `yarn sync`. Change the manifest before adding a context, port, use case, or adapter. Root files are protected; pass `--force-root` only when their templates should be rewritten.

## What stays out of the product

Installation configuration is not product code: hosts, paths, project registries, model seats, variants, fallbacks, capacities, and service URLs. Put that under the ignored `installation/` directory. Runtime artifacts belong under `.fleet/`. Lane briefs and notes stay in ignored paths inside the lane's own worktree.

Do not commit credentials, tokens, or client content. Lanes do not receive credentials, and they cannot push, open pull requests, merge, or reach Waves.
