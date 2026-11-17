# Runbook: cutover

*Date: 2026-11-17 · Status: operator runbook for this checkout. `cutover switch` and `cutover retire` are mounted. Switch reads the recorded shadow ledger and still cannot complete a switch.*

This runbook covers the cutover commands that exist in this checkout. `cutover switch` and `cutover retire` are mounted in `apps/cli/src/commands/cutover.ts`. Switch reads `<stateDir>/cutover-shadow.json` and still refuses or halts before it writes a `switched` record. Retire writes a retired record only after a stored `switched` record and the 14-day window. Nothing here removes an adapter.

## Shadow

The shadow record requires 3 consecutive shadow days (`CUTOVER_SHADOW_CONSECUTIVE_DAYS`) and at least 20 merged PRs (`CUTOVER_SHADOW_MIN_MERGES`).

Commands that exist today:

- `fleet-v2 cutover status` is read-only. With no cutover record it exits 0 with `outcome` `completed`, `state` `shadow`, `revision` 0, and `record` null. `withinRollbackWindow` is null when the record is missing or `switchedAtIso` is null.
- `fleet-v2 cutover shadow report --repository <owner>/<repo> --legacy-state-dir <path>` counts the shell side's queue, parked and in-progress lines, and keys fleet entries by their own recorded base branch rather than assuming `main`. It still compares enqueue sets only, writes nothing, and is still not an S1–S13 verdict. A complete comparison with divergent enqueue sets returns `outcome` `completed` with `equal` false and exits 0, so the exit code alone never signals a divergence — check `equal` and `complete`. Exit 1 means the report is not a pass: `outcome` `unknown` (`shell-state-incomplete`, including a missing `inprogress` in the port's answer), or `refused` (`shell-queue-absent`, `shell-queue-unreadable`, `secret-shaped`), or `complete` false.
- `fleet-v2 cutover shadow record-day --repository <owner>/<repo> --legacy-state-dir <path> [--day YYYY-MM-DD]` (SH8a) records one UTC day into `<stateDir>/cutover-shadow.json`. Those days are what `cutover switch` reads. `record-day` passes `releaseSha: async () => null` today.
- `fleet-v2 merge import --repository <owner>/<repo> --legacy-state-dir <path>` is a dry-run unless `--apply` is paired with `--authority`.
- `fleet-v2 state check` and `fleet-v2 daemon status` are read-only.
- `fleet-v2 conductor status` is the status read.

Status does not evaluate S1–S13. A completed status is not a shadow pass. Do not start `conductor run --live` from this runbook.

## Switch preconditions

`cutover switch` is mounted. It requires `--expected-revision`, `--operation-id`, and `--relaunch-plan-digest` (64 lowercase hex), with optional `--now-iso` and `--deadline-iso`. A bare `fleet-v2 cutover switch` exits 2 as a usage error. It does not print `move-not-implemented`.

`cutover switch` reads `<stateDir>/cutover-shadow.json` via `composeCutoverShadowEvidence`: the newest 3 consecutive UTC days, each bound to one shared non-null `releaseSha`, summed for the 20-merge floor, all S1–S13 recorded as `pass`. `cutover shadow record-day` (SH8a) produces the days this reads. The composer's staleness check uses the daemon clock (`daemon.now()`). It never takes the operator's `--now-iso`. `--now-iso` is the clock the criterion reader uses for its future-day check.

`cutover switch` cannot pass evidence until a release-sha source lands. `record-day` passes `releaseSha: async () => null` today, so every recorded window composes to `release-changed` and the switch refuses `shadow-evidence-absent`. SH20 records the pinned release.

A window that does pass the evidence gate still stops at `unknown` / `unrecorded-lanes-unknown` until `countUnrecordedLanes` is wired. That halt writes no `cutover.json` switch record and no `cutover-journal.json` intent. Preflight runs before any intent is appended.

Fail closed, and never treat an unknown or partial ledger as a pass:

