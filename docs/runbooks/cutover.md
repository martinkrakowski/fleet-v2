# Runbook: cutover

*Date: 2026-11-18 · Status: operator runbook for this checkout. `cutover switch` and `cutover retire` are mounted. `countUnrecordedLanes` is wired (CO30c), so a real `switched` record is reachable when every gate passes.*

This runbook covers the cutover commands that exist in this checkout. `cutover switch` and `cutover retire` are mounted in `apps/cli/src/commands/cutover.ts`. Switch reads `<stateDir>/cutover-shadow.json` and, with `countUnrecordedLanes` wired (CO30c), completes a `switched` record when all gates pass. Retire writes a retired record only after a stored `switched` record and the 14-day window. Nothing here removes an adapter.

## Shadow

The shadow record requires 1 all-pass shadow day (`CUTOVER_SHADOW_CONSECUTIVE_DAYS`, owner decision 2026-11-17) and at least 20 merged PRs on that day (`CUTOVER_SHADOW_MIN_MERGES`).

S5' (premerge carry replay): per the 2026-11-18 owner decision, S5' compares only the carry decisions fleet-v2 can resolve. The `premergeCarry` resolver is pinned to `'unknown'` in `apps/cli/src/composition.ts` until the post-cutover `PatchIdentityPort` resolver is wired, so while that pin stands S5' compares nothing and is a constant pass with `compared: 0` on any day with a complete, paired shell log. Decisions the resolver leaves `unknown` never fail the day: they are listed in the non-digested diagnostics (`unresolvedCount` and the bounded, sorted `unresolvedIds`, capped at `SHADOW_CARRY_MAX_UNRESOLVED_IDS`) printed by `cutover shadow record-day`. Any resolvable lax carry (or stricter no-carry) still fails the day. Ledger facts: (a) `compared` counts resolved decisions only, so it is resolver-dependent — deterministic `0` while pinned to `'unknown'`, and a real resolver answering differently on a rerun changes the digest, so `verdict-conflict` refuses that day; earlier S5' digests recorded before 2026-11-18 are not comparable; (b) a lax carry is missed whenever its decision is unresolved, including on a transient resolver throw — by design; (c) while pinned to `'unknown'`, S5' compares nothing and is a constant pass on any day with a complete, paired shell log (owner-accepted, 2026-11-18).

Commands that exist today:

- `fleet-v2 cutover status` is read-only. With no cutover record it exits 0 with `outcome` `completed`, `state` `shadow`, `revision` 0, and `record` null. `withinRollbackWindow` is null when the record is missing or `switchedAtIso` is null.
- `fleet-v2 cutover shadow report --repository <owner>/<repo> --legacy-state-dir <path>` counts the shell side's queue, parked and in-progress lines, and keys fleet entries by their own recorded base branch rather than assuming `main`. It still compares enqueue sets only, writes nothing, and is still not an S1–S12 verdict. A complete comparison with divergent enqueue sets returns `outcome` `completed` with `equal` false and exits 0, so the exit code alone never signals a divergence — check `equal` and `complete`. Exit 1 means the report is not a pass: `outcome` `unknown` (`shell-state-incomplete`, including a missing `inprogress` in the port's answer), or `refused` (`shell-queue-absent`, `shell-queue-unreadable`, `secret-shaped`), or `complete` false.
- `fleet-v2 cutover shadow record-day --repository <owner>/<repo> --legacy-state-dir <path> [--day YYYY-MM-DD]` (SH8a) records one UTC day into `<stateDir>/cutover-shadow.json`. Those days are what `cutover switch` reads. `record-day` derives each day's `releaseSha` from the installed `current` verified release under the release root parsed from the configured `daemon.cliPath` (SH20), returning `null` — and `release-unpinned` for S2/S10/S11 — when that path is unconfigured, not a served release path, or the installed release is missing, unverified, or unreadable. When the lane-run store holds more than 1,500 runs (`SHADOW_FACTS_WARN_RUNS`, owner decision 2026-11-18; the 2,000-run cap `SHADOW_FACTS_MAX_RUNS` is deferred), `record-day` prints an early warning to `stderr` without changing the outcome, the exit code, or writing anything.
- `fleet-v2 merge import --repository <owner>/<repo> --legacy-state-dir <path>` is a dry-run unless `--apply` is paired with `--authority`.
- `fleet-v2 state check` and `fleet-v2 daemon status` are read-only.
- `fleet-v2 conductor status` is the status read.

