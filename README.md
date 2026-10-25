# Fleet

An open-source assembly line for agentic work, with [Waves](https://github.com/martinkrakowski/waves) as its observation and decision service.

Approved work becomes a frozen brief, a disposable lane, a commit, verification, an independent review, fixes, and an authorised merge. The process persists. Workers are disposable. Memory travels into the next brief only when an orchestrator selects it.

Fleet is a CLI-first modular system in four bounded contexts, built on a hexagonal architecture generated and checked by [Hexagen](https://github.com/hexagen-monaco/hexagen-monaco) from `.architecture/manifest.yaml`. Domain code is pure. Application code depends on ports. Filesystem, subprocess, network and vendor code live in infrastructure adapters.

## Status (2026-10-25)

The contexts, the CLI, the HTTP API, the MCP server and the web app build, typecheck, lint, pass the architecture lint and the test suite, and match the manifest. The end-to-end workflow runs across separate CLI processes on one state directory, from profile registration to an authorised merge.

"Not wired" below means the port and an adapter exist, but no composition root (`apps/cli`, `apps/api`) binds the adapter yet, so the boundary refuses or reports its own absence.

| Boundary | State |
|---|---|
| Lane dispatch, status, stop | Live through the bundled `bin/ocm-run`, with an argument array and an environment allow-list. A busy worktree (exit 75) is a refusal. Status comes from the lane server, never from the local watcher. A start that is refused or blocked keeps its capacity reservation, and an attempt with no recorded session is reconciled or stopped by its worktree directory. Before every dispatch the frozen brief's SHA-256 digest is recomputed, and a brief or manifest changed since `brief prepare` is refused. |
| agy (Antigravity CLI) lanes | `bin/agy-run` runs a headless agy lane with a fixed prompt that reads the brief; `bin/agy-round` drives one fix round in a container clone. The `AgyRunnerAdapter` exists but is not wired: dispatch always uses `ocm-run`. |
| Worktree inspection, brief placement, artifact collection | Live, locally or over SSH to the attempt's recorded host. Every caller-supplied worktree path is checked against the worktree root. A brief is placed only under a path proven gitignored. Artifacts are collected only against a completion receipt bound to the attempt. |
| Lane diff gate | `scripts/lane-diff-check.sh` reviews a lane's diff before its output is committed: protected paths (agent, editor, package-manager and git files, `scripts/lane-diff-check.protected`), git filter drivers, symlink escapes, credential-shaped strings and files outside the brief. It prints file, line and pattern name, never a matched value. The operator runs it; the TypeScript port mirrors its rules and is not wired. |
| Verification checks | Runs only the procedures the installation allow-lists, mapped to executables, never a command string. With no installation every check reports `unknown`. |
| Pull request create and merge | Live in the CLI through `gh` from fixed paths, only after acceptance of the exact candidate head; merges are pinned to that head. Not wired in the API. |
| Project profiles | `fleet-v2 projects list\|show\|add\|adopt\|edit\|retire\|probe` and `/v1/projects`. **A new work order needs an active profile** (CLI and API). Edits and retires are compare-and-swap on the revision read; on a v2 installation host and procedure names are checked against it. The probe is read-only and prints the command that would fix a failure. See [docs/runbooks/onboard-a-project.md](docs/runbooks/onboard-a-project.md). |
| Durable state | File-backed under `--state-dir` / `FLEET_STATE_DIR`: JSON under a file lock, atomic writes, and a revision check that refuses a stale attempt write. Without a state directory every store is in-memory and the process is disposable. |
| Usage | `attempt usage` reads a finished attempt's tokens and cost from the lane server's database on the recorded host and saves them on the attempt. Not exposed by the API. |
| Evidence and acceptance | Review receipts, verification receipts and finding dispositions are validated before they are stored. Every reported finding starts unresolved and blocks acceptance until a disposition is recorded. The independent review transport is not wired, so review requests report `unavailable`; the reviewer's model must differ from the implementer's. |
| Forge evidence (CI state, unresolved threads) | Read through `gh` when the installation configures a GitHub forge; otherwise `unknown` or `not-configured`. |
| Waves observations, decisions, relays, attention | Observations and relays go to local outbox directories; signed decisions are read from local answer files; attention reads report absence. The HTTP adapter to a live Waves service is not wired. |
| Knowledge shelf | Keepers append to a local shelf file under the state directory. The git shelf provider is not wired. |
| HTTP API | Nitro. Refuses to start on a non-loopback host unless `FLEET_API_ALLOW_REMOTE=1`. `/health` answers without auth. Every `/v1` route needs a bearer token from `FLEET_API_TOKEN_FILE` and an allowed Origin, and stays `501` until a state directory and token are configured. |
| MCP server | `apps/mcp`, stdio. Every tool calls the API's `/v1` routes; without `FLEET_API_URL` and `FLEET_API_TOKEN_FILE` it answers "not configured". |
| Web app | The Lanes page renders recorded attempts from `GET /v1/attempts` on every request and refreshes every 30 s, labelled as recorded state, not runner observations; without a configured API it shows the fixture and says why. Other views read fixtures. Every mutating action opens a confirmation first. |
| Container image and staging | `build-image.yml` builds the image on pull requests and scans it; on `main` it pushes by digest, scans again, writes an SBOM and signs it. It never deploys: staging runs a digest pinned in the operator's platform repository. `deploy/staging/` holds a manual deploy script whose targets come from `staging.env` (see `staging.env.example`). |
| Continuous integration | `gate.yml` runs the gate below plus the model-family fixture check and the shell tests. `gitleaks.yml` scans for secrets. |

Every boundary above that is not yet wired refuses or reports its own absence rather than inventing an answer. That is by design: an unconfigured port is never an implicit pass.

## What belongs here

| Package | Owns |
|---|---|
| `packages/work-execution` | Work orders, attempts, frozen briefs, capacity, dispatch, reconciliation and the forge action |
| `packages/evidence-and-acceptance` | Verification, independent review, and acceptance bound to an exact commit |
| `packages/brief-knowledge` | Candidate notes, checked lessons, lexical retrieval with a budget, and brief context selection |
| `packages/operator-coordination` | Project profiles and capabilities, scoped decisions, relays, observations, and the Waves anti-corruption boundary |
| `packages/ui` | Presentation primitives shared by the web app |
| `packages/installation` | Loading and validating the operator's installation file |
| `packages/onboarding` | `init`, `doctor`, `hosts` and `seats`: setting up and checking an installation |
| `packages/tooling` | Detecting the agent CLIs a host offers (opencode, agy, Claude Code, Grok) |
| `packages/shared` | Small pure helpers shared across contexts (host names, secret patterns, decision types) |

`apps/cli` is the operator entry point and a composition root. `apps/api` (Nitro, its own composition root), `apps/mcp` (an MCP server over the API) and `apps/web` (Next.js) are the operator surfaces. They call application ports and own no domain rules.

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
# register a project before its first work order (see docs/runbooks/onboard-a-project.md)
node apps/cli/dist/bin.js --state-dir ./.fleet/state projects add --project-id demo \
  --display-name Demo --repository https://example.com/demo.git \
  --dispatcher-host <host> --policy-revision 1 --max-lanes 2
```

Every command takes its typed request as one JSON object with `--json`, or as `--kebab-case` flags. The typed result prints to stdout as one JSON document. Exit codes are part of the contract: `0` completed, `1` refused, rejected, blocked or unknown, `2` usage error.

Run the API and the web app, in separate terminals:

```sh
FLEET_STATE_DIR=./.fleet/state yarn workspace @fleet/api dev        # http://localhost:3001
FLEET_API_URL=http://localhost:3001 yarn workspace @fleet/web dev    # http://localhost:3000
```

The API's `dev` and `preview` scripts listen on `127.0.0.1`. Without `FLEET_STATE_DIR` and `FLEET_API_TOKEN_FILE` it answers `501` for every use case instead of serving empty state. To listen on another address (inside a container, say), set `HOST` and `FLEET_API_ALLOW_REMOTE=1`; without the flag it refuses to start.

`node apps/cli/dist/bin.js --help` lists every command group: projects, work orders, briefs, capacity, attempts, the forge, evidence, knowledge, decisions, coordination, questions, and the installation commands `init`, `doctor`, `hosts` and `seats`.

## Configuration

These values belong to the operator's installation, never to this repository.

| Variable | Meaning |
|---|---|
| `FLEET_STATE_DIR` | Directory for repositories, journals, evidence archives, receipts and outboxes. The CLI's `--state-dir` flag overrides it. |
| `FLEET_INSTALLATION_FILE` | Path to the installation configuration file (default `installation/fleet.json` under the working directory). |
| `FLEET_WORKTREE_SSH_HOST` | Host that owns the lane worktrees. Worktree inspection and artifact collection run there over SSH. |
| `FLEET_RUNNER_AGENT`, `FLEET_RUNNER_MODEL`, `FLEET_RUNNER_VARIANT` | The runner seat. The model and variant are recorded in the frozen brief manifest. |
| `OCM_REMOTE_PORT` | The single port passed to the runner subprocess. |
| `FLEET_FORGE_PUSH_ORIGIN`, `FLEET_PR_TITLE`, `FLEET_PR_BODY`, `FLEET_PR_DELETE_BRANCH` | Forge settings used by `gh` after acceptance. |
| `FLEET_API_URL`, `NEXT_PUBLIC_FLEET_API_URL` | Base URL of the HTTP API for the MCP server and the web app's client (`api-client.ts`). Pages currently render fixtures. |
| `FLEET_API_TOKEN_FILE` | File holding the API's bearer token, read by the API, the MCP server and the web client. |
| `FLEET_API_ALLOWED_ORIGINS` | Origins the API accepts. |
| `FLEET_API_ALLOW_REMOTE` | `1` lets the API listen on a non-loopback host. |
| `FLEET_OWNER_PUBLIC_KEY` | Public key that verifies signed decisions. |
| `OCM_HOST` | SSH target `bin/ocm-run` uses for its tunnel to the lane server. |
| `FLEET_OCM_RUN_BIN`, `FLEET_USAGE_NODE_BIN` | Overrides for the runner binary and for the node binary that reads usage on the runner host. |
| `AGY_BIN` | The agy binary `bin/agy-run` runs, set on the lane host. |
| `AGY_ROUND_SSH`, `AGY_ROUND_ROOT`, `AGY_ROUND_GUARD_SSH`, `AGY_ROUND_GUARD_CMD` | Where `bin/agy-round` finds the lane container, its clones, and the hash check. No defaults. |

Put installation data (hosts, paths, project registries, model seats, variants, fallbacks, capacities, service URLs) under the ignored `installation/` directory. Runtime artifacts belong under `.fleet/`. Lane briefs and notes stay in ignored paths inside the lane's own worktree.

## The gate

```sh
yarn build
yarn typecheck
yarn lint
yarn lint:arch
yarn test
yarn sync:check
yarn test:bin
```

`yarn sync:check` proves the tree still matches the manifest. Change the manifest before adding a context, port, use case or adapter, then regenerate with `yarn sync`. Root files are protected; pass `--force-root` only when their templates should be rewritten.

## Trust boundaries

- Every path a caller supplies for a worktree, a brief or an artifact is resolved against the worktree root and refused if it escapes.
- A lane's output is reviewed by the lane diff gate before it is committed, and the bundled runner scripts are pinned by SHA-256 in `scripts/*-hash.txt`.
- Lanes run in scoped worktrees or sandboxes. They never receive provider credentials, and they cannot push, open pull requests, merge, or reach Waves or the knowledge shelf.
- The provider boundary is a host-side key proxy outside this product. Tool deny-lists and prompt text do not substitute for runtime isolation.
- A signed Waves decision proves a scoped answer; the controller still checks applicability, revision, action scope and prior consumption. Silence is not approval. A Waves outage must not corrupt an attempt.
- Notes are bounded candidate claims collected after the lane server says the lane ended. Keepers need checked scope and provenance. Policy proposals are never memory entries.
- Privileged host steps, spending, production deployment and policy changes remain explicit operator decisions. The product performs none of them.

## Relationship to Waves and to the Fleet workshop

Waves stays an independently usable product: projects publish versioned observations, and signed decisions bind a particular proposal and revision. Fleet consumes those contracts through an adapter and never merges Waves' source.

This repository is the distribution of a process that first ran as shell scripts in a private workshop. Those scripts move behind typed ports one workflow at a time, after the port exists and the behaviour is proved against the current command. Until the operator declares a workflow moved, the script remains the live path for it. The bundled `bin/ocm-run` derives from the workshop copy and differs on purpose: it has `--help`, rewrites `--model=` to `-m`, and sets no default `OCM_HOST`. `scripts/ocm-run-hash.txt` pins the bundled copy, as `scripts/agy-run-hash.txt` pins `bin/agy-run`.

## Contributing

Every pull request description ends with three sections after "What" and "Proof": **Hard to undo**, **Assumptions**, and **Challenge this**. "None" is an answer and carries a one-line reason. Run the full gate before opening a pull request. Do not commit credentials, tokens, client content or installation values.

## License

[MIT](LICENSE). Copyright (c) 2026 Martin Krakowski.
