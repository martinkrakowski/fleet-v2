# Installation examples

This directory holds placeholder templates for the operator-local
`installation/fleet.json`. Copy the file that matches your setup to
`installation/fleet.json` at the repository root and replace the placeholder
values; `installation/` is gitignored, so real values never reach the index.
Every file stores paths and placeholders, never credential values: create
each referenced credential file with mode `600` (for example
`waves.tokenFile`) and keep it on the operator host.

- `v1/fleet.json` — the schema v1 shape, kept as the compatibility fixture.
  It still loads unchanged in meaning; `v1` shelf fields are accepted and
  ignored with a warning.
- `single-machine/fleet.json` — schema v2, one local host holding every role.
- `multi-machine/fleet.json` — schema v2, a local orchestrator host with the
  lane-runner and verifier hosts reached over ssh.

## Schema v2

A v2 file names `hosts` (each with a `transport`, a `worktreeRoot`, `roles`
and an optional `runner`), the enabled `tools`, `seats` and per-role `chains`,
a `policy`, a `shelf` provider, a `forge` mode, and the `verification`
procedures and `waves` sections carried over from v1. Exactly one host holds
the `orchestrator` role and its `transport` must be `"local"`; exactly one
host holds `lane-runner`. A verifier host
replaces the v1 `verification.sshHost`; hosts with `transport: "ssh"` name
their `sshAlias`.

**Isolation is declared, never assumed (D4).** Every `runner` may carry a
`capabilities` block (`networkEgressRestricted`, `cpuAndMemoryLimited`,
`processTreeTermination`, `filesystemScope`). There is no `source` field in
the file: the loader derives it — `declared` when the block is present,
`undeclared` when it is not — and a file carrying `source` is refused. A v1
or environment-only runner maps to `source: "legacy-asserted"` with today's
asserted capabilities; only that mapping can produce it. The single-machine
example declares no isolation (`filesystemScope: "inherited-directory"` with
all booleans false); make the values match the isolation your machine really
provides.

**Shelf (D1).** `shelf` is `{ "provider": "local" }` or the git provider with
`repoDir`, `branch` and `pathPrefix`. The v1 `shelf.baseUrl`/`keyFile`
transport is removed from the product: in a v1 file those fields are accepted
and ignored with a warning naming D1; in a v2 file they are refused.

**Forge (D6).** `forge` is `{ "mode": "github", "owner": ..., "repo": ... }`
or `{ "mode": "none" }`. With `none`, forge actions refuse and acceptance is
receipt-only; the mode is an explicit choice, never a fallback.

**Policy.** The `policy` section carries its shape (forbidden routes and the
per-lane cost ceiling); the rules are validated by the loader through the
`validatePolicy` hook and refined in a later lane.

## v1 compatibility and environment

The loader maps every v1 section onto the v2 model internally: the runner and
its fallback chain become one host's runner and the implementer chain, the
reviewer becomes the reviewer chain, and the worktree and verification ssh
hosts become ssh hosts. Nothing migrates implicitly; a later
`init --migrate` writes the v2 form.

The environment variables (`FLEET_RUNNER_AGENT`, `FLEET_RUNNER_MODEL`,
`FLEET_RUNNER_VARIANT`, `OCM_REMOTE_PORT`, `OCM_HOST`, `FLEET_OCM_RUN_BIN`,
`FLEET_WORKTREE_SSH_HOST`) override the v1 sections after parsing and never
carry a token or credential; they do not apply to a v2 file, which configures
its hosts in the file itself.