Status does not evaluate S1–S12. A completed status is not a shadow pass. Do not start `conductor run --live` from this runbook.

## Switch preconditions

`cutover switch` is mounted. It requires `--expected-revision`, `--operation-id`, and `--relaunch-plan-digest` (64 lowercase hex), with optional `--now-iso` and `--deadline-iso`. A bare `fleet-v2 cutover switch` exits 2 as a usage error. It does not print `move-not-implemented`.

`cutover switch` reads `<stateDir>/cutover-shadow.json` via `composeCutoverShadowEvidence`: the newest UTC day — 1 all-pass day with at least 20 merges and a non-null `releaseSha` (owner decision 2026-11-17) — all S1–S12 recorded as `pass`. `cutover shadow record-day` (SH8a) produces the day this reads. The composer's staleness check uses the daemon clock (`daemon.now()`). It never takes the operator's `--now-iso`. `--now-iso` is the clock the criterion reader uses for its future-day check.

`cutover switch` cannot pass evidence while the recorded day is unpinned. Since SH20, `record-day` binds the recorded day to the installed `current` verified release sha (or `null` when unpinned, which still composes to `release-changed` / `shadow-evidence-absent`): a day recorded with no verified `current` release installed keeps the recorded window at `release-changed`, and the switch refuses `shadow-evidence-absent`.

A window that passes the evidence gate then runs the last closed gate, `countUnrecordedLanes` (CO30c), wired in `apps/cli/src/composition.ts` over the read-only relaunch inventory and the read-only project-profile listing. Gate order: shadow evidence, lanes, daemon status, train pause. The gate:

- refuses `unrecorded-lanes` when any listed worktree of an active profile's clone is unrecorded — idle leftovers included (relaunch apply/adopt does not exist yet, so every unrecorded worktree is lane work nothing explains). Remove leftover worktrees from the clone's `worktreeRoot` (with `git worktree remove`) before running `cutover switch`.
- refuses `unknown` / `unrecorded-lanes-unknown` when the listed worktrees outnumber the lanes the inventory accounted for beyond each clone's own main worktree: a worktree listed outside the clone's declared `worktreeRoot` is silently dropped by the inventory, so the switch is never performed on an inventory that cannot vouch for what it did not see.
- refuses `conductor-driver-live` while the driver lease is live: a driver is still active on the installation, so the switch does not proceed under it. (The `conductor-halted` flag is different: it is read from the halt marker, which means the conductor is halted — a pause state, not an active driver — so it does not refuse this gate; an unreadable halt marker is already `unknown`.) An unreadable or unknown driver-lease state refuses as `unknown` / `unrecorded-lanes-unknown`.
- answers `unknown` / `unrecorded-lanes-unknown` when lane coverage cannot be read: zero active project profiles (a missing `project-profiles.json` reads as empty and never passes 0/0), an unreadable `project-profiles.json`, `lane-runs.json`, `attempts.json`, `conductor-halt.json` or `conductor-driver-lease.json`, a clone whose host is absent from the installation (`unknown-worktree-read`), a failed worktree listing (`unknown-worktree-read`), or a failed runner read or unavailable runner (`unknown-runner-state`).
- never refuses on `unproven-lane-records`: an unproven record is listed in `relaunch inventory` output and counted there, but it does not block the switch.

The gate reads only read-only store instances, so a corrupt store file is answered `unreadable` and never quarantined, and a refused or `unknown` switch writes no `cutover.json` and no `cutover-journal.json`. When every gate passes, the switch appends its intent, sets the train pause, saves the `switched` record and appends its result — a real `switched` record is reachable.

Fail closed, and never treat an unknown or partial ledger as a pass:

- No durable state directory, or no `cutover-shadow.json`: `shadow-evidence-absent` (exit 1), naming every criterion S1–S12.
- Fewer than 1 day, a stale newest day (more than one UTC day before the daemon clock), or a null `releaseSha`: `shadow-evidence-absent` (exit 1), naming every criterion.
- A newest day after `--now-iso`, fewer than 20 merges on the required shadow day, or any S1–S12 recorded `fail` or missing: `shadow-criteria-failed` (exit 1), naming the failed criteria (every criterion when the window shape or the merge floor fails).
- Unreadable, malformed, null, or corrupt `cutover-shadow.json`, including a verdict other than `pass` or `fail`, or duplicate or non-array days: `unknown` / `shadow-evidence-unreadable` (exit 1). This is not absence.
- A newer `schemaVersion`: `unknown` / `shadow-evidence-unknown-version` (exit 1). This is not absence.
- A deadline already past: `unknown` / `deadline-exceeded` (exit 1).

