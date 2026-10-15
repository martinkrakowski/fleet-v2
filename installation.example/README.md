# Installation example

This directory holds a redacted template for the operator-local installation
file. Copy `fleet.json` to `installation/fleet.json` at the repository root and
replace the placeholder values; `installation/` is gitignored, so real values
never reach the index.

The file stores paths, never credential values: create each referenced
credential file with mode `600` (for example `waves.tokenFile`) and keep it on
the operator host.

Environment variables (`FLEET_RUNNER_AGENT`, `FLEET_RUNNER_MODEL`,
`FLEET_RUNNER_VARIANT`, `OCM_REMOTE_PORT`, `OCM_HOST`, `FLEET_OCM_RUN_BIN`,
`FLEET_WORKTREE_SSH_HOST`) override file values when set and non-empty, and
never carry a token or credential.
