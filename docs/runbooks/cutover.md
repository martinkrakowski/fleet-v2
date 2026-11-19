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
- `fleet-v2 cutover shadow attest --fact <id> --note <text> --expected-revision <n> --operation-id <id> --authority <label> [--evidence <text>] [--deadline-iso <iso>]` (AT1) records one owner-attested one-time fact into `<stateDir>/cutover-shadow-attestations.json` by compare-and-set at `--expected-revision` (0 when nothing is stored yet), keyed `cutover/attest@<operationId>` in `cutover-journal.json` with the intent durable before the write and one final result after. The three facts and what they mean:
  - `s2-forge-error-backoff` — the owner attests that S2's forge error-backoff behaviour was observed (the forge error path backs off and does not hammer the forge).
  - `s2-canary-parks` — the owner attests that S2's canary park behaviour was observed (a canary lane parks for its park reason instead of failing the day).
  - `s3-wake-after-outage` — the owner attests that S3's wake-after-outage behaviour was observed (the daemon wakes and resumes cleanly after an outage).
  - `--authority` is only a non-empty label hashed into the record's digest — it is not an owner-only gate (`switch`, `rollback` and `retire` take none); the owner runs this command. A missing or blank label is refused `authority-required` (exit 1).
  - `note`, `evidence` and `authority` are hashed into the canonical digest and never stored in `cutover-shadow-attestations.json` or `cutover-journal.json`.
  - Facts are sticky with no revoke: the first attestation of a fact is kept, a later one for the same fact is a no-op, and nothing removes one. A fact must be attested on or before the shadow day it should count for (`observedDay <= evaluationDay`); `observedDay` and the timestamp come from the daemon clock — there is no `--now-iso`, so a fact cannot be backdated.
  - A replay with the same `--operation-id` and payload returns the stored record without writing; a replay with a different payload (including a different `--expected-revision`) is refused `operation-id-conflict`, and a replay after a refused result is refused `journal-refused` — a retry needs a new `--operation-id`. A stale `--expected-revision` is refused `revision-conflict` (exit 1) and writes nothing. `attested` and `unchanged` exit 0; every other outcome exits 1; malformed flags exit 2. Without a durable `--state-dir` it refuses `state-dir-required` (exit 1).
- `fleet-v2 merge import --repository <owner>/<repo> --legacy-state-dir <path> [--apply --grant <id> --project <id>]` is a dry-run unless `--apply` is paired with both `--grant <id>` and `--project <id>`. `--apply` verifies the standing `merge:import-shadow` grant through the authorization port BEFORE any legacy read, queue read, queue write or journal write, journals each non-empty apply into the separate `<stateDir>/shadow-intake-journal.json` (an intent before the queue writes, one final `applied` result after; never into `cutover-journal.json`), and refuses with exit 1 on any grant refusal (`grant-missing`, `grant-expired`, `grant-revoked`, `grant-wrong-scope`, `grant-wrong-repository`, `grant-wrong-project`, `grant-digest-mismatch`, `grant-not-approved`, `grant-id-mismatch`), `authorization-unavailable`, `journal-unavailable` or `journal-refused`. `--authority` is removed: it is a CLI usage error (exit 2), with or without `--apply`, and `--apply` without `--grant`/`--project` is also a usage error (exit 2). `grantId` is a non-secret handle and may be printed.
- `fleet-v2 state check` and `fleet-v2 daemon status` are read-only.
- `fleet-v2 conductor status` is the status read.

### Standing `merge:import-shadow` grants (GR1a2)

The unattended timer's standing grant is recorded, resolved and revoked through `coordination`:

- Create one with `fleet-v2 coordination request-decision --kind action-decision --action-scope merge:import-shadow --project-id <id> --proposal-digest <digest> --policy-revision <rev> --repository <owner>/<repo> --expires-at-iso <iso>`. The CLI derives the request id — `shadow-import-<sha256 of { scope, owner, repo, expiresAtIso }>` — from those coordinates, so a hand-typed `--request-id` that does not match is refused (exit 2) instead of recorded. The grant is head-free: no `--expected-head-sha` is taken. The grant's moment is the composition root's clock alone; a request-supplied `nowIso` is ignored.
- Resolve one with `coordination resolve-auth --project-id <id> --action-scope merge:import-shadow --authorization-grant-id <grantId> --repository <owner>/<repo>`. The resolve re-checks the digest of the stored coordinates and the expiry against the server clock on every call, and never names a commit.
- Revoke one with `fleet-v2 coordination revoke-grant --grant-id <grantId>`. The result is typed (`revoked` with the `grantId`, or `refused` with a reason such as `grant-missing`, `grant-wrong-scope` or `grant-already-revoked`); the grant id is a non-secret handle and may be printed, while secret-shaped values never are.