Three residuals, owner-accepted 2026-11-17 and NOT fixed by this unit (CO30c). Do not work around them here:

- Release vs installed at switch time: release binding is weakened — with 1 all-pass day (owner decision 2026-11-17) it means only that the newest day's `releaseSha` is non-null, and `release-changed` now means unpinned (narrowed by SH20: each day's `releaseSha` is derived from the installed `current` verified release at `record-day` time). Nothing compares that recorded sha to the installed `current` release again at `cutover switch` time, so a release installed after the last day is not re-checked.
- Digest re-verify/version: verdict digests are not re-verified, and there is no evaluator or digest-format version, so an older-format or hand-edited day is not detected. Only shape, freshness, and the gates stand behind a passing window.
- One-sided freshness: real behaviour (fix dated 2026-11-17): `isStale` rejects only days older than the daemon clock, and the future-day check uses the operator's `--now-iso`. There is no reverse freshness signal (nothing proves the ledger was read against the state a relaunch plan was built from); the switch relies on shape, the gates, and those two checks only.

For clarity: "pinned" throughout this runbook means the installed `current` verified release under the release root parsed from the configured `daemon.cliPath` — the release `record-day` binds each day to and the one S2/S10/S11 inspect.

Checks the operator can run today, each of which is not itself a completed switch:

- `cutover status` — an `unknown` outcome is exit 1, not a go.
- `cutover shadow report` — only when `outcome` is `completed`, `equal` is true, and `complete` is true.
- `merge import` without `--apply`.
- `state check`.
- Before the first `release install`: create the release root directory yourself — the install never creates it, and a missing root is refused (`release-root-missing`). The installation's `daemon.cliPath` must be `<root>/current/apps/cli/dist/bin.js`, and the `--root` you pass must resolve to that same root.
- `release install` without `--apply` — it writes nothing; `--apply` is deployment authority and still does not record a cutover switch.
- `hosts daemon install --scheduler systemd` without `--apply` — it prints `would-write` and the enable and linger lines, and does not run them.
- `relaunch inventory` is the only relaunch command. `relaunch plan` and `relaunch apply` are not commands (exit 2).

## Rollback

The rollback window is 14 days (`CUTOVER_ROLLBACK_WINDOW_DAYS`).

`fleet-v2 cutover rollback --expected-revision <n> --operation-id <id>` exists, with optional `--now-iso` and `--deadline-iso`. It pauses the daemon and lifts only a train pause the cutover itself set, and it requires a stored `switched` record. A record that was never switched is refused `not-switched` (exit 1). `cutover switch` is mounted and, with `countUnrecordedLanes` wired (CO30c), can write `switched` when the evidence gate, the lanes gate, the daemon gate and the train-pause gate all pass. An unreadable store is `unknown` (exit 1), not success.

`fleet-v2 daemon pause` exists as its own command.

`merge export` and `merge export --legacy` are not commands: `fleet-v2 merge export` exits 2. Plan §3.4 step 5 has no CLI yet. Do not invent flags. Merges already made stay made.

## Retirement

`cutover retire` is mounted. It requires `--expected-revision` and `--operation-id`, with optional `--now-iso` and `--deadline-iso`. A bare `cutover retire` exits 2. With no stored `switched` record it refuses `not-switched` (exit 1) and writes no journal. After the 14-day rollback window it saves `retired` and lifts a train pause the cutover itself set.

S13 (every §1 cutover-plan ledger row has an evidence link / `verified`) moved from the shadow switch window to this retirement gate per owner decision 2026-11-18: `cutover switch` reads S1–S12 only, and the §1-ledger verification in `cutover retire` is a deferred follow-up unit (`TODO(retirement-ledger)` in `ManageCutoverUseCase`).

`LegacyTrainStateReadAdapter` stays while shadow report and merge import read the shell state directory.

`hosts daemon uninstall --scheduler systemd` removes fleet-v2 units only, and only with `--apply`. It does not remove a shell timer and it does not archive shell state.

Deleting `tools/fleet-v2-orchestrator/` is a change in the other repository, not a command here.

## Not this runbook

Removing adapters, adding `merge export`, starting `conductor run --live`, printing secrets, treating exit 1 `unknown` as an empty shadow, or starting, scheduling, or arming the live shadow daemon (OD-7).