- No durable state directory, or no `cutover-shadow.json`: `shadow-evidence-absent` (exit 1), naming every criterion S1–S13.
- Fewer than 3 days, a stale newest day (more than one UTC day before the daemon clock), or a null or varying `releaseSha`: `shadow-evidence-absent` (exit 1), naming every criterion.
- Non-consecutive UTC days, a newest day after `--now-iso`, fewer than 20 total merges, or any S1–S13 recorded `fail` or missing: `shadow-criteria-failed` (exit 1), naming the failed criteria (every criterion when the window shape or the merge floor fails).
- Unreadable, malformed, null, or corrupt `cutover-shadow.json`, including a verdict other than `pass` or `fail`, or duplicate or non-array days: `unknown` / `shadow-evidence-unreadable` (exit 1). This is not absence.
- A newer `schemaVersion`: `unknown` / `shadow-evidence-unknown-version` (exit 1). This is not absence.
- A deadline already past: `unknown` / `deadline-exceeded` (exit 1).

Two residuals this unit does not close. Both are owner preconditions for the unit that wires `countUnrecordedLanes` (CO30c), which becomes the last closed gate:

- Release binding is equality among the three days only. Nothing compares that sha to the installed release.
- Verdict digests are not re-verified, and there is no evaluator or digest-format version, so an older-format or hand-edited day is not detected. Only shape, freshness, and the lanes gate stand behind a passing window.

Checks the operator can run today, each of which is not itself a completed switch:

- `cutover status` — an `unknown` outcome is exit 1, not a go.
- `cutover shadow report` — only when `outcome` is `completed`, `equal` is true, and `complete` is true.
- `merge import` without `--apply`.
- `state check`.
- `release install` without `--apply` — it writes nothing; `--apply` is deployment authority and still does not record a cutover switch.
- `hosts daemon install --scheduler systemd` without `--apply` — it prints `would-write` and the enable and linger lines, and does not run them.
- `relaunch inventory` is the only relaunch command. `relaunch plan` and `relaunch apply` are not commands (exit 2).

## Rollback

The rollback window is 14 days (`CUTOVER_ROLLBACK_WINDOW_DAYS`).

`fleet-v2 cutover rollback --expected-revision <n> --operation-id <id>` exists, with optional `--now-iso` and `--deadline-iso`. It pauses the daemon and lifts only a train pause the cutover itself set, and it requires a stored `switched` record. A record that was never switched is refused `not-switched` (exit 1). `cutover switch` is mounted, but nothing in this checkout writes `switched`: evidence from today's `record-day` composes to `release-changed`, and a window that passed evidence would still stop at `unrecorded-lanes-unknown`. An unreadable store is `unknown` (exit 1), not success.

`fleet-v2 daemon pause` exists as its own command.

`merge export` and `merge export --legacy` are not commands: `fleet-v2 merge export` exits 2. Plan §3.4 step 5 has no CLI yet. Do not invent flags. Merges already made stay made.

## Retirement

`cutover retire` is mounted. It requires `--expected-revision` and `--operation-id`, with optional `--now-iso` and `--deadline-iso`. A bare `cutover retire` exits 2. With no stored `switched` record it refuses `not-switched` (exit 1) and writes no journal. After the 14-day rollback window it saves `retired` and lifts a train pause the cutover itself set.

`LegacyTrainStateReadAdapter` stays while shadow report and merge import read the shell state directory.

`hosts daemon uninstall --scheduler systemd` removes fleet-v2 units only, and only with `--apply`. It does not remove a shell timer and it does not archive shell state.

Deleting `tools/fleet-v2-orchestrator/` is a change in the other repository, not a command here.

## Not this runbook

Removing adapters, adding `merge export`, starting `conductor run --live`, printing secrets, treating exit 1 `unknown` as an empty shadow, or starting, scheduling, or arming the live shadow daemon (OD-7).
