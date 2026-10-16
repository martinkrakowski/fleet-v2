# Fleet v2 agent instructions

This project is a generated, CLI-first hexagonal scaffold. Read
`.architecture/manifest.yaml` and `docs/architecture.md` before changing it.

- Keep the four business contexts and their declared acyclic dependency direction.
- Domain code is pure. Application code depends on ports. Every filesystem,
  subprocess, network, database and vendor dependency belongs in infrastructure.
- Refine typed contracts before implementing a station. Generated empty ports and
  stubs do not establish an implemented guarantee.
- Use the existing Fleet scripts behind adapters before replacing their behaviour.
- Workers are disposable and isolated. Context enters through frozen briefs;
  candidate notes never become instructions or authority automatically.
- Never read, print, copy or commit credentials, tokens, secrets or client content.
- Live dispatch, host administration, real data migration and deployment require
  their existing explicit authority. Scaffolding grants none of those actions.
- Keep installation configuration and runtime artifacts in ignored paths.
- No console logging in package code; CLI I/O belongs at the application boundary.
- Update the manifest when adding owned ports, use cases or adapters. Regenerate
  using Hexagen rather than manually duplicating its symbol scaffolds.
- After changes run `yarn build && yarn typecheck && yarn lint && yarn lint:arch`.
  Run meaningful tests for implemented behaviour and `yarn sync:check` for drift.
- Do not commit or push unless explicitly requested.

## Operator entrypoints

- Build once with `yarn workspace @fleet/cli build`, then run the CLI as
  `node apps/cli/dist/bin.js`. `fleet-v2 --help` lists every command group;
  `fleet-v2 <group> --help` lists its subcommands.
- The global `--state-dir <path>` option (or `FLEET_STATE_DIR`) selects where
  repositories, journals, evidence archives and outboxes persist. A missing or
  malformed flag value is a usage error; when neither the flag nor the variable
  carries a value every store is in-memory and the process is disposable.
- Exit codes are part of the contract: `0` completed, `1` refused, rejected,
  blocked or unknown, `2` usage error.
- `@fleet/api` is a Nitro server started from `apps/api/.output/server/index.mjs`.
  Its runtime bootstrap plugin reads `FLEET_STATE_DIR`; without it the API stays
  unconfigured rather than silently serving empty state.

## Live runner and worktree configuration

These belong to the operator host. Never commit their values, and never widen the
runner environment allowlist to smuggle a setting through.

- `FLEET_WORKTREE_SSH_HOST` — host that owns the runner worktrees.
- `FLEET_RUNNER_AGENT`, `FLEET_RUNNER_MODEL`, `FLEET_RUNNER_VARIANT` — the
  runner seat selection; the model/variant pair is recorded in the frozen brief.
- `OCM_REMOTE_PORT` — the single port passed to the runner subprocess.
- `OCM_HOST` — SSH target used by the bundled `bin/ocm-run` to open the loopback
  tunnel to the OpenCode server when `127.0.0.1:<OCM_REMOTE_PORT + 1>` is not
  already listening. It is distinct from `FLEET_WORKTREE_SSH_HOST`: that variable
  names the host holding git worktrees, never the runner tunnel target.
- `FLEET_OCM_RUN_BIN` — override for the runner binary path. The repository
  bundles `bin/ocm-run` and `ExecutionRunnerAdapter` resolves it automatically;
  the override exists only for unusual installations.
- `FLEET_API_URL` — the server-side base URL for `@fleet/api`. The web client
  prefers it, falls back to `NEXT_PUBLIC_FLEET_API_URL`, and falls back again to
  the fixture set when neither is configured.

- `AGY_BIN` — set in the lane host's own environment (never added to the runner
  environment allow-list) to override the agy binary used by `bin/agy-run`, the agy
  sibling of `bin/ocm-run`. agy lanes dispatch only through that script: the prompt is
  fixed to the brief inside the worktree, `--model` is mandatory, and
  `--dangerously-skip-permissions` is refused. `scripts/agy-run-hash.txt` pins the
  script. `yarn test:bin` runs every shell test under `tests/`.

Before committing what any lane produced, run `scripts/lane-diff-check.sh <worktree>`
(protected paths, credential-shaped strings, files outside the brief); it prints file, line and
pattern name only, never a matched value.

## Web UI action rules

- Every action button in `@fleet/web` that would change something must open
  `@fleet/ui`'s `AlertBox` and wait for an explicit confirm. No action fires on
  click alone.
- The confirmation body states what the action does, what it does not do, and
  whether a live route exists yet. It is never a bare "Are you sure?".
- Navigation and view controls (theme toggle, drawer toggle, filters, row
  selection) are not domain actions and stay immediate.
- A view that still mutates client state must say so on screen; client state is
  not a record.