To issue a fresh grant after a revocation, record different coordinates — for example a different `--expires-at-iso` — because identical coordinates hash to the already-recorded request id.

### Release grants (RR1)

A release grant (`release:install`, `release:swap`, `release:rollback`) is bound to the release root it names:

- Create one with `fleet-v2 coordination request-decision --kind action-decision --action-scope release:install|release:swap --project-id <id> --expected-head-sha <sha> --proposal-digest <digest> --policy-revision <rev> --release-root <path>`. `--release-root` is required for every `release:*` scope and refused for all other scopes. It is normalized via `realpath` (symlinks resolved; a path that does not resolve to an existing directory is a usage error, exit 2, never echoing the path) and bound into the request id: `release-grant-<sha256 of { scope, projectId, expectedHeadSha, releaseRoot, nonce }>` (the CLI generates the per-request nonce; a repeat request with the same coordinates is a new record, not a replay). A hand-typed `--request-id` that does not match the derived one is refused (exit 2) instead of recorded. The owner's Ed25519 decision signature covers `{ requestId, projectId, actionScope, expectedHeadSha, decisionRevision, grantId, state }` and not `releaseRoot` itself — the root is covered because the signed `requestId` is its digest.
- Resolve one with `coordination resolve-auth --project-id <id> --action-scope release:<action> --expected-head-sha <sha> --release-root <path>` (or through `fleet-v2 release install|swap|rollback`, which forwards the realpath-resolved root). The resolve re-checks the digest of the stored coordinates on every call: a record whose id does not carry the `release-grant-` prefix (a pre-RR1 unsigned root) fails closed, and a mismatched or tampered root is refused `release-grant-digest-mismatch`. A grant bound to one root never authorizes an operation on another (`release-grant-root-mismatch`).

  The release root named in the grant (`--release-root`) is the same path the operation runs on: `fleet-v2 release install --root <path>` and `fleet-v2 release swap --root <path>` each take `--root <path>`, and that path is realpath-normalized the same way before use, so it must match the grant's `--release-root` (their digests must be equal). A `--root` that normalizes to a different directory — a different checkout, a moved tree, or a symlink resolving elsewhere — does not satisfy the grant and is refused before any mutation.
- The consumption re-checks the same digest before the idempotent replay return, so a moved root is refused even when a receipt already exists.

Status does not evaluate S1–S12. A completed status is not a shadow pass. Do not start `conductor run --live` from this runbook.

### Arming the scheduled record-day (OD7a2)

In scheduled mode (`--scheduled`, the flag the rendered `fleet-v2-shadow-record-day.timer` passes), `cutover shadow record-day` fails closed and writes NOTHING before any of these hold: the standing `merge:import-shadow` grant does not provably cover the whole UTC day, the day's first `job` tick lands after `00:15Z` (or only non-`job` events precede it), the day has fewer than 720 in-day ticks, or S12 cannot decide. A held guard prints one line `record-day skipped <reason>` (`partial-day`, `too-few-ticks`, `late-last-tick`, `coverage-gap`, `grant-unavailable`, `grant-not-covering-day`) and exits 0; an unreadable daemon-events projection or an `unknown` S12 — including `daemon-events-corrupt`, a dropped (corrupt) `events.jsonl` line bracketed inside the day's parsed records — exits 1. Do not pause the daemon during an evidence day: a pause longer than the gap limit makes the day unrecordable. `late-last-tick` means the day's last in-daemon tick landed more than 15 minutes before `24:00Z`; `coverage-gap` means two neighbouring in-day ticks (or a day boundary and a tick) are more than 15 minutes apart — paused ticks emit `jobs: []`, so a long pause shows up as one of these two skips rather than as a recorded `fail`. This is what keeps the arming day from recording a sticky `too-few-ticks` failure or mixing pre-arming shell merges into S1.

The complete arming sequence, in order:

1. **Stop the conductor before the release swap**: inspect active runs with `fleet-v2 conductor status`, halt with `fleet-v2 conductor halt`, and stop any active run with `fleet-v2 conductor stop <runId>`.
2. **Install and swap the release**:
   - `fleet-v2 release install --root <path> --sha <40 hex> --source <path> --apply --project <id>`
   - `fleet-v2 release swap --root <path> --sha <40 hex> --apply --project <id>`
