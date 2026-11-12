# Runbook: cutover

*Date: 2026-11-11 · Status: operator runbook for this checkout. Switch and retire are not implemented.*

This runbook covers the cutover commands that exist in this checkout. `cutover switch` and `cutover retire` are not mounted, so the plan's switch (§3.3) and retirement (§3.5) steps are not runnable yet. Nothing here records a switch, writes a retired record, or removes an adapter.

## Shadow

The shadow record requires 3 consecutive shadow days (`CUTOVER_SHADOW_CONSECUTIVE_DAYS`) and at least 20 merged PRs (`CUTOVER_SHADOW_MIN_MERGES`).

Commands that exist today:

- `fleet-v2 cutover status` is read-only. With no cutover record it exits 0 with `outcome` `completed`, `state` `shadow`, `revision` 0, and `record` null. `withinRollbackWindow` is null when the record is missing or `switchedAtIso` is null.
- `fleet-v2 cutover shadow report --repository <owner>/<repo> --legacy-state-dir <path>` compares enqueue sets only, writes nothing, and is not an S1–S13 verdict. A complete comparison with divergent enqueue sets returns `outcome` `completed` with `equal` false and exits 0, so the exit code alone never signals a divergence — check `equal` and `complete`. Exit 1 means the report is not a pass: `outcome` `unknown` (`shell-state-incomplete`), or `refused` (`shell-queue-absent`, `shell-queue-unreadable`, `secret-shaped`), or `complete` false.
- `fleet-v2 merge import --repository <owner>/<repo> --legacy-state-dir <path>` is a dry-run unless `--apply` is paired with `--authority`.
- `fleet-v2 state check` and `fleet-v2 daemon status` are read-only.
- `fleet-v2 conductor status` is the status read.

Status does not evaluate S1–S13. A completed status is not a shadow pass. Do not start `conductor run --live` from this runbook.

## Switch preconditions

`cutover switch` is not a subcommand. `fleet-v2 cutover switch` exits 2 as an unknown subcommand and does not print `move-not-implemented`. The use case would refuse that move in-process; this lane does not mount it. Because switch is not implemented, the steps in plan §3.3 are not runnable as a cutover move.

Checks the operator can run today, each of which is not itself a switch:

- `cutover status` — an `unknown` outcome is exit 1, not a go.
- `cutover shadow report` — only when `outcome` is `completed`, `equal` is true, and `complete` is true.
- `merge import` without `--apply`.
- `state check`.
- `release install` without `--apply` — it writes nothing; `--apply` is deployment authority and still does not record a cutover switch.
- `hosts daemon install --scheduler systemd` without `--apply` — it prints `would-write` and the enable and linger lines, and does not run them.
- `relaunch inventory` is the only relaunch command. `relaunch plan` and `relaunch apply` are not commands (exit 2).

## Rollback

The rollback window is 14 days (`CUTOVER_ROLLBACK_WINDOW_DAYS`).

`fleet-v2 cutover rollback --expected-revision <n> --operation-id <id>` exists, with optional `--now-iso` and `--deadline-iso`. It pauses the daemon and lifts only a train pause the cutover itself set, and it requires a stored `switched` record. A record that was never switched is refused `not-switched` (exit 1). Nothing in this checkout writes `switched`, because switch is not implemented. An unreadable store is `unknown` (exit 1), not success.

`fleet-v2 daemon pause` exists as its own command.

`merge export` and `merge export --legacy` are not commands: `fleet-v2 merge export` exits 2. Plan §3.4 step 5 has no CLI yet. Do not invent flags. Merges already made stay made.

## Retirement

`cutover retire` is not a subcommand (exit 2). No retire procedure is available in this checkout.

`LegacyTrainStateReadAdapter` stays while shadow report and merge import read the shell state directory.

`hosts daemon uninstall --scheduler systemd` removes fleet-v2 units only, and only with `--apply`. It does not remove a shell timer and it does not archive shell state.

Deleting `tools/fleet-v2-orchestrator/` is a change in the other repository, not a command here.

## Not this runbook

Removing adapters, mounting switch or retire, adding `merge export`, starting `conductor run --live`, printing secrets, or treating exit 1 `unknown` as an empty shadow.
