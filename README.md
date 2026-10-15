# Fleet

An open-source assembly line for agentic work, with [Waves](https://github.com/martinkrakowski/waves) as its observation and decision service.

Approved work becomes a frozen brief, a disposable lane, a commit, verification, an independent review, fixes, and an authorised merge. The process persists. Workers are disposable. Memory travels into the next brief only when an orchestrator selects it.

Fleet is a CLI-first modular system in four bounded contexts, built on a hexagonal architecture generated and checked by [Hexagen](https://github.com/hexagen-monaco/hexagen-monaco) from `.architecture/manifest.yaml`. Domain code is pure. Application code depends on ports. Filesystem, subprocess, network and vendor code live in infrastructure adapters.

## Status (2026-10-15)

The four contexts, the CLI, the HTTP API and the web app build, typecheck, lint, pass the architecture lint and the test suite, and match the manifest. The end-to-end workflow runs across separate CLI processes on one state directory, from profile registration to an authorised merge.

What each boundary does today:

| Boundary | State |
|---|---|
| Lane dispatch, status, stop | Live. Wraps the bundled `bin/ocm-run` (override with `FLEET_OCM_RUN_BIN`; remote host from `OCM_HOST`) with an argument array and an environment allow-list. Status comes from the lane server, never from the local watcher. |
| Worktree inspection, brief placement, artifact collection | Live, over SSH to the host that owns the worktrees. A brief is placed only under an ignored path. Commits are counted against the pre-dispatch tip. |
| Verification checks | The adapter runs only allow-listed procedures mapped to executables, and never interpolates a command string. The shipped composition root configures no allow-list yet, so every check reports that it cannot run. |
| Pull request create and merge | Live through `gh`, and only after acceptance of the exact candidate head. A moved head is refused. |
| Durable state (work orders, attempts, journal, evidence, receipts, keepers) | File-backed under `--state-dir` / `FLEET_STATE_DIR`, written atomically. Without a state directory every store is in-memory and the process is disposable. |
| Independent review | Port and independence checks exist (the reviewer's model must differ from the implementer's). No review transport is configured yet, so requests report `unavailable`. |
| Forge evidence (CI state, unresolved threads) | Port exists; no `gh pr checks` transport is bound yet, so evidence reads as `unknown`. |
| Waves observations, decisions, relays, attention | Observations and relays go to local outbox directories; decisions are read from local answer files; attention reads report absence. The HTTP adapter to a live Waves service is not wired. |
| Knowledge shelf | Keepers append to a local shelf file under the state directory. Publication to an external shelf is not wired. |
| Web app | Renders live data from the API when `FLEET_API_URL` is set, and says on screen when it fell back to fixtures. Every mutating action opens a confirmation first. |
| Staging | A deployment script for a Kubernetes namespace is in `deploy/staging/` (`yarn staging:deploy --yes`). It currently hard-codes the author's own registry (`registry.midnight.lan`) and namespace (`fleet-v2-staging`); edit `deploy/staging/` for another installation. |
| Continuous integration | No GitHub Actions workflow yet. Run the gate below before opening a pull request. |

Every boundary above that is not yet wired refuses or reports its own absence rather than inventing an answer. That is by design: an unconfigured port is never an implicit pass.

## What belongs here

| Package | Owns |
|---|---|
| `packages/work-execution` | Work orders, attempts, frozen briefs, capacity, dispatch, reconciliation and the forge action |
| `packages/evidence-and-acceptance` | Verification, independent review, and acceptance bound to an exact commit |
| `packages/brief-knowledge` | Candidate notes, checked lessons, lexical retrieval with a budget, and brief context selection |
| `packages/operator-coordination` | Project profiles and capabilities, scoped decisions, relays, observations, and the Waves anti-corruption boundary |
| `packages/ui` | Presentation primitives shared by the web app |

`apps/cli` is the operator entry point and the composition root. `apps/api` (Nitro) and `apps/web` (Next.js) are the operator surfaces. They call application ports and own no domain rules.

Dependency direction, trust rules and the migration order are in [docs/architecture.md](docs/architecture.md). How the tree was generated is in [docs/scaffold-verification.md](docs/scaffold-verification.md). Runbooks for a first run, reconciling an attempt and checking runner readiness are under [docs/runbooks](docs/runbooks).

## Quick start

```sh
corepack enable
yarn install --immutable
yarn build
```

Run the CLI:

```sh
node apps/cli/dist/bin.js --help
# template: replace <profile-json> with a profile matching the coordination schema
node apps/cli/dist/bin.js --state-dir ./.fleet/state coordination register-profile --json '<profile-json>'
```

Every command takes its typed request as one JSON object with `--json`, or as `--kebab-case` flags. The typed result prints to stdout as one JSON document. Exit codes are part of the contract: `0` completed, `1` refused, rejected, blocked or unknown, `2` usage error.

Run the API and the web app, in separate terminals:

```sh
FLEET_STATE_DIR=./.fleet/state yarn workspace @fleet/api dev        # http://localhost:3001
FLEET_API_URL=http://localhost:3001 yarn workspace @fleet/web dev    # http://localhost:3000
```

Without `FLEET_STATE_DIR` the API answers `501` for every use case instead of serving empty state.

## Configuration

These values belong to the operator's installation, never to this repository.

| Variable | Meaning |
|---|---|
| `FLEET_STATE_DIR` | Directory for repositories, journals, evidence archives, receipts and outboxes. The CLI's `--state-dir` flag overrides it. |
| `FLEET_WORKTREE_SSH_HOST` | Host that owns the lane worktrees. Worktree inspection and artifact collection run there over SSH. |
| `FLEET_RUNNER_AGENT`, `FLEET_RUNNER_MODEL`, `FLEET_RUNNER_VARIANT` | The runner seat. The model and variant are recorded in the frozen brief manifest. |
| `OCM_REMOTE_PORT` | The single port passed to the runner subprocess. |
| `FLEET_FORGE_PUSH_ORIGIN`, `FLEET_PR_TITLE`, `FLEET_PR_BODY`, `FLEET_PR_DELETE_BRANCH` | Forge settings used by `gh` after acceptance. |
| `FLEET_API_URL`, `NEXT_PUBLIC_FLEET_API_URL` | Base URL the web app uses for the API. With neither set the web app renders fixtures and says so. |

Put installation data (hosts, paths, project registries, model seats, variants, fallbacks, capacities, service URLs) under the ignored `installation/` directory. Runtime artifacts belong under `.fleet/`. Lane briefs and notes stay in ignored paths inside the lane's own worktree.

## The gate

```sh
yarn build
yarn typecheck
yarn lint
yarn lint:arch
yarn test
yarn sync:check
```

`yarn sync:check` proves the tree still matches the manifest. Change the manifest before adding a context, port, use case or adapter, then regenerate with `yarn sync`. Root files are protected; pass `--force-root` only when their templates should be rewritten.

## Trust boundaries

- Lanes run in scoped worktrees or sandboxes. They never receive provider credentials, and they cannot push, open pull requests, merge, or reach Waves or the knowledge shelf.
- The provider boundary is a host-side key proxy outside this product. Tool deny-lists and prompt text do not substitute for runtime isolation.
- A signed Waves decision proves a scoped answer; the controller still checks applicability, revision, action scope and prior consumption. Silence is not approval. A Waves outage must not corrupt an attempt.
- Notes are bounded candidate claims collected after the lane server says the lane ended. Keepers need checked scope and provenance. Policy proposals are never memory entries.
- Privileged host steps, spending, production deployment and policy changes remain explicit operator decisions. The product performs none of them.

## Relationship to Waves and to the Fleet workshop

Waves stays an independently usable product: projects publish versioned observations, and signed decisions bind a particular proposal and revision. Fleet consumes those contracts through an adapter and never merges Waves' source.

This repository is the distribution of a process that first ran as shell scripts in a private workshop. Those scripts move behind typed ports one workflow at a time, after the port exists and the behaviour is proved against the current command. Until the operator declares a workflow moved, the script remains the live path for it.

## Contributing

Every pull request description ends with three sections after "What" and "Proof": **Hard to undo**, **Assumptions**, and **Challenge this**. "None" is an answer and carries a one-line reason. Run the full gate before opening a pull request. Do not commit credentials, tokens, client content or installation values.

## License

[MIT](LICENSE). Copyright (c) 2026 Martin Krakowski.