3. **Request, pre-sign, and resolve the standing `merge:import-shadow` grant**:
   - Pre-sign (the owner signs the standing grant's answer file from its coordinates, BEFORE `request-decision` records the awaiting request): `fleet-v2 coordination sign-decision --pre-sign --action-scope merge:import-shadow --repository <owner/repo> --project <id> --expires-at <iso> --key <path> --yes`.
   - Request: `fleet-v2 coordination request-decision --kind action-decision --action-scope merge:import-shadow --project-id <id> --proposal-digest <digest> --policy-revision <rev> --repository <owner>/<repo> --expires-at-iso <iso>` (prints `<requestId>` = `shadow-import-<sha256>`; it MUST use the IDENTICAL `--expires-at-iso` ISO string the pre-sign step used, because the request id is the digest of those coordinates).
   - Resolve: `fleet-v2 coordination resolve-auth --project-id <id> --action-scope merge:import-shadow --authorization-grant-id <grantId> --repository <owner>/<repo>` (must resolve `authorized` **before** enabling `fleet-v2-daemon.timer`).

   To revoke a pre-signed grant before `request-decision` has recorded its awaiting request, delete its answer file (`<stateDir>/decisions/<requestId>.json`); the recorded awaiting request is then never approved.
4. **Install and enable the systemd user units and linger (only AFTER the grant resolves approved)**:
   - `fleet-v2 hosts daemon install --scheduler systemd --apply`
   - `loginctl enable-linger`
   - `systemctl --user enable --now fleet-v2-daemon.timer fleet-v2-shadow-intake.timer fleet-v2-shadow-record-day.timer`
5. **First recordable day rule**: the first recordable shadow day is the **first full UTC day after arming** whose entire `[00:00Z, 24:00Z)` window is covered by the approved, unrevoked, unexpired `merge:import-shadow` grant. On the arming day itself, either the grant was approved after `00:00Z`, the first `job` tick falls after `00:15Z`, or `totalTicks < 720`, so `cutover shadow record-day --scheduled` prints `record-day skipped <reason>`, writes nothing, and exits 0, preventing a sticky `S12` failure or mixed pre-arming `S1` merges.

When turning shadow off, disable `fleet-v2-shadow-record-day.timer` alongside `fleet-v2-shadow-intake.timer` (the rendered pair is removed by `hosts daemon uninstall --scheduler systemd --apply`).

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

## Owner key pinning and rotation

The installation file pins the owner's Ed25519 public key in the optional `owner`
section: `owner.publicKey` is the canonical base64 encoding of exactly 32 raw key
bytes. The parser (`packages/installation/src/owner.ts`) refuses non-strings,
over-long values, anything carrying a private-key or credential shape, and any
string that is not canonical base64 of 32 bytes; it never echoes the offending
value. A raw Ed25519 seed is also 32 bytes, so the screen cannot distinguish a
seed from a public key — never paste a seed there. A file that pins
`owner.publicKey` and also carries `waves.ownerPublicKey` is refused unless the
two agree, so a file cannot name two different owner keys.

### Moving the installation file out of every checkout

`loadInstallation` refuses to return a pinned `owner.publicKey` from an
installation file that lies inside a git checkout or worktree — including the
repository's own `<repo>/installation/fleet.json`, because the repo checkout is
exactly where local agents work — or inside any `hosts.*.worktreeRoot`, or
carried by a symlink, a non-regular file, a file the process uid does not own,
or a group/other-writable file (`owner-key-installation-untrusted`). Arming
step: move the installation file out of every checkout to
`~/.config/fleet-v2/fleet.json` (`0600` in a `0700` directory) and point
`FLEET_INSTALLATION_FILE` at that path in the CLI shell profile and in the
systemd user `EnvironmentFile` drop-in shared by the daemon, train, and
conductor units. One line of warning: a git-tracked `$HOME` (or `~/.config`)
defeats this move remedy, so keep `~/.config/fleet-v2` outside any repository.

### Pinning and rotating the key

Pin `owner.publicKey` by editing the installation file directly — no `hosts`
or `policy` subcommand writes the `owner` section — with the canonical base64
encoding of the 32-byte raw Ed25519 public key. A raw Ed25519 seed is also
32 bytes, so the secret screen cannot distinguish a seed from a public key:
never paste a seed. `waves.ownerPublicKey` is non-authoritative; it is
accepted only when it equals `owner.publicKey`.

Rotate by replacing `owner.publicKey` in the installation file, and restarting the
API and the daemon so the new key is what every consumer reads. Pending decisions
signed under the old key will fail verification and must be re-requested.
Rotation is a file edit plus a restart, not a command.

### The same-uid limit

`~/.config/fleet-v2/fleet.json` (`0600`, in a `0700` directory) keeps remote
lanes and repo-checkout agents from writing the installation file or the
pinned key via the worktree check. It does not keep a local process safe: any
process running as the owner's uid can still read and write these files. The
follow-up that closes this is to run local agents under a separate system
user.

## Not this runbook

Removing adapters, adding `merge export`, starting `conductor run --live`, printing secrets, treating exit 1 `unknown` as an empty shadow, or starting, scheduling, or arming the live shadow daemon (OD-7).
